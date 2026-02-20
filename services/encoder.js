/**
 * services/encoder.js — Video encoding engine (v2)
 *
 * Queue-based multi-worker encoder with GPU allocation,
 * progress tracking, SSE event broadcast, and robust
 * ffmpeg invocation inspired by av1encoder.sh.
 *
 * Key improvements over v1:
 *  - GPU decode fallback to CPU decode on hwaccel failure
 *  - No -hwaccel_output_format cuda (avoids auto_scale errors)
 *  - CUDA_VISIBLE_DEVICES instead of -gpu (more reliable)
 *  - HDR/10-bit detection and color metadata preservation
 *  - Dolby Vision detection (skip to avoid losing DV metadata)
 *  - Bad subtitle stream filtering for MKV muxing
 *  - Output validation (codec, duration, file size checks)
 *  - Full stream mapping (metadata, chapters, attachments)
 *  - Encoder capability probing (tune, spatial_aq, rc modes)
 *  - Proper rate control per encoder (constqp for AV1, vbr_hq for HEVC)
 *  - MKV container for AV1 (better stream compatibility)
 *  - Per-job log files for post-mortem debugging
 *  - Job crash recovery on startup
 */
'use strict';

const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const db = require('../db');
const gpuDetect = require('./gpu-detect');
const logger = require('./logger');

const execFileAsync = promisify(execFile);

const ENCODE_DIR = process.env.ENCODE_DIR || path.join(__dirname, '..', 'data', 'encoded');
const LOG_DIR = path.join(__dirname, '..', 'data', 'logs');
const MAX_WORKERS = parseInt(process.env.MAX_WORKERS || '2', 10);

/* ─── SSE event bus ──────────────────────────────────────────── */
const sseClients = new Set();
function addSSEClient(res) { sseClients.add(res); res.on('close', () => sseClients.delete(res)); }
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) { try { c.write(msg); } catch { sseClients.delete(c); } }
}

/* ─── Device tracker (prevent GPU double-use) ────────────────── */
const deviceLocks = new Map();
function lockDevice(devKey) { deviceLocks.set(devKey, (deviceLocks.get(devKey) || 0) + 1); }
function unlockDevice(devKey) {
  const n = (deviceLocks.get(devKey) || 1) - 1;
  if (n <= 0) deviceLocks.delete(devKey); else deviceLocks.set(devKey, n);
}
function deviceLoad(devKey) { return deviceLocks.get(devKey) || 0; }

/* ─── Queue state ────────────────────────────────────────────── */
const active = new Map();     // jobId -> { proc, video_id, cancel }
let running = true;
let workerCount = MAX_WORKERS;
let _processing = false;
let _processingTs = 0;          // timestamp when _processing was set
const PROCESSING_TIMEOUT = 30000; // 30s safety valve
let _watchdogTimer = null;

/* ─── Encoder capability cache ───────────────────────────────── */
const encoderCaps = new Map();

async function probeEncoderCaps(encoderName) {
  if (encoderCaps.has(encoderName)) return encoderCaps.get(encoderName);
  const caps = {
    tune: false, spatial_aq: false, aq_strength: false,
    rc: false, cq: false, qp: false, profile: false,
  };
  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-hide_banner', '-h', `encoder=${encoderName}`], { timeout: 10000 });
    const check = (opt) => new RegExp(`(^|\\s)-${opt}(\\s|$)`, 'm').test(stdout);
    caps.tune = check('tune');
    caps.spatial_aq = check('spatial_aq');
    caps.aq_strength = check('aq-strength');
    caps.rc = check('rc');
    caps.cq = check('cq');
    caps.qp = check('qp');
    caps.profile = check('profile');
  } catch (e) {
    logger.warn('encoder', `Could not probe caps for ${encoderName}: ${e.message}`);
  }
  encoderCaps.set(encoderName, caps);
  logger.debug('encoder', `Encoder caps for ${encoderName}`, caps);
  return caps;
}

/* ─── ffprobe helpers (ported from av1encoder.sh) ────────────── */

async function ffprobeValue(filePath, streamSelect, entries) {
  try {
    const args = ['-v', 'error'];
    if (streamSelect) args.push('-select_streams', streamSelect);
    args.push('-show_entries', entries, '-of', 'default=nw=1:nk=1', '--', filePath);
    const { stdout } = await execFileAsync('ffprobe', args, { timeout: 30000 });
    return stdout.trim().split('\n')[0] || '';
  } catch { return ''; }
}

async function ffprobeFirstVideoCodec(filePath) {
  return ffprobeValue(filePath, 'v:0', 'stream=codec_name');
}

async function ffprobeColorMeta(filePath) {
  const [transfer, primaries, space, range] = await Promise.all([
    ffprobeValue(filePath, 'v:0', 'stream=color_transfer'),
    ffprobeValue(filePath, 'v:0', 'stream=color_primaries'),
    ffprobeValue(filePath, 'v:0', 'stream=color_space'),
    ffprobeValue(filePath, 'v:0', 'stream=color_range'),
  ]);
  return { transfer, primaries, space, range };
}

async function ffprobeBitDepth(filePath) {
  let b = await ffprobeValue(filePath, 'v:0', 'stream=bits_per_raw_sample');
  if (b && b !== 'N/A' && b !== '0') return parseInt(b, 10);
  const pf = await ffprobeValue(filePath, 'v:0', 'stream=pix_fmt');
  if (/10|p010|p10/.test(pf)) return 10;
  if (/12|p012|p12/.test(pf)) return 12;
  return 8;
}

async function ffprobeSideDataTypes(filePath) {
  try {
    const args = ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream_side_data=side_data_type',
      '-of', 'default=nw=1:nk=1', '--', filePath];
    const { stdout } = await execFileAsync('ffprobe', args, { timeout: 15000 });
    return stdout.trim();
  } catch { return ''; }
}

async function ffprobeDuration(filePath) {
  const d = await ffprobeValue(filePath, null, 'format=duration');
  if (!d || d === 'N/A') return 0;
  return parseFloat(d) || 0;
}

async function ffprobeBadSubtitleIndices(filePath) {
  try {
    const args = ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name',
      '-of', 'csv=p=0', '--', filePath];
    const { stdout } = await execFileAsync('ffprobe', args, { timeout: 15000 });
    const bad = [];
    for (const line of stdout.trim().split('\n')) {
      if (!line) continue;
      const parts = line.split(',');
      if (parts[1] === 'subtitle') {
        const codec = (parts[2] || '').toLowerCase();
        if (!codec || codec === 'unknown' || codec === 'webvtt' || codec === 'none' || codec === 'n/a') {
          bad.push(parts[0]);
        }
      }
    }
    return bad;
  } catch { return []; }
}

async function ffprobeFullInfo(filePath) {
  try {
    const args = ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', '--', filePath];
    const { stdout } = await execFileAsync('ffprobe', args, { timeout: 30000 });
    return JSON.parse(stdout);
  } catch { return null; }
}

/* ─── Build ffmpeg args (v2 — inspired by av1encoder.sh) ─────── */

function buildArgsV2(preset, inFile, outFile, probeInfo) {
  const { colorMeta, bitDepth, isHdr, caps: encCaps, badSubIndices } = probeInfo;

  const isAv1 = preset.codec === 'av1';
  const isMkv = isAv1;
  const container = isMkv ? 'matroska' : 'mp4';
  const pixFmt = (bitDepth >= 10 || isHdr) ? 'p010le' : 'yuv420p';

  const tail = [];

  // Map all streams, drop bad subtitle streams
  tail.push('-map', '0');
  for (const idx of badSubIndices) {
    tail.push('-map', `-0:${idx}`);
  }
  tail.push('-map_metadata', '0', '-map_chapters', '0');

  // Video: encode first video stream
  tail.push('-c:v:0', preset.encoder);

  // Preset (NVENC p1-p7 or named presets — CPU presets are set in rate control block)
  const nvencPreset = preset.nvencPreset || 'p6';
  if (preset.type === 'nvidia' || preset.type === 'nvidia_group') {
    tail.push('-preset', nvencPreset);
  } else if (preset.type === 'vaapi' || preset.type === 'vaapi_group') {
    // VA-API doesn't use -preset
  }

  // 10-bit profile when needed
  if (pixFmt === 'p010le' && encCaps.profile) {
    tail.push('-profile:v', 'main10');
  }

  // Tune (only for NVENC — libx265 does NOT support 'hq' tune)
  if (encCaps.tune && (preset.type === 'nvidia' || preset.type === 'nvidia_group')) {
    tail.push('-tune', preset.nvencTune || 'hq');
  }

  // Rate control — adapted per encoder type from av1encoder.sh
  const cq = preset.cq || (isAv1 ? 30 : 23);
  if (preset.type === 'nvidia' || preset.type === 'nvidia_group') {
    if (isAv1) {
      if (encCaps.rc && encCaps.qp) {
        tail.push('-rc', 'constqp', '-qp', String(cq));
      } else if (encCaps.rc && encCaps.cq) {
        tail.push('-rc', 'vbr', '-cq', String(cq));
      }
    } else {
      if (encCaps.rc && encCaps.cq) {
        tail.push('-rc', 'vbr_hq', '-cq', String(cq));
      } else if (encCaps.rc && encCaps.qp) {
        tail.push('-rc', 'constqp', '-qp', String(cq));
      }
    }
  } else if (preset.type === 'vaapi' || preset.type === 'vaapi_group') {
    tail.push('-rc_mode', 'CQP', '-global_quality', String(cq));
  } else if (preset.type === 'qsv') {
    tail.push('-global_quality', String(cq), '-preset', 'medium');
  } else {
    if (preset.encoder === 'libx265') tail.push('-crf', String(cq), '-preset', 'medium');
    else if (preset.encoder === 'libsvtav1') tail.push('-crf', String(cq), '-preset', '6');
    else if (preset.encoder === 'libaom-av1') tail.push('-crf', String(cq), '-cpu-used', '4');
  }

  // Pixel format
  tail.push('-pix_fmt', pixFmt);

  // Preserve color signaling
  const { transfer, primaries, space, range } = colorMeta;
  if (primaries && primaries !== 'unknown' && primaries !== 'N/A') tail.push('-color_primaries', primaries);
  if (transfer && transfer !== 'unknown' && transfer !== 'N/A') tail.push('-color_trc', transfer);
  if (space && space !== 'unknown' && space !== 'N/A') tail.push('-colorspace', space);
  if (range && range !== 'unknown' && range !== 'N/A') tail.push('-color_range', range);

  // Spatial AQ (NVENC quality improvement)
  if (encCaps.spatial_aq) tail.push('-spatial_aq', '1');
  if (encCaps.aq_strength) tail.push('-aq-strength', '8');

  // Timestamp preservation
  tail.push('-fps_mode', 'passthrough');

  // Audio/Subs/Data/Attachments: copy
  tail.push('-c:a', 'copy', '-c:s', 'copy', '-c:d', 'copy', '-c:t', 'copy');

  // Container-specific
  if (!isMkv) tail.push('-movflags', '+faststart');
  tail.push('-f', container, outFile);

  // Common head for all commands
  const commonHead = ['-hide_banner', '-nostdin', '-y', '-probesize', '50M', '-analyzeduration', '50M'];

  // Software decode command
  const swArgs = [...commonHead, '-i', inFile, '-progress', 'pipe:1', ...tail];

  // Hardware decode command (NVIDIA only — no -hwaccel_output_format cuda!)
  let hwArgs = null;
  if (preset.type === 'nvidia' || preset.type === 'nvidia_group') {
    hwArgs = [...commonHead,
      '-hwaccel', 'cuda', '-hwaccel_device', '0',
      '-i', inFile, '-progress', 'pipe:1', ...tail];
  }

  return { swArgs, hwArgs, container, pixFmt, isHdr };
}

/* ─── GPU selection helpers ──────────────────────────────────── */

function pickNvidiaGpu(preset) {
  const count = preset.gpuCount || 1;
  let best = 0, bestLoad = Infinity;
  for (let i = 0; i < count; i++) {
    const l = deviceLoad(`nvidia_${i}`);
    if (l < bestLoad) { best = i; bestLoad = l; }
  }
  return best;
}

function pickVaapiDevice(preset) {
  const count = preset.deviceCount || 1;
  let best = '/dev/dri/renderD128', bestLoad = Infinity;
  for (let i = 0; i < count; i++) {
    const d = `/dev/dri/renderD${128 + i}`;
    const l = deviceLoad(`vaapi_${d}`);
    if (l < bestLoad) { best = d; bestLoad = l; }
  }
  return best;
}

function devKeyFor(preset) {
  if (preset.type === 'nvidia') return `nvidia_${preset.gpuIndex ?? 0}`;
  if (preset.type === 'nvidia_group') return `nvidia_${pickNvidiaGpu(preset)}`;
  if (preset.type === 'vaapi') return `vaapi_${preset.renderDevice}`;
  if (preset.type === 'vaapi_group') return `vaapi_${pickVaapiDevice(preset)}`;
  if (preset.type === 'qsv') return 'qsv_0';
  return 'cpu';
}

function gpuIndexFor(preset) {
  if (preset.type === 'nvidia') return preset.gpuIndex ?? 0;
  if (preset.type === 'nvidia_group') return pickNvidiaGpu(preset);
  return 0;
}

/* ─── Safe cross-filesystem move ─────────────────────────────── */

async function moveFile(src, dst) {
  try { await fsp.rename(src, dst); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(src, dst);
    await fsp.unlink(src);
  }
}

/* ─── Per-job log file ───────────────────────────────────────── */

async function createJobLogger(jobId) {
  await fsp.mkdir(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `job_${jobId}.log`);
  const stream = fs.createWriteStream(logPath, { flags: 'a' });

  function write(level, msg) {
    const ts = new Date().toISOString();
    stream.write(`[${ts}] [${level}] ${msg}\n`);
  }

  return {
    info: (msg) => write('INFO', msg),
    warn: (msg) => write('WARN', msg),
    error: (msg) => write('ERROR', msg),
    writeRaw: (data) => stream.write(data),
    close: () => new Promise(resolve => stream.end(resolve)),
    path: logPath,
  };
}

/* ─── Output validation (ported from av1encoder.sh) ──────────── */

async function validateOutput(tmpFile, expectedCodec, inputDuration, jobLog) {
  const errors = [];

  // Check file exists and is non-empty
  try {
    const st = await fsp.stat(tmpFile);
    if (st.size === 0) { errors.push('Output file is empty (0 bytes)'); return errors; }
    jobLog.info(`Output file size: ${(st.size / 1e6).toFixed(1)} MB`);
  } catch {
    errors.push('Output file does not exist');
    return errors;
  }

  // Check output video codec
  const outCodec = await ffprobeValue(tmpFile, 'v:0', 'stream=codec_name');
  jobLog.info(`Output codec: ${outCodec} (expected: ${expectedCodec})`);
  if (!outCodec) {
    errors.push('ffprobe could not read output video codec');
  } else if (expectedCodec === 'av1' && outCodec !== 'av1') {
    errors.push(`Unexpected output codec: ${outCodec} (expected av1)`);
  } else if (expectedCodec === 'h265' && outCodec !== 'hevc') {
    errors.push(`Unexpected output codec: ${outCodec} (expected hevc)`);
  }

  // Check output duration
  const outDuration = await ffprobeDuration(tmpFile);
  jobLog.info(`Output duration: ${outDuration}s (input: ${inputDuration}s)`);
  if (!outDuration || outDuration <= 0) {
    errors.push(`Output duration invalid: ${outDuration}`);
  } else if (inputDuration > 0) {
    const ratio = outDuration / inputDuration;
    if (ratio < 0.90) {
      errors.push(`Output too short: ${outDuration.toFixed(1)}s vs input ${inputDuration.toFixed(1)}s (ratio: ${ratio.toFixed(2)})`);
    }
  }

  return errors;
}
/* ── Refresh video metadata after encode ─────────────────── */

async function refreshVideoMeta(videoId, filePath, jobLog) {
  try {
    const info = await ffprobeFullInfo(filePath);
    if (!info) { jobLog.warn('Could not re-probe output for metadata refresh'); return; }

    const vStream = (info.streams || []).find(s => s.codec_type === 'video');
    const aStream = (info.streams || []).find(s => s.codec_type === 'audio');
    const fmt = info.format || {};

    const meta = {
      duration: parseFloat(fmt.duration) || null,
      codec: vStream ? vStream.codec_name : null,
      width: vStream ? vStream.width : null,
      height: vStream ? vStream.height : null,
      bitrate: fmt.bit_rate ? Math.round(parseInt(fmt.bit_rate, 10) / 1000) : null,
      fps: null,
      audioCodec: aStream ? aStream.codec_name : null,
      audioSampleRate: aStream ? parseInt(aStream.sample_rate, 10) || null : null,
      audioChannels: aStream ? aStream.channels : null,
    };

    // Parse FPS from r_frame_rate (e.g. "24000/1001")
    if (vStream && vStream.r_frame_rate) {
      const parts = vStream.r_frame_rate.split('/');
      if (parts.length === 2 && parseInt(parts[1], 10) > 0) {
        meta.fps = parseFloat((parseInt(parts[0], 10) / parseInt(parts[1], 10)).toFixed(3));
      }
    }

    const pool = db.getPool();
    await pool.query(
      `UPDATE videos SET
         file_path         = ?,
         size              = ?,
         duration          = COALESCE(?, duration),
         codec             = COALESCE(?, codec),
         width             = COALESCE(?, width),
         height            = COALESCE(?, height),
         bitrate           = COALESCE(?, bitrate),
         fps               = COALESCE(?, fps),
         audio_codec       = COALESCE(?, audio_codec),
         audio_sample_rate = COALESCE(?, audio_sample_rate),
         audio_channels    = COALESCE(?, audio_channels),
         filename          = ?
       WHERE id = ?`,
      [
        filePath,
        (await fsp.stat(filePath).catch(() => ({ size: 0 }))).size,
        meta.duration, meta.codec, meta.width, meta.height, meta.bitrate,
        meta.fps, meta.audioCodec, meta.audioSampleRate, meta.audioChannels,
        path.basename(filePath),
        videoId,
      ]
    );

    jobLog.info(`Video #${videoId} metadata refreshed: codec=${meta.codec}, ${meta.width}x${meta.height}, ${meta.duration?.toFixed(1)}s, ${meta.bitrate}kbps`);
  } catch (e) {
    jobLog.warn(`Failed to refresh video metadata: ${e.message}`);
  }
}
/* ─── Core encode worker (v2) ────────────────────────────────── */

async function processJob(job) {
  const pool = db.getPool();
  const jobLog = await createJobLogger(job.id);

  // Parse preset early so we can unlock device in finally
  let preset;
  try { preset = JSON.parse(job.preset_json); }
  catch { preset = { encoder: 'libx265', codec: 'h265', type: 'cpu', id: 'cpu_h265' }; }

  let devKey = 'cpu';
  let tmpFile = null;

  try {
    jobLog.info(`=== Job #${job.id} started ===`);
    jobLog.info(`Video ID: ${job.video_id}, Preset: ${job.preset_id}`);

    const [[video]] = await pool.query('SELECT * FROM videos WHERE id=?', [job.video_id]);
    if (!video) {
      const err = 'Video not found in database';
      jobLog.error(err);
      await pool.query("UPDATE encode_jobs SET status='error', error=?, ended_at=NOW() WHERE id=?", [err, job.id]);
      broadcast('job_update', { id: job.id, status: 'error', error: err });
      return;
    }

    jobLog.info(`Input: ${video.file_path}`);
    jobLog.info(`Size: ${(video.size / 1e6).toFixed(1)} MB`);

    // Verify input accessible
    try {
      await fsp.access(video.file_path, fs.constants.R_OK);
    } catch {
      const err = `Input file not accessible: ${video.file_path}`;
      jobLog.error(err);
      await pool.query("UPDATE encode_jobs SET status='error', error=?, ended_at=NOW() WHERE id=?", [err, job.id]);
      broadcast('job_update', { id: job.id, status: 'error', error: err });
      return;
    }

    jobLog.info(`Preset: ${JSON.stringify(preset)}`);

    // ── Probe input file ──
    jobLog.info('--- Probing input ---');
    const [inputCodec, colorMeta, bitDepth, sideData, inputDuration, badSubIndices, fullInfo] =
      await Promise.all([
        ffprobeFirstVideoCodec(video.file_path),
        ffprobeColorMeta(video.file_path),
        ffprobeBitDepth(video.file_path),
        ffprobeSideDataTypes(video.file_path),
        ffprobeDuration(video.file_path),
        ffprobeBadSubtitleIndices(video.file_path),
        ffprobeFullInfo(video.file_path),
      ]);

    jobLog.info(`Input codec: ${inputCodec}`);
    jobLog.info(`Color: transfer=${colorMeta.transfer} primaries=${colorMeta.primaries} space=${colorMeta.space} range=${colorMeta.range}`);
    jobLog.info(`Bit depth: ${bitDepth}, Duration: ${inputDuration}s`);
    if (badSubIndices.length) jobLog.warn(`Bad subtitle streams to drop: ${badSubIndices.join(', ')}`);

    if (fullInfo) {
      const streams = (fullInfo.streams || []).map(s => ({
        idx: s.index, type: s.codec_type, codec: s.codec_name,
        w: s.width, h: s.height, pix: s.pix_fmt,
      }));
      jobLog.info(`Streams: ${JSON.stringify(streams)}`);
    }

    // Detect HDR
    let isHdr = false;
    if (['smpte2084', 'arib-std-b67'].includes(colorMeta.transfer)) isHdr = true;
    if (colorMeta.primaries === 'bt2020') isHdr = true;
    if (isHdr) jobLog.info('HDR content detected');

    // Dolby Vision check
    if (sideData && /dovi/i.test(sideData)) {
      const err = 'Dolby Vision detected — skipping to avoid losing DV metadata';
      jobLog.warn(err);
      await pool.query("UPDATE encode_jobs SET status='error', error=?, ended_at=NOW() WHERE id=?", [err, job.id]);
      broadcast('job_update', { id: job.id, status: 'error', error: err });
      return;
    }

    // ── Probe encoder capabilities ──
    const encCaps = await probeEncoderCaps(preset.encoder);
    jobLog.info(`Encoder caps (${preset.encoder}): ${JSON.stringify(encCaps)}`);

    // ── Build output path ──
    const inFile = video.file_path;
    const isAv1 = preset.codec === 'av1';
    const ext = isAv1 ? '.mkv' : '.mp4';
    const baseName = path.basename(inFile, path.extname(inFile));
    const replaceOriginal = !!job.replace_original;

    await fsp.mkdir(ENCODE_DIR, { recursive: true });
    const outFile = replaceOriginal
      ? path.join(ENCODE_DIR, `${baseName}_enc_${job.id}${ext}`)
      : path.join(ENCODE_DIR, `${baseName}_${preset.codec}${ext}`);
    tmpFile = `${outFile}.tmp.${job.id}${ext}`;

    jobLog.info(`Output: ${outFile}`);
    jobLog.info(`Temp: ${tmpFile}`);

    // ── Lock device & update status ──
    devKey = devKeyFor(preset);
    const gpuIdx = gpuIndexFor(preset);
    lockDevice(devKey);

    await pool.query(
      "UPDATE encode_jobs SET status='encoding', started_at=NOW(), file_size_before=? WHERE id=?",
      [video.size || 0, job.id]
    );
    broadcast('job_update', { id: job.id, status: 'encoding', video_id: job.video_id });

    // ── Build ffmpeg arguments ──
    const probeInfo = {
      inputCodec, colorMeta, bitDepth, isHdr,
      caps: encCaps, badSubIndices, inputDuration,
    };
    const { swArgs, hwArgs } = buildArgsV2(preset, inFile, tmpFile, probeInfo);

    jobLog.info(`--- ffmpeg commands ---`);
    jobLog.info(`SW: ffmpeg ${swArgs.join(' ')}`);
    if (hwArgs) jobLog.info(`HW: ffmpeg ${hwArgs.join(' ')}`);

    logger.info('encoder', `Job #${job.id} encoding: ${video.filename} → ${preset.codec} (${preset.encoder})`, {
      jobId: job.id, videoId: job.video_id, encoder: preset.encoder,
    });

    // ── Execute ffmpeg with fallback ──
    const result = await runFfmpegWithFallback(job, video, hwArgs, swArgs, tmpFile, gpuIdx, jobLog);

    if (result.cancelled) {
      await pool.query("UPDATE encode_jobs SET status='cancelled', ended_at=NOW() WHERE id=?", [job.id]);
      broadcast('job_update', { id: job.id, status: 'cancelled' });
      try { await fsp.unlink(tmpFile); } catch {}
      jobLog.info('Job cancelled by user');
      return;
    }

    if (result.code !== 0) {
      const errMsg = `ffmpeg exited with code ${result.code}.\n${result.stderr.slice(-2000)}`;
      jobLog.error(errMsg);
      await pool.query("UPDATE encode_jobs SET status='error', error=?, ended_at=NOW() WHERE id=?",
        [errMsg.slice(0, 5000), job.id]);
      broadcast('job_update', { id: job.id, status: 'error', error: errMsg.slice(0, 500) });
      try { await fsp.unlink(tmpFile); } catch {}
      logger.error('encoder', `Job #${job.id} failed: ffmpeg exit code ${result.code}`);
      return;
    }

    // ── Validate output ──
    jobLog.info('--- Validating output ---');
    const validationErrors = await validateOutput(tmpFile, preset.codec, inputDuration, jobLog);
    if (validationErrors.length > 0) {
      const errMsg = `Output validation failed:\n${validationErrors.join('\n')}`;
      jobLog.error(errMsg);
      await pool.query("UPDATE encode_jobs SET status='error', error=?, ended_at=NOW() WHERE id=?",
        [errMsg.slice(0, 5000), job.id]);
      broadcast('job_update', { id: job.id, status: 'error', error: errMsg.slice(0, 500) });
      try { await fsp.unlink(tmpFile); } catch {}
      logger.error('encoder', `Job #${job.id} failed validation: ${validationErrors[0]}`);
      return;
    }

    // ── Move to final path ──
    let finalPath = outFile;
    let newSize = 0;
    try { const st = await fsp.stat(tmpFile); newSize = st.size; } catch {}

    if (replaceOriginal) {
      try {
        const targetPath = path.join(path.dirname(inFile), `${baseName}${ext}`);
        // Move new file first, THEN delete original (ensures no data loss on failure)
        await moveFile(tmpFile, targetPath);
        finalPath = targetPath;
        // Only delete the original after the new file is safely in place
        if (targetPath !== inFile) {
          try { await fsp.unlink(inFile); } catch (unlinkErr) {
            jobLog.warn(`Could not remove original (${unlinkErr.message}), new file is safe at ${targetPath}`);
          }
        }
        // Re-probe output and update ALL video metadata (codec, size, duration, resolution, etc.)
        await refreshVideoMeta(job.video_id, targetPath, jobLog);
        jobLog.info(`Replaced original → ${targetPath}`);
      } catch (e) {
        jobLog.error(`Replace-original failed: ${e.message}`);
        finalPath = tmpFile;
      }
    } else {
      try {
        await moveFile(tmpFile, outFile);
        // Delete the original file since encode succeeded — avoids duplicates on next sync
        if (inFile !== outFile) {
          try { await fsp.unlink(inFile); jobLog.info(`Deleted original → ${inFile}`); } catch (unlinkErr) {
            if (unlinkErr.code !== 'ENOENT') jobLog.warn(`Could not remove original (${unlinkErr.message})`);
          }
        }
        // Update video metadata to reflect the new encoded file
        await refreshVideoMeta(job.video_id, outFile, jobLog);
        jobLog.info(`Output → ${outFile}`);
      } catch (e) {
        jobLog.error(`Move failed: ${e.message}`);
        finalPath = tmpFile;
      }
    }

    // ── Mark done ──
    await pool.query(
      "UPDATE encode_jobs SET status='done', output_path=?, output_size=?, ended_at=NOW() WHERE id=?",
      [finalPath, newSize, job.id]
    );
    broadcast('job_update', { id: job.id, status: 'done', output_path: finalPath, output_size: newSize, video_id: job.video_id });

    const savings = video.size > 0 ? ((1 - newSize / video.size) * 100).toFixed(1) : '?';
    jobLog.info(`=== Job #${job.id} DONE — ${(newSize / 1e6).toFixed(1)} MB (${savings}% savings) ===`);
    logger.success('encoder', `Job #${job.id} done: ${video.filename} → ${(newSize / 1e6).toFixed(1)} MB (${savings}% saved)`, {
      jobId: job.id, outputSize: newSize, savings: `${savings}%`,
    });

  } catch (e) {
    const errMsg = `Unexpected error: ${e.message}\n${e.stack}`;
    jobLog.error(errMsg);
    try {
      await pool.query("UPDATE encode_jobs SET status='error', error=?, ended_at=NOW() WHERE id=?",
        [errMsg.slice(0, 5000), job.id]);
      broadcast('job_update', { id: job.id, status: 'error', error: e.message });
    } catch {}
    logger.error('encoder', `Job #${job.id} crashed: ${e.message}`);
  } finally {
    unlockDevice(devKey);
    active.delete(job.id);
    if (tmpFile) { try { await fsp.unlink(tmpFile); } catch {} }
    await jobLog.close();
  }
}

/* ─── ffmpeg execution with GPU→CPU fallback ─────────────────── */

function runFfmpegWithFallback(job, video, hwArgs, swArgs, tmpFile, gpuIdx, jobLog) {
  return new Promise((resolve) => {
    let cancelled = false;
    let currentProc = null;

    const entry = {
      proc: null,
      video_id: job.video_id,
      cancel() {
        cancelled = true;
        if (currentProc) {
          currentProc.kill('SIGTERM');
          setTimeout(() => { try { currentProc.kill('SIGKILL'); } catch {} }, 5000);
        }
      },
    };
    active.set(job.id, entry);

    const env = { ...process.env };
    if (gpuIdx !== undefined) {
      env.CUDA_DEVICE_ORDER = 'PCI_BUS_ID';
      env.CUDA_VISIBLE_DEVICES = String(gpuIdx);
    }

    function runAttempt(args, label) {
      return new Promise((res) => {
        jobLog.info(`[${label}] Starting ffmpeg...`);
        const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], env });
        currentProc = proc;
        entry.proc = proc;

        let lastProgress = {};
        let stderrBuf = '';
        let lastDbProgressUpdate = 0;

        proc.stdout.on('data', (chunk) => {
          const lines = chunk.toString().split('\n');
          for (const line of lines) {
            const [k, v] = line.split('=').map(s => s.trim());
            if (k && v) lastProgress[k] = v;
          }
          if (lastProgress.out_time_ms && video.duration) {
            const pct = Math.min(100, Math.round((parseInt(lastProgress.out_time_ms, 10) / 1e6 / video.duration) * 100));
            broadcast('job_progress', {
              id: job.id, percent: pct,
              speed: lastProgress.speed || '',
              fps: lastProgress.fps || '',
              size: lastProgress.total_size || '',
            });
            // Persist progress to DB every 5 seconds so it survives page refresh
            const now = Date.now();
            if (now - lastDbProgressUpdate > 5000) {
              lastDbProgressUpdate = now;
              db.getPool().query('UPDATE encode_jobs SET progress=? WHERE id=?', [pct, job.id]).catch(() => {});
            }
          }
        });

        proc.stderr.on('data', (d) => {
          const text = d.toString();
          stderrBuf += text;
          if (stderrBuf.length > 50000) stderrBuf = stderrBuf.slice(-30000);
          jobLog.writeRaw(text);
        });

        proc.on('close', (code) => res({ code, stderr: stderrBuf, cancelled }));
        proc.on('error', (e) => {
          jobLog.error(`ffmpeg process error: ${e.message}`);
          res({ code: -1, stderr: `Process error: ${e.message}`, cancelled });
        });
      });
    }

    (async () => {
      // Try HW-accelerated decode first (NVIDIA only)
      if (hwArgs && !cancelled) {
        jobLog.info('Attempting hardware-accelerated decode...');
        const result = await runAttempt(hwArgs, 'HW');
        if (result.cancelled) { resolve(result); return; }
        if (result.code === 0) { resolve(result); return; }

        jobLog.warn(`HW decode failed (exit ${result.code}), falling back to CPU decode...`);
        logger.warn('encoder', `Job #${job.id}: HW decode failed, retrying with CPU decode`);
        try { await fsp.unlink(tmpFile); } catch {}
      }

      // Software decode fallback
      if (!cancelled) {
        jobLog.info('Using software (CPU) decode...');
        const result = await runAttempt(swArgs, 'SW');
        resolve(result);
      } else {
        resolve({ code: -1, stderr: '', cancelled: true });
      }
    })();
  });
}

/* ─── Queue processor ────────────────────────────────────────── */

async function processQueue() {
  if (!running) return;
  // Safety valve: if _processing stuck for >30s, force-reset it
  if (_processing && (Date.now() - _processingTs > PROCESSING_TIMEOUT)) {
    logger.warn('encoder', `processQueue lock stuck for ${Math.round((Date.now() - _processingTs)/1000)}s — force-releasing`);
    _processing = false;
  }
  if (_processing) return;
  _processing = true;
  _processingTs = Date.now();
  try {
    const pool = db.getPool();
    while (running && active.size < workerCount) {
      // Atomically claim ONE pending job by updating its status before firing processJob.
      // This prevents the same job being picked twice in rapid succession.
      const [rows] = await pool.query(
        "SELECT * FROM encode_jobs WHERE status='pending' ORDER BY created_at ASC LIMIT 1"
      );
      if (!rows.length) break;
      const job = rows[0];

      // Mark as 'claimed' in DB immediately so next iteration won't pick it again
      const [upd] = await pool.query(
        "UPDATE encode_jobs SET status='encoding' WHERE id=? AND status='pending'",
        [job.id]
      );
      if (upd.affectedRows === 0) continue; // Another worker beat us — skip

      // Add placeholder to active map so workerCount check works
      active.set(job.id, { proc: null, video_id: job.video_id, cancel() {} });

      processJob(job)
        .catch(e => logger.error('encoder', `Job #${job.id} crash: ${e.message}`))
        .finally(() => setImmediate(processQueue));
    }
  } catch (e) {
    logger.error('encoder', `Queue error: ${e.message}`);
  }
  _processing = false;
  _processingTs = 0;
}

/* ─── Job recovery on startup ────────────────────────────────── */

async function recoverStalledJobs() {
  try {
    const pool = db.getPool();
    const [stalled] = await pool.query("SELECT id FROM encode_jobs WHERE status='encoding'");
    if (stalled.length > 0) {
      const ids = stalled.map(j => j.id);
      await pool.query(
        "UPDATE encode_jobs SET status='pending', error='Recovered after server restart', started_at=NULL WHERE status='encoding'"
      );
      logger.info('encoder', `Recovered ${stalled.length} stalled job(s): [${ids.join(', ')}]`);
    }
  } catch (e) {
    logger.error('encoder', `Failed to recover stalled jobs: ${e.message}`);
  }
}

/* ─── Public API ─────────────────────────────────────────────── */

async function enqueue(video_id, presetId, replaceOriginal = false) {
  const caps = await gpuDetect.detectAll();
  const preset = caps.presets.find(p => p.id === presetId);
  if (!preset) throw new Error(`Unknown preset: ${presetId}`);

  const pool = db.getPool();
  const [[video]] = await pool.query('SELECT size FROM videos WHERE id=?', [video_id]);
  const fileSize = video ? video.size || 0 : 0;

  const [result] = await pool.query(
    "INSERT INTO encode_jobs (video_id, preset_id, preset_json, replace_original, status, file_size_before) VALUES (?,?,?,?,?,?)",
    [video_id, presetId, JSON.stringify(preset), replaceOriginal ? 1 : 0, 'pending', fileSize]
  );
  const id = result.insertId;
  broadcast('job_update', { id, status: 'pending', video_id, preset: preset.label });
  logger.info('encoder', `Job #${id} queued: video ${video_id}, preset ${preset.label}`);
  setImmediate(processQueue);
  return id;
}

async function enqueueBatch(videoIds, presetId, replaceOriginal = false) {
  const ids = [];
  for (const vid of videoIds) {
    ids.push(await enqueue(vid, presetId, replaceOriginal));
  }
  return ids;
}

function cancelJob(jobId) {
  const entry = active.get(jobId);
  if (entry) { entry.cancel(); logger.info('encoder', `Job #${jobId} cancel requested`); return true; }
  return false;
}

async function cancelPending() {
  const pool = db.getPool();
  const [result] = await pool.query("UPDATE encode_jobs SET status='cancelled', ended_at=NOW() WHERE status='pending'");
  if (result.affectedRows > 0) logger.info('encoder', `Cancelled ${result.affectedRows} pending job(s)`);
  return result.affectedRows;
}

async function retryJob(jobId) {
  const pool = db.getPool();
  const [[job]] = await pool.query('SELECT * FROM encode_jobs WHERE id=?', [jobId]);
  if (!job || !['failed', 'error', 'cancelled'].includes(job.status)) throw new Error('Cannot retry this job');
  await pool.query(
    "UPDATE encode_jobs SET status='pending', error=NULL, started_at=NULL, ended_at=NULL, output_path=NULL, output_size=NULL WHERE id=?",
    [jobId]
  );
  broadcast('job_update', { id: jobId, status: 'pending' });
  logger.info('encoder', `Job #${jobId} queued for retry`);
  setImmediate(processQueue);
  return jobId;
}

async function deleteJob(jobId) {
  const pool = db.getPool();
  const [[job]] = await pool.query('SELECT * FROM encode_jobs WHERE id=?', [jobId]);
  if (!job) throw new Error('Job not found');
  if (job.status === 'encoding') cancelJob(jobId);
  if (job.output_path) { try { await fsp.unlink(job.output_path); } catch {} }
  try { await fsp.unlink(path.join(LOG_DIR, `job_${jobId}.log`)); } catch {}
  await pool.query('DELETE FROM encode_jobs WHERE id=?', [jobId]);
  return true;
}

function setWorkerCount(n) {
  workerCount = Math.max(1, Math.min(8, n));
  logger.info('encoder', `Worker count set to ${workerCount}`);
  setImmediate(processQueue);
  return workerCount;
}

function getStatus() {
  return {
    running, workerCount, activeJobs: active.size,
    active: [...active.entries()].map(([id, e]) => ({ id, video_id: e.video_id })),
  };
}

async function getHistory(limit = 50, offset = 0) {
  const pool = db.getPool();
  const [rows] = await pool.query(
    `SELECT j.*, v.filename, v.file_path, v.folder
     FROM encode_jobs j LEFT JOIN videos v ON j.video_id = v.id
     ORDER BY j.created_at DESC LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  const [[{ total }]] = await pool.query('SELECT COUNT(*) as total FROM encode_jobs');
  return { rows, total };
}

async function getJobLog(jobId) {
  const logPath = path.join(LOG_DIR, `job_${jobId}.log`);
  try { return await fsp.readFile(logPath, 'utf-8'); }
  catch { return null; }
}

async function start() {
  running = true;
  await recoverStalledJobs();
  setImmediate(processQueue);
  // Watchdog: periodically nudge the queue in case it got stuck
  if (_watchdogTimer) clearInterval(_watchdogTimer);
  _watchdogTimer = setInterval(() => {
    if (running && active.size < workerCount) {
      setImmediate(processQueue);
    }
  }, 10000);
  logger.info('encoder', `Encoder started with ${workerCount} worker(s)`);
}

function stop() {
  running = false;
  if (_watchdogTimer) { clearInterval(_watchdogTimer); _watchdogTimer = null; }
  for (const e of active.values()) e.cancel();
  logger.info('encoder', 'Encoder stopped');
}

module.exports = {
  enqueue, enqueueBatch, cancelJob, cancelPending, retryJob, deleteJob,
  setWorkerCount, getStatus, getHistory, getJobLog,
  addSSEClient, broadcast,
  start, stop, processQueue,
};