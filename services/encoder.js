/**
 * services/encoder.js — Video encoding engine
 *
 * Queue-based multi-worker encoder with:
 *  - GPU allocation & multi-GPU load balancing
 *  - GPU→CPU decode fallback on hwaccel failure
 *  - HDR/10-bit preservation, Dolby Vision detection
 *  - Size guard (rejects encodes larger than original)
 *  - Output validation (codec, duration, integrity)
 *  - Per-job ffmpeg logs, job crash recovery
 *  - Schedule window, webhook notifications
 *  - SSE real-time progress broadcast
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
const ffprobe = require('./ffprobe');
const ffmpegArgs = require('./ffmpeg-args');
const webhook = require('./webhook');

const execFileAsync = promisify(execFile);

const ENCODE_DIR = process.env.ENCODE_DIR || path.join(__dirname, '..', 'data', 'encoded');
const LOG_DIR = path.join(__dirname, '..', 'data', 'logs');
const MAX_WORKERS = parseInt(process.env.MAX_WORKERS || '2', 10);

/* ─── SSE event bus ──────────────────────────────────────────── */
const sseClients = new Set();
function addSSEClient(res) { sseClients.add(res); res.on('close', () => sseClients.delete(res)); }
function removeSSEClient(res) { sseClients.delete(res); }
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) { try { c.write(msg); } catch { sseClients.delete(c); } }
}

/* ─── Throttled SSE progress (max once per 800ms per job) ────── */
const _progressThrottleMap = new Map(); // jobId → { timer, lastData }
function broadcastProgress(data) {
  const id = data.id;
  let entry = _progressThrottleMap.get(id);
  if (!entry) {
    entry = { timer: null, lastData: null };
    _progressThrottleMap.set(id, entry);
  }
  entry.lastData = data;
  if (!entry.timer) {
    // Send immediately on first call, then throttle
    broadcast('job_progress', data);
    entry.timer = setTimeout(() => {
      if (entry.lastData && entry.lastData !== data) {
        broadcast('job_progress', entry.lastData);
      }
      entry.timer = null;
    }, 800);
  }
}
function clearProgressThrottle(jobId) {
  const entry = _progressThrottleMap.get(jobId);
  if (entry) {
    if (entry.timer) clearTimeout(entry.timer);
    // Flush any buffered progress before clearing (avoids stuck % on frontend)
    if (entry.lastData) broadcast('job_progress', entry.lastData);
    _progressThrottleMap.delete(jobId);
  }
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
let paused = false;            // pause queue processing (no new jobs start)
let workerCount = MAX_WORKERS;
let _processing = false;
let _processingTs = 0;          // timestamp when _processing was set
const PROCESSING_TIMEOUT = 30000; // 30s safety valve
let _watchdogTimer = null;
let _stateBroadcastTimer = null;
const MAX_SIGNAL_RETRIES = 3;     // max SIGKILL recovery attempts before marking error
const RETRY_BACKOFF_BASE = 10000; // 10s base backoff (×2 per retry)
const _retryCooldown = new Set();  // job IDs in backoff — skipped by processQueue

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
  return undefined;
}

function vaapiDeviceFor(preset, devKey) {
  if (preset.type !== 'vaapi' && preset.type !== 'vaapi_group') return undefined;
  const prefix = 'vaapi_';
  if (devKey && devKey.startsWith(prefix)) return devKey.slice(prefix.length);
  return preset.renderDevice || pickVaapiDevice(preset);
}

/* ─── Safe cross-filesystem move ─────────────────────────────── */

async function copyFileStream(src, dst) {
  // Stream-based copy — works on all filesystem types (NFS, ZFS, overlayfs, etc.)
  // Unlike fs.copyFile which uses copy_file_range and fails with EPERM on some mounts.
  const { createReadStream, createWriteStream } = require('fs');
  const srcStat = await fsp.stat(src);
  await new Promise((resolve, reject) => {
    const rd = createReadStream(src);
    const wr = createWriteStream(dst);
    rd.on('error', err => { wr.destroy(); reject(err); });
    wr.on('error', reject);
    wr.on('finish', resolve);
    rd.pipe(wr);
  });
  // Integrity check: destination must exist and match source size exactly
  let dstStat;
  try { dstStat = await fsp.stat(dst); } catch (statErr) {
    throw new Error(`Copy integrity check: destination not found after copy (${statErr.code}): ${dst}`);
  }
  if (dstStat.size !== srcStat.size) {
    await fsp.unlink(dst).catch(() => {});
    throw new Error(`Copy integrity check failed: src=${srcStat.size} bytes, dst=${dstStat.size} bytes — partial file removed`);
  }
}

async function moveFile(src, dst, jobLog) {
  const srcStat = await fsp.stat(src);
  jobLog?.info(`moveFile: ${path.basename(src)} (${(srcStat.size / 1e6).toFixed(1)} MB) → ${dst}`);
  try {
    await fsp.rename(src, dst);
    jobLog?.info(`moveFile: rename succeeded`);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    jobLog?.info(`moveFile: cross-device (EXDEV), using stream copy`);
    await copyFileStream(src, dst);
    await fsp.unlink(src);
    jobLog?.info(`moveFile: stream copy + source cleanup done`);
  }
}

/* ─── Per-job log file ───────────────────────────────────────── */

async function createJobLogger(jobId) {
  await fsp.mkdir(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `job_${jobId}.log`);
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  // Prevent unhandled 'error' events from crashing the whole encoder service.
  // Disk full / quota / permission issues on the log path must NOT take down
  // active encodes — log to console as a last resort and keep going.
  stream.on('error', (e) => {
    try { console.error(`[encoder] job log write error (job #${jobId}): ${e.code || ''} ${e.message}`); } catch {}
  });

  function write(level, msg) {
    const ts = new Date().toISOString();
    if (stream.writable) {
      try { stream.write(`[${ts}] [${level}] ${msg}\n`); } catch {}
    }
  }

  return {
    info: (msg) => write('INFO', msg),
    warn: (msg) => write('WARN', msg),
    error: (msg) => write('ERROR', msg),
    writeRaw: (data) => { if (stream.writable) { try { stream.write(data); } catch {} } },
    close: () => new Promise(resolve => stream.end(resolve)),
    path: logPath,
  };
}

/* ─── Output validation (ported from av1encoder.sh) ──────────── */

async function validateOutput(tmpFile, expectedCodec, inputDuration, jobLog) {
  const errors = [];

  // Check file exists and is non-empty (with retry for filesystem lag / NFS / Docker volumes)
  const MAX_STAT_ATTEMPTS = 5;
  const STAT_RETRY_DELAY = 2000;
  let st = null;
  for (let attempt = 1; attempt <= MAX_STAT_ATTEMPTS; attempt++) {
    try {
      st = await fsp.stat(tmpFile);
      break;
    } catch (statErr) {
      if (attempt < MAX_STAT_ATTEMPTS) {
        jobLog.warn(`Output file not found (attempt ${attempt}/${MAX_STAT_ATTEMPTS}, ${statErr.code || statErr.message}), retrying in ${STAT_RETRY_DELAY / 1000}s…`);
        await new Promise(r => setTimeout(r, STAT_RETRY_DELAY));
      } else {
        // Diagnostic: list directory contents to see what ffmpeg actually wrote
        const dir = path.dirname(tmpFile);
        const base = path.basename(tmpFile);
        try {
          const files = await fsp.readdir(dir);
          const nearby = files.filter(f => f.includes('.tmp.') || f.includes(path.basename(tmpFile).split('.')[0]));
          jobLog.error(`ENOENT diagnostic — expected: ${base}`);
          jobLog.error(`ENOENT diagnostic — dir ${dir} contains ${files.length} file(s), nearby matches: ${nearby.length > 0 ? nearby.join(', ') : '(none)'}`);
          // Check disk space
          const { execSync } = require('child_process');
          const df = execSync(`df -h "${dir}" 2>/dev/null || true`).toString().trim();
          jobLog.error(`ENOENT diagnostic — disk space:\n${df}`);
        } catch (diagErr) {
          jobLog.error(`ENOENT diagnostic failed: ${diagErr.message}`);
        }
        errors.push(`Output file does not exist (${statErr.code || statErr.message}): ${tmpFile}`);
        return errors;
      }
    }
  }
  if (st.size === 0) { errors.push('Output file is empty (0 bytes)'); return errors; }
  jobLog.info(`Output file size: ${(st.size / 1e6).toFixed(1)} MB`);

  // Check output video codec
  const outCodec = await ffprobe.ffprobeValue(tmpFile, 'v:0', 'stream=codec_name');
  jobLog.info(`Output codec: ${outCodec} (expected: ${expectedCodec})`);
  if (!outCodec) {
    errors.push('ffprobe could not read output video codec');
  } else if (expectedCodec === 'av1' && outCodec !== 'av1') {
    errors.push(`Unexpected output codec: ${outCodec} (expected av1)`);
  } else if (expectedCodec === 'h265' && outCodec !== 'hevc') {
    errors.push(`Unexpected output codec: ${outCodec} (expected hevc)`);
  }

  // Check output duration
  const outDuration = await ffprobe.duration(tmpFile);
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
    const info = await ffprobe.fullInfo(filePath);
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

  // Parse preset early so we can unlock device in finally.
  // Defensive: JSON.parse("null") returns null (not exception), and an old
  // job may have stored an incomplete preset. We MUST validate the result
  // is a real object with .encoder before going further — otherwise the
  // first `preset.encoder` access in buildArgs crashes the worker thread
  // and leaves the job stuck in 'encoding' forever.
  let preset;
  try { preset = JSON.parse(job.preset_json); }
  catch { preset = null; }
  if (!preset || typeof preset !== 'object' || !preset.encoder || !preset.codec) {
    const err = `Invalid/missing preset for job #${job.id} (preset_json=${String(job.preset_json).slice(0, 120)}). Marking as error.`;
    jobLog.error(err);
    try {
      await pool.query("UPDATE encode_jobs SET status='error', error=?, ended_at=NOW() WHERE id=?", ['Invalid preset configuration', job.id]);
      broadcast('job_update', { id: job.id, status: 'error', error: 'Invalid preset configuration' });
    } catch (dbErr) {
      jobLog.error(`Failed to mark job as error: ${dbErr.message}`);
    }
    return;
  }

  // Parse encode options (container, downscale, tonemap)
  let encodeOpts = {};
  try { if (job.encode_options) encodeOpts = JSON.parse(job.encode_options); } catch { /* use defaults */ }

  let devKey = job._preLockedDevKey || 'cpu';
  let tmpFile = null;

  try {
    // Abort immediately if encoder is stopping (PM2 restart, graceful shutdown)
    if (!running) {
      jobLog.warn('Encoder is stopping — aborting job before start');
      await pool.query("UPDATE encode_jobs SET status='pending', started_at=NULL WHERE id=?", [job.id]);
      return;
    }

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
        ffprobe.firstVideoCodec(video.file_path),
        ffprobe.colorMeta(video.file_path),
        ffprobe.bitDepth(video.file_path),
        ffprobe.sideDataTypes(video.file_path),
        ffprobe.duration(video.file_path),
        ffprobe.badSubtitleIndices(video.file_path),
        ffprobe.fullInfo(video.file_path),
      ]);

    jobLog.info(`Input codec: ${inputCodec}`);
    jobLog.info(`Color: transfer=${colorMeta.transfer} primaries=${colorMeta.primaries} space=${colorMeta.space} range=${colorMeta.range}`);
    jobLog.info(`Bit depth: ${bitDepth}, Duration: ${inputDuration}s`);

    // Ensure video.duration is set from the live ffprobe value: the DB may
    // hold NULL for un-enriched videos. Without this, the progress
    // calculation block (`if (... && video.duration)`) would never run and
    // no `job_progress` SSE events would reach the frontend → progress bar
    // appears stuck at 0%.
    if (inputDuration && inputDuration > 0) {
      video.duration = inputDuration;
    }
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
    // Container: user choice > auto
    let ext;
    if (encodeOpts.container === 'mkv') ext = '.mkv';
    else if (encodeOpts.container === 'mp4') ext = '.mp4';
    else ext = isAv1 ? '.mkv' : '.mp4';
    const baseName = path.basename(inFile, path.extname(inFile));
    const replaceOriginal = !!job.replace_original;

    await fsp.mkdir(ENCODE_DIR, { recursive: true });
    const outFile = replaceOriginal
      ? path.join(ENCODE_DIR, `${baseName}_enc_${job.id}${ext}`)
      : path.join(ENCODE_DIR, `${baseName}_${preset.codec}${ext}`);
    tmpFile = outFile.replace(/(\.[^.]+)$/, `.tmp.${job.id}$1`);

    jobLog.info(`Output: ${outFile}`);
    jobLog.info(`Temp: ${tmpFile}`);

    // ── Check running flag again after probing (probing can take 5-15s) ──
    if (!running) {
      jobLog.warn('Encoder stopped during probing — returning job to pending');
      await pool.query("UPDATE encode_jobs SET status='pending', started_at=NULL WHERE id=?", [job.id]);
      return;
    }

    // ── Lock device & update status ──
    // Use pre-locked device if processQueue already locked it for us (prevents race)
    devKey = job._preLockedDevKey || devKeyFor(preset);
    const gpuIdx = job._preLockedGpuIdx ?? gpuIndexFor(preset);
    if (!job._preLockedDevKey) lockDevice(devKey);
    // Mark that we own the lock so finally always unlocks
    job._deviceLocked = true;

    await pool.query(
      // Status is already 'encoding' (set atomically by processQueue's claim).
      // Only update fields not yet populated to avoid a redundant status write.
      "UPDATE encode_jobs SET started_at=NOW(), file_size_before=? WHERE id=?",
      [video.size || 0, job.id]
    );
    // Note: no need to broadcast 'encoding' again — processQueue already did.

    // ── Build ffmpeg arguments ──
    const probeInfo = {
      inputCodec, colorMeta, bitDepth, isHdr,
      caps: encCaps, badSubIndices, inputDuration,
      // Only secondary video streams that are safe to copy (attached pics with valid
      // dimensions and a known pixel format). Streams with pix_fmt='none' or missing
      // width/height crash the muxer with "dimensions not set" (code 234).
      validSecondaryVideoIndices: fullInfo ? (fullInfo.streams || [])
        .filter(s =>
          s.codec_type === 'video' &&
          s.index > 0 &&                          // skip primary stream
          s.width && s.height &&                  // must have dimensions
          s.pix_fmt && s.pix_fmt !== 'none'       // must have a known pixel format
        )
        .map(s => s.index) : [],
      // Secondary video streams that are broken (unknown dimensions/pix_fmt) — must be
      // explicitly excluded via negative -map to prevent "dimensions not set" crashes.
      badVideoIndices: fullInfo ? (fullInfo.streams || [])
        .filter(s =>
          s.codec_type === 'video' &&
          s.index > 0 &&
          (!s.width || !s.height || !s.pix_fmt || s.pix_fmt === 'none')
        )
        .map(s => s.index) : [],
      subtitleStreams: fullInfo ? (fullInfo.streams || [])
        .filter(s => s.codec_type === 'subtitle')
        .map(s => ({ idx: s.index, codec: (s.codec_name || '').toLowerCase() })) : [],
      vaapiDevice: vaapiDeviceFor(preset, devKey),
    };
    const { swArgs, hwArgs, actualOutFile } = ffmpegArgs.buildArgs(preset, inFile, tmpFile, probeInfo, encodeOpts);

    // buildArgs may adjust the output path (e.g. extension change) —
    // always use the path that ffmpeg will actually write to.
    if (actualOutFile !== tmpFile) {
      jobLog.warn(`Output path adjusted by buildArgs: ${tmpFile} → ${actualOutFile}`);
      tmpFile = actualOutFile;
    }

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
      try { await fsp.unlink(tmpFile); } catch { /* cleanup — file may not exist */ }
      jobLog.info('Job cancelled by user');
      return;
    }

    // ffmpeg killed by external signal (PM2 restart, OOM, etc.)
    if (result.code === null) {
      const retries = (job.retry_count || 0) + 1;
      if (retries >= MAX_SIGNAL_RETRIES) {
        const errMsg = `ffmpeg killed by external signal ${retries} time(s) — giving up (max ${MAX_SIGNAL_RETRIES} retries)`;
        jobLog.error(errMsg);
        await pool.query("UPDATE encode_jobs SET status='error', error=?, ended_at=NOW() WHERE id=?", [errMsg, job.id]);
        broadcast('job_update', { id: job.id, status: 'error', error: errMsg });
      } else {
        const backoffMs = RETRY_BACKOFF_BASE * Math.pow(2, retries - 1);
        jobLog.error(`ffmpeg killed by external signal — retry ${retries}/${MAX_SIGNAL_RETRIES} with ${backoffMs / 1000}s backoff`);
        await pool.query(
          "UPDATE encode_jobs SET status='pending', retry_count=?, error=CONCAT(COALESCE(error,''), ?), started_at=NULL WHERE id=?",
          [retries, `\n[retry ${retries}] killed by signal at ${new Date().toISOString()}`, job.id]
        );
        broadcast('job_update', { id: job.id, status: 'pending' });
        // Cooldown: prevent processQueue from picking this job immediately
        _retryCooldown.add(job.id);
        setTimeout(() => {
          _retryCooldown.delete(job.id);
          if (running) setImmediate(processQueue);
        }, backoffMs);
      }
      try { await fsp.unlink(tmpFile); } catch { /* cleanup — file may not exist */ }
      return;
    }

    if (result.code !== 0) {
      // Extract meaningful error lines from stderr (skip metadata/progress noise)
      const allStderr = result.stderrHead + '\n' + result.stderrTail;
      const errorLines = allStderr.split('\n').filter(l =>
        /error|cannot|invalid|failed|not found|no such|denied|killed|abort|segfault|signal/i.test(l)
      ).slice(0, 20).join('\n');

      // ── 3rd-level fallback: GPU encoder init failed → retry with CPU ──
      // This catches NVENC driver crashes, VRAM exhaustion, missing capable
      // device, VA-API init failures, etc. — situations where the GPU
      // encoder itself can't run but a CPU encoder would succeed.
      const cpuPreset = deriveCpuPreset(preset);
      if (cpuPreset && shouldFallbackToCpu(allStderr, preset.type)) {
        jobLog.warn(`GPU encoder ${preset.encoder} failed to initialize — falling back to CPU encoder ${cpuPreset.encoder}`);
        logger.warn('encoder', `Job #${job.id}: GPU init failed, retrying with CPU (${cpuPreset.encoder})`);
        try { await fsp.unlink(tmpFile); } catch { /* cleanup */ }
        // Rebuild args with CPU preset (no hwArgs this time — pure CPU path)
        const cpuBuild = ffmpegArgs.buildArgs(cpuPreset, inFile, tmpFile, probeInfo, encodeOpts);
        if (cpuBuild.actualOutFile !== tmpFile) tmpFile = cpuBuild.actualOutFile;
        jobLog.info(`CPU retry: ffmpeg ${cpuBuild.swArgs.join(' ')}`);
        const cpuResult = await runFfmpegWithFallback(job, video, null, cpuBuild.swArgs, tmpFile, undefined, jobLog);
        if (cpuResult.cancelled) {
          await pool.query("UPDATE encode_jobs SET status='cancelled', ended_at=NOW() WHERE id=?", [job.id]);
          broadcast('job_update', { id: job.id, status: 'cancelled' });
          try { await fsp.unlink(tmpFile); } catch { /* cleanup */ }
          return;
        }
        if (cpuResult.code === 0) {
          jobLog.info('CPU fallback succeeded');
          // Continue to the post-encode validation flow below by mutating result
          result.code = 0;
          result.stderrHead = cpuResult.stderrHead;
          result.stderrTail = cpuResult.stderrTail;
        } else {
          const cpuStderr = cpuResult.stderrHead + '\n' + cpuResult.stderrTail;
          const cpuErrorLines = cpuStderr.split('\n').filter(l =>
            /error|cannot|invalid|failed|not found|no such|denied|killed|abort|segfault|signal/i.test(l)
          ).slice(0, 20).join('\n');
          const errMsg = `GPU encoder failed AND CPU fallback failed.\n[GPU exit ${result.code}]\n${errorLines}\n[CPU exit ${cpuResult.code}]\n${cpuErrorLines || cpuStderr.slice(-2000)}`;
          jobLog.error(errMsg);
          await pool.query("UPDATE encode_jobs SET status='error', error=?, ended_at=NOW() WHERE id=?",
            [errMsg.slice(0, 5000), job.id]);
          broadcast('job_update', { id: job.id, status: 'error', error: errMsg.slice(0, 500) });
          try { await fsp.unlink(tmpFile); } catch { /* cleanup */ }
          logger.error('encoder', `Job #${job.id} failed: GPU+CPU both errored`);
          return;
        }
      } else {
        const errMsg = `ffmpeg exited with code ${result.code}.\n${errorLines || result.stderrTail.slice(-2000)}`;
        jobLog.error(errMsg);
        await pool.query("UPDATE encode_jobs SET status='error', error=?, ended_at=NOW() WHERE id=?",
          [errMsg.slice(0, 5000), job.id]);
        broadcast('job_update', { id: job.id, status: 'error', error: errMsg.slice(0, 500) });
        try { await fsp.unlink(tmpFile); } catch { /* cleanup — file may not exist */ }
        logger.error('encoder', `Job #${job.id} failed: ffmpeg exit code ${result.code}`);
        return;
      }
    }

    // ── Quick existence check right after ffmpeg exit ──
    try {
      await fsp.access(tmpFile);
      jobLog.info(`Post-ffmpeg check: output file exists at ${tmpFile}`);
    } catch (accessErr) {
      jobLog.error(`Post-ffmpeg check: output file MISSING immediately after ffmpeg exit 0 — ${accessErr.code}: ${tmpFile}`);
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
      try { await fsp.unlink(tmpFile); } catch { /* cleanup — file may not exist */ }
      logger.error('encoder', `Job #${job.id} failed validation: ${validationErrors[0]}`);
      return;
    }

    // ── Move to final path ──
    let finalPath = outFile;
    let newSize = 0;
    try { const st = await fsp.stat(tmpFile); newSize = st.size; } catch { /* stat unavailable */ }

    // ── Size guard — reject encodes that are larger than the original ──
    const origSize = video.size || 0;
    if (origSize > 0 && newSize >= origSize) {
      const pctBigger = ((newSize / origSize - 1) * 100).toFixed(1);
      const msg = `Output (${(newSize / 1e6).toFixed(1)} MB) is ${pctBigger}% larger than original (${(origSize / 1e6).toFixed(1)} MB) — discarding encode, keeping original`;
      jobLog.warn(msg);
      logger.warn('encoder', `Job #${job.id}: ${msg}`);
      try { await fsp.unlink(tmpFile); } catch { /* cleanup — file may not exist */ }
      tmpFile = null; // prevent double-unlink in finally
      // Flag video so it won't be re-encoded by accident
      await pool.query('UPDATE videos SET encode_skip = 1 WHERE id = ?', [job.video_id]);
      await pool.query(
        "UPDATE encode_jobs SET status='done', output_path=NULL, output_size=0, error=?, ended_at=NOW() WHERE id=?",
        [`Skipped: output larger than original (+${pctBigger}%)`, job.id]
      );
      broadcast('job_update', { id: job.id, status: 'done', video_id: job.video_id, skipped: true,
        reason: `Fichier encodé plus gros (+${pctBigger}%), original conservé` });
      return;
    }

    if (replaceOriginal) {
      const targetPath = path.join(path.dirname(inFile), `${baseName}${ext}`);
      jobLog.info(`--- Replacing original ---`);
      jobLog.info(`Encoded  : ${tmpFile} (${(newSize / 1e6).toFixed(1)} MB)`);
      jobLog.info(`Target   : ${targetPath}`);
      jobLog.info(`Original : ${inFile} (${(video.size / 1e6).toFixed(1)} MB)`);
      try {
        // Ensure destination directory exists (e.g. new season folder on NFS)
        await fsp.mkdir(path.dirname(targetPath), { recursive: true });
        // Move encoded file to destination FIRST — original untouched until we confirm success
        await moveFile(tmpFile, targetPath, jobLog);
        tmpFile = null; // file is now at targetPath — prevent finally from deleting it
        finalPath = targetPath;
        // Verify destination is intact before touching DB or original
        const dstStat = await fsp.stat(targetPath);
        jobLog.info(`Destination verified: ${(dstStat.size / 1e6).toFixed(1)} MB at ${targetPath}`);
        // Update DB BEFORE deleting original — prevents orphan entry if unlink fails
        await refreshVideoMeta(job.video_id, targetPath, jobLog);
        // Only delete the original AFTER DB is updated and destination is confirmed
        if (targetPath !== inFile) {
          try {
            await fsp.unlink(inFile);
            jobLog.info(`Original deleted: ${inFile}`);
          } catch (unlinkErr) {
            jobLog.warn(`Could not delete original (${unlinkErr.message}) — new file is safe at ${targetPath}`);
          }
        }
        jobLog.info(`Replaced original → ${targetPath}`);
      } catch (e) {
        if (tmpFile !== null) {
          // moveFile threw — encoded file is still in ENCODE_DIR
          const errMsg = `Replace-original FAILED (${e.message}) — encoded file stranded at: ${tmpFile}`;
          jobLog.error(errMsg);
          logger.error('encoder', `Job #${job.id}: ${errMsg}`);
          await pool.query("UPDATE encode_jobs SET status='error', error=?, ended_at=NOW() WHERE id=?",
            [errMsg.slice(0, 5000), job.id]);
          broadcast('job_update', { id: job.id, status: 'error', error: errMsg.slice(0, 500) });
          tmpFile = null; // keep file in ENCODE_DIR — prevent finally from deleting it
        } else {
          // moveFile succeeded but post-move verification failed — file should be at targetPath
          const errMsg = `Post-move verification FAILED (${e.message}) — file may be at: ${targetPath}`;
          jobLog.error(errMsg);
          logger.error('encoder', `Job #${job.id}: ${errMsg}`);
          await pool.query("UPDATE encode_jobs SET status='error', error=?, ended_at=NOW() WHERE id=?",
            [errMsg.slice(0, 5000), job.id]);
          broadcast('job_update', { id: job.id, status: 'error', error: errMsg.slice(0, 500) });
        }
        return;
      }
    } else {
      jobLog.info(`--- Moving to output directory ---`);
      jobLog.info(`Encoded  : ${tmpFile} (${(newSize / 1e6).toFixed(1)} MB)`);
      jobLog.info(`Output   : ${outFile}`);
      try {
        await moveFile(tmpFile, outFile, jobLog);
        tmpFile = null; // file is now at outFile — prevent finally from deleting it
        finalPath = outFile;
        // Update DB BEFORE deleting original — prevents orphan entry if refreshVideoMeta fails
        await refreshVideoMeta(job.video_id, outFile, jobLog);
        // Only delete the original AFTER DB is updated
        if (inFile !== outFile) {
          try {
            await fsp.unlink(inFile);
            jobLog.info(`Original deleted: ${inFile}`);
          } catch (unlinkErr) {
            if (unlinkErr.code !== 'ENOENT') jobLog.warn(`Could not delete original (${unlinkErr.message})`);
          }
        }
        jobLog.info(`Output → ${outFile}`);
      } catch (e) {
        if (tmpFile !== null) {
          // moveFile threw — encoded file is still in ENCODE_DIR as tmpFile
          const errMsg = `Move FAILED (${e.message}) — encoded file stranded at: ${tmpFile}`;
          jobLog.error(errMsg);
          logger.error('encoder', `Job #${job.id}: ${errMsg}`);
          await pool.query("UPDATE encode_jobs SET status='error', error=?, ended_at=NOW() WHERE id=?",
            [errMsg.slice(0, 5000), job.id]);
          broadcast('job_update', { id: job.id, status: 'error', error: errMsg.slice(0, 500) });
          tmpFile = null; // keep file in ENCODE_DIR — prevent finally from deleting it
        } else {
          const errMsg = `Post-move error (${e.message})`;
          jobLog.error(errMsg);
          logger.error('encoder', `Job #${job.id}: ${errMsg}`);
          await pool.query("UPDATE encode_jobs SET status='error', error=?, ended_at=NOW() WHERE id=?",
            [errMsg.slice(0, 5000), job.id]);
          broadcast('job_update', { id: job.id, status: 'error', error: errMsg.slice(0, 500) });
        }
        return;
      }
    }

    // ── Mark done ──
    await pool.query(
      "UPDATE encode_jobs SET status='done', output_path=?, output_size=?, ended_at=NOW() WHERE id=?",
      [finalPath, newSize, job.id]
    );
    broadcast('job_update', { id: job.id, status: 'done', output_path: finalPath, output_size: newSize, video_id: job.video_id });

    // ── Persist savings to permanent ledger ──
    const savedBytes = (video.size || 0) - newSize;
    try {
      await pool.query(
        'INSERT INTO encoding_savings (video_id, filename, codec_before, codec_after, size_before, size_after, saved, preset_id) VALUES (?,?,?,?,?,?,?,?)',
        [job.video_id, video.filename, inputCodec, preset.codec, video.size || 0, newSize, savedBytes, job.preset_id]
      );
    } catch (e) { logger.warn('encoder', `Could not persist savings: ${e.message}`); }

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
    } catch { /* non-critical */ }
    logger.error('encoder', `Job #${job.id} crashed: ${e.message}`);
  } finally {
    unlockDevice(devKey);
    active.delete(job.id);
    clearProgressThrottle(job.id);
    if (tmpFile) { try { await fsp.unlink(tmpFile); } catch { /* cleanup — file may not exist */ } }
    await jobLog.close();
    // Fire webhook if queue is now empty
    webhook.checkAndFire().catch(() => {});
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
          setTimeout(() => { try { currentProc.kill('SIGKILL'); } catch { /* process already exited */ } }, 5000);
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

        // Log the PID and listen for signals to diagnose external kills
        jobLog.info(`[${label}] ffmpeg PID: ${proc.pid}`);

        const lastProgress = {};
        let stderrHead = '';   // first 5KB (captures init errors)
        let stderrTail = '';   // rolling last 30KB
        let lastDbProgressUpdate = 0;

        proc.stdout.on('data', (chunk) => {
          const lines = chunk.toString().split('\n');
          for (const line of lines) {
            const [k, v] = line.split('=').map(s => s.trim());
            if (k && v) lastProgress[k] = v;
          }
          if (lastProgress.out_time_ms && video.duration) {
            const outTimeUs = parseInt(lastProgress.out_time_ms, 10);
            if (!isNaN(outTimeUs) && outTimeUs >= 0) {
              const pct = Math.min(100, Math.round((outTimeUs / 1e6 / video.duration) * 100));
              broadcastProgress({
                id: job.id, percent: pct,
                speed: lastProgress.speed || '',
                fps: lastProgress.fps || '',
                size: lastProgress.total_size || '',
              });
              // Persist progress to DB every 3 seconds so it survives page refresh
              const now = Date.now();
              if (now - lastDbProgressUpdate > 3000) {
                lastDbProgressUpdate = now;
                db.getPool().query('UPDATE encode_jobs SET progress=? WHERE id=?', [pct, job.id]).catch(() => {});
              }
            }
          }
        });

        proc.stderr.on('data', (d) => {
          const text = d.toString();
          // Keep the first 5KB to capture init/encoder errors
          if (stderrHead.length < 5000) stderrHead += text.slice(0, 5000 - stderrHead.length);
          // Rolling tail for runtime errors
          stderrTail += text;
          if (stderrTail.length > 50000) stderrTail = stderrTail.slice(-30000);
          jobLog.writeRaw(text);
        });

        proc.on('close', (code, signal) => {
          if (signal) jobLog.warn(`[${label}] ffmpeg exited by signal: ${signal} (code=${code})`);
          res({ code, stderrHead, stderrTail, cancelled });
        });
        proc.on('error', (e) => {
          jobLog.error(`ffmpeg process error: ${e.message}`);
          res({ code: -1, stderrHead: `Process error: ${e.message}`, stderrTail: '', cancelled });
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

        // exit code null = killed by external signal (PM2 restart, OOM, etc.)
        // Do NOT fall back to SW — the kill was external, not an encoder issue.
        if (result.code === null) {
          jobLog.error('HW ffmpeg was killed by external signal — aborting (not falling back to SW)');
          resolve(result);
          return;
        }

        jobLog.warn(`HW decode failed (exit ${result.code}), falling back to CPU decode...`);
        logger.warn('encoder', `Job #${job.id}: HW decode failed, retrying with CPU decode`);
        try { await fsp.unlink(tmpFile); } catch { /* cleanup — file may not exist */ }
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

/* ─── Hardware → CPU encoder fallback helpers ────────────────── */

// Map a hardware encoder name to its CPU equivalent. Used as a last-resort
// fallback when the GPU encoder fails to initialize (e.g. driver crash,
// VRAM exhaustion, unsupported codec parameters specific to NVENC/QSV/VAAPI).
const HW_TO_CPU_ENCODER = {
  // NVIDIA NVENC
  av1_nvenc: 'libsvtav1',
  hevc_nvenc: 'libx265',
  h264_nvenc: 'libx264',
  // Intel QSV
  av1_qsv: 'libsvtav1',
  hevc_qsv: 'libx265',
  h264_qsv: 'libx264',
  // VA-API (AMD/Intel)
  av1_vaapi: 'libsvtav1',
  hevc_vaapi: 'libx265',
  h264_vaapi: 'libx264',
  // AMD AMF
  av1_amf: 'libsvtav1',
  hevc_amf: 'libx265',
  h264_amf: 'libx264',
};

// Pattern matching for "the GPU encoder itself failed to initialize" — these
// are the cases where retrying the same encoder is pointless and we should
// fall back to a CPU encoder instead. Excludes input/codec-parameter errors
// that would also fail in CPU.
const GPU_INIT_ERROR_PATTERNS = [
  /OpenEncodeSessionEx failed/i,
  /InitializeEncoder failed/i,
  /No NVENC capable devices found/i,
  /Cannot load (libnvcuvid|nvcuda)/i,
  /Driver does not support the required nvenc API/i,
  /CreateDevice failed/i,
  /Failed setup for format cuda/i,
  /Failed loading nvcuvid/i,
  /No capable devices found/i,
  /Function not implemented.*nvenc/i,
  /vaapi.*Failed to initialise/i,
  /Failed to open VA display/i,
  /qsv.*not found/i,
  /Error initializing.*qsv/i,
  /Generic error in an external library/i, // common NVENC catch-all
];

function shouldFallbackToCpu(stderr, presetType) {
  if (presetType === 'cpu' || !presetType) return false;
  return GPU_INIT_ERROR_PATTERNS.some(re => re.test(stderr));
}

// Derive a CPU-equivalent preset from a hardware preset, preserving codec/cq.
function deriveCpuPreset(preset) {
  const cpuEncoder = HW_TO_CPU_ENCODER[preset.encoder];
  if (!cpuEncoder) return null;
  return {
    ...preset,
    type: 'cpu',
    encoder: cpuEncoder,
    // Drop NVENC-specific options that don't apply to CPU encoders
    nvencPreset: undefined,
    nvencTune: undefined,
    gpuIndex: undefined,
    gpuCount: undefined,
    deviceCount: undefined,
    renderDevice: undefined,
  };
}



async function isScheduleAllowed() {
  const enabled = await db.getSetting('schedule_enabled', '0');
  if (enabled !== '1') return true; // scheduling disabled = always allowed
  const startH = parseInt(await db.getSetting('schedule_start', '0'), 10);
  const endH   = parseInt(await db.getSetting('schedule_end', '24'), 10);
  const now = new Date();
  const h = now.getHours();
  if (startH <= endH) return h >= startH && h < endH;
  // Overnight window (e.g. 22 → 6)
  return h >= startH || h < endH;
}

/* ─── Queue processor ────────────────────────────────────────── */

async function processQueue() {
  if (!running) return;
  if (paused) return; // Queue is paused — don't start new jobs
  // Safety valve: if _processing stuck for >30s, force-reset it
  if (_processing && (Date.now() - _processingTs > PROCESSING_TIMEOUT)) {
    logger.warn('encoder', `processQueue lock stuck for ${Math.round((Date.now() - _processingTs)/1000)}s — force-releasing`);
    _processing = false;
  }
  if (_processing) return;
  _processing = true;
  _processingTs = Date.now();
  try {
    // Check schedule window
    if (!(await isScheduleAllowed())) {
      _processing = false;
      _processingTs = 0;
      return;
    }
    const pool = db.getPool();
    while (running && active.size < workerCount) {
      // Atomically claim ONE pending job by updating its status before firing processJob.
      // This prevents the same job being picked twice in rapid succession.
      // Skip jobs in SIGKILL backoff cooldown
      let rows;
      if (_retryCooldown.size > 0) {
        const cooldownIds = [..._retryCooldown];
        const placeholders = cooldownIds.map(() => '?').join(',');
        [rows] = await pool.query(
          `SELECT * FROM encode_jobs WHERE status='pending' AND id NOT IN (${placeholders}) ORDER BY priority DESC, created_at ASC LIMIT 1`,
          cooldownIds
        );
      } else {
        [rows] = await pool.query(
          "SELECT * FROM encode_jobs WHERE status='pending' ORDER BY priority DESC, created_at ASC LIMIT 1"
        );
      }
      if (!rows.length) break;
      const job = rows[0];

      // Mark as 'claimed' in DB immediately so next iteration won't pick it again
      const [upd] = await pool.query(
        "UPDATE encode_jobs SET status='encoding' WHERE id=? AND status='pending'",
        [job.id]
      );
      if (upd.affectedRows === 0) continue; // Another worker beat us — skip

      // Broadcast immediately so the frontend shows 'encoding' without waiting for probes
      broadcast('job_update', { id: job.id, status: 'encoding', video_id: job.video_id });

      // Pre-lock GPU device in processQueue (before async processJob)
      // to prevent race condition where two jobs both pick the same GPU
      let preLockedDevKey = null;
      let preLockedGpuIdx = undefined;
      try {
        const preset = JSON.parse(job.preset_json);
        // Compute devKey and gpuIdx from a single GPU pick to keep them consistent
        preLockedDevKey = devKeyFor(preset);
        // Extract gpu index from devKey to avoid a second pickNvidiaGpu call
        const nvidiaMatch = preLockedDevKey.match(/^nvidia_(\d+)$/);
        preLockedGpuIdx = nvidiaMatch ? parseInt(nvidiaMatch[1], 10) : undefined;
        lockDevice(preLockedDevKey);
        job._preLockedDevKey = preLockedDevKey;
        job._preLockedGpuIdx = preLockedGpuIdx;
      } catch { /* preset parse fail — processJob will handle it */ }

      // Add placeholder to active map so workerCount check works
      active.set(job.id, {
        proc: null, video_id: job.video_id,
        cancel() {
          // Revert this single job to cancelled (don't stop the whole encoder)
          db.getPool().query("UPDATE encode_jobs SET status='cancelled', ended_at=NOW() WHERE id=? AND status='encoding'", [job.id]).catch(() => {});
          broadcast('job_update', { id: job.id, status: 'cancelled' });
          active.delete(job.id);
        },
      });

      processJob(job)
        .catch(e => logger.error('encoder', `Job #${job.id} crash: ${e.message}`))
        .finally(() => setImmediate(processQueue));
    }
  } catch (e) {
    // ETIMEDOUT / ECONNREFUSED at boot = MySQL pool not ready yet.
    // Don't spam errors; the watchdog will retry in 10 s.
    const transient = ['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'PROTOCOL_CONNECTION_LOST'].includes(e.code);
    if (transient) {
      logger.warn('encoder', `Queue transient error (will retry): ${e.code} ${e.message}`);
    } else {
      logger.error('encoder', `Queue error: ${e.message}`);
    }
  }
  _processing = false;
  _processingTs = 0;
}

/* ─── Job recovery on startup ────────────────────────────────── */

async function recoverStalledJobs() {
  // Kill orphan ffmpeg processes from previous instance (PM2 restart, crash, etc.)
  try {
    const { execSync } = require('child_process');
    const pids = execSync("pgrep -f 'ffmpeg.*\\.tmp\\.' 2>/dev/null || true").toString().trim();
    if (pids) {
      for (const pid of pids.split('\n').filter(Boolean)) {
        try { process.kill(parseInt(pid, 10), 'SIGKILL'); } catch { /* process already exited */ }
      }
      logger.warn('encoder', `Killed ${pids.split('\n').filter(Boolean).length} orphan ffmpeg process(es) from previous instance`);
    }
  } catch { /* non-critical */ }

  // Clean up stale .tmp. files in ENCODE_DIR (partial encodes from crashed jobs)
  try {
    const files = await fsp.readdir(ENCODE_DIR).catch(() => []);
    const staleTemps = files.filter(f => /\.tmp\.\d+\./i.test(f));
    for (const f of staleTemps) {
      try { await fsp.unlink(path.join(ENCODE_DIR, f)); } catch { /* cleanup — file may not exist */ }
    }
    if (staleTemps.length) logger.info('encoder', `Cleaned up ${staleTemps.length} stale temp file(s)`);
  } catch { /* non-critical */ }

  try {
    const pool = db.getPool();
    // Mark stalled encoding jobs as cancelled (NOT pending) to avoid auto-restart loops after crash
    const [stalled] = await pool.query("SELECT id FROM encode_jobs WHERE status='encoding'");
    if (stalled.length > 0) {
      const ids = stalled.map(j => j.id);
      await pool.query(
        "UPDATE encode_jobs SET status='cancelled', error='Interrompu par redémarrage serveur — relancez manuellement si nécessaire', ended_at=NOW() WHERE status='encoding'"
      );
      logger.warn('encoder', `Marked ${stalled.length} stalled job(s) as cancelled after restart: [${ids.join(', ')}]`);
      broadcast('job_update', { recovered: true, count: stalled.length, ids });
    }
  } catch (e) {
    logger.error('encoder', `Failed to recover stalled jobs: ${e.message}`);
  }
}

/* ─── Public API ─────────────────────────────────────────────── */

async function enqueue(video_id, presetId, replaceOriginal = false, opts = {}) {
  const container = (typeof opts === 'object') ? (opts.container || 'auto') : 'auto';
  const downscale = (typeof opts === 'object') ? (opts.downscale || '') : '';
  const tonemap = (typeof opts === 'object') ? (!!opts.tonemap) : false;
  const force = (typeof opts === 'object') ? (!!opts.force) : false;

  const caps = await gpuDetect.detectAll();
  const preset = caps.presets.find(p => p.id === presetId);
  if (!preset) throw new Error(`Unknown preset: ${presetId}`);

  // Clone preset and apply custom CQ if provided (avoids mutating cached preset)
  const presetToStore = opts.customCq != null ? { ...preset, cq: opts.customCq } : preset;

  const pool = db.getPool();
  const [[video]] = await pool.query('SELECT size, codec, encode_skip FROM videos WHERE id=?', [video_id]);
  if (!video) throw new Error(`Video ${video_id} not found`);
  const fileSize = video.size || 0;

  // ── Smart skip: don't re-encode if already in target codec ──
  const currentCodec = (video.codec || '').toLowerCase();
  const targetCodec = preset.codec; // 'h265' or 'av1'
  const codecMatch = (
    (targetCodec === 'h265' && (currentCodec === 'hevc' || currentCodec === 'h265')) ||
    (targetCodec === 'av1'  && currentCodec === 'av1')
  );
  if (codecMatch) {
    logger.info('encoder', `Skip video ${video_id}: already ${currentCodec} (target: ${targetCodec})`);
    return { skipped: true, video_id, reason: `already ${currentCodec}` };
  }

  // ── Skip videos flagged by size guard (unless force) ──
  if (video.encode_skip && !force) {
    logger.info('encoder', `Skip video ${video_id}: previously flagged (encode output was larger)`);
    return { skipped: true, video_id, reason: 'encodage ignoré (résultat plus gros)' };
  }

  // Clear skip flag when explicitly encoding (force or first attempt)
  if (video.encode_skip && force) {
    await pool.query('UPDATE videos SET encode_skip = 0 WHERE id = ?', [video_id]);
  }

  const encodeOpts = JSON.stringify({ container, downscale, tonemap });
  const [result] = await pool.query(
    "INSERT INTO encode_jobs (video_id, preset_id, preset_json, replace_original, encode_options, status, file_size_before) VALUES (?,?,?,?,?,?,?)",
    [video_id, presetId, JSON.stringify(presetToStore), replaceOriginal ? 1 : 0, encodeOpts, 'pending', fileSize]
  );
  const id = result.insertId;
  broadcast('job_update', { id, status: 'pending', video_id, preset: presetToStore.label });
  logger.info('encoder', `Job #${id} queued: video ${video_id}, preset ${preset.label}`);
  setImmediate(processQueue);
  return id;
}

async function enqueueBatch(videoIds, presetId, replaceOriginal = false, opts = {}) {
  const results = { jobs: [], skipped: [] };

  // Resolve preset once for the whole batch (avoid N redundant detectAll calls)
  const caps = await gpuDetect.detectAll();
  const preset = caps.presets.find(p => p.id === presetId);
  if (!preset) throw new Error(`Unknown preset: ${presetId}`);
  const presetToStore = opts.customCq != null ? { ...preset, cq: opts.customCq } : preset;

  const container = (typeof opts === 'object') ? (opts.container || 'auto') : 'auto';
  const downscale = (typeof opts === 'object') ? (opts.downscale || '') : '';
  const tonemap   = (typeof opts === 'object') ? (!!opts.tonemap) : false;
  const force     = (typeof opts === 'object') ? (!!opts.force) : false;

  const pool = db.getPool();

  // Batch-fetch all video metadata in one query instead of N individual SELECTs
  const ph = videoIds.map(() => '?').join(',');
  const [videos] = await pool.query(
    `SELECT id, size, codec, encode_skip FROM videos WHERE id IN (${ph})`, videoIds
  );
  const videoMap = new Map(videos.map(v => [v.id, v]));

  const toInsert = []; // { video_id, fileSize }
  const targetCodec = preset.codec;

  for (const vid of videoIds) {
    const video = videoMap.get(vid);
    if (!video) { results.skipped.push({ skipped: true, video_id: vid, reason: 'not found' }); continue; }

    // Smart skip: already in target codec
    const currentCodec = (video.codec || '').toLowerCase();
    const codecMatch = (
      (targetCodec === 'h265' && (currentCodec === 'hevc' || currentCodec === 'h265')) ||
      (targetCodec === 'av1'  && currentCodec === 'av1')
    );
    if (codecMatch) {
      results.skipped.push({ skipped: true, video_id: vid, reason: `already ${currentCodec}` });
      continue;
    }

    // Skip flagged videos (unless force)
    if (video.encode_skip && !force) {
      results.skipped.push({ skipped: true, video_id: vid, reason: 'encode_skip' });
      continue;
    }
    if (video.encode_skip && force) {
      await pool.query('UPDATE videos SET encode_skip = 0 WHERE id = ?', [vid]);
    }

    toInsert.push({ video_id: vid, fileSize: video.size || 0 });
  }

  // Bulk INSERT all qualifying jobs in a single query
  if (toInsert.length > 0) {
    const encodeOpts = JSON.stringify({ container, downscale, tonemap });
    const presetJson = JSON.stringify(presetToStore);
    const values = toInsert.map(j =>
      [j.video_id, presetId, presetJson, replaceOriginal ? 1 : 0, encodeOpts, 'pending', j.fileSize]
    );
    const valPh = values.map(() => '(?,?,?,?,?,?,?)').join(',');
    const flat = values.flat();
    const [insertResult] = await pool.query(
      `INSERT INTO encode_jobs (video_id, preset_id, preset_json, replace_original, encode_options, status, file_size_before) VALUES ${valPh}`,
      flat
    );

    // Broadcast each new job for SSE
    const firstId = insertResult.insertId;
    for (let i = 0; i < toInsert.length; i++) {
      const jobId = firstId + i;
      results.jobs.push(jobId);
      broadcast('job_update', { id: jobId, status: 'pending', video_id: toInsert[i].video_id, preset: presetToStore.label });
    }
    logger.info('encoder', `Batch enqueued ${toInsert.length} job(s) for preset ${preset.label}`);
    setImmediate(processQueue);
  }

  if (results.skipped.length > 0) {
    logger.info('encoder', `Batch skipped ${results.skipped.length} video(s)`);
  }
  return results;
}

function cancelJob(jobId) {
  const entry = active.get(jobId);
  if (entry) {
    entry.cancel();
    logger.info('encoder', `Job #${jobId} cancel requested`);
    return true;
  }
  // If not in active map, it might be a pending job — cancel it in DB directly
  db.getPool().query(
    "UPDATE encode_jobs SET status='cancelled', ended_at=NOW() WHERE id=? AND status IN ('pending','encoding')",
    [jobId]
  ).then(([r]) => {
    if (r.affectedRows > 0) broadcast('job_update', { id: jobId, status: 'cancelled' });
  }).catch(() => {});
  return true;
}

async function cancelPending() {
  const pool = db.getPool();
  const [result] = await pool.query("UPDATE encode_jobs SET status='cancelled', ended_at=NOW() WHERE status='pending'");
  if (result.affectedRows > 0) logger.info('encoder', `Cancelled ${result.affectedRows} pending job(s)`);
  return result.affectedRows;
}

async function cancelAll() {
  const pool = db.getPool();
  // 1. Cancel all pending jobs in DB
  const [pendingResult] = await pool.query("UPDATE encode_jobs SET status='cancelled', ended_at=NOW() WHERE status='pending'");
  let total = pendingResult.affectedRows;

  // 2. Kill all actively encoding ffmpeg processes
  const activeIds = [...active.keys()];
  for (const [jobId, entry] of active.entries()) {
    try { entry.cancel(); } catch { /* already cancelled */ }
    // Immediately mark in DB as cancelled (don't wait for processJob to handle it)
    await pool.query(
      "UPDATE encode_jobs SET status='cancelled', ended_at=NOW(), error='Annulé par l\'utilisateur' WHERE id=? AND status='encoding'",
      [jobId]
    ).catch(() => {});
    total++;
  }

  if (total > 0) {
    logger.info('encoder', `Cancelled ALL: ${pendingResult.affectedRows} pending + ${activeIds.length} encoding job(s)`);
    broadcast('job_update', { cancelledAll: true });
  }
  return total;
}

async function forceKillJob(jobId) {
  const entry = active.get(jobId);
  if (entry && entry.proc) {
    try { entry.proc.kill('SIGKILL'); } catch { /* process already exited */ }
    logger.warn('encoder', `Job #${jobId} force-killed (SIGKILL)`);
  }
  // Also try to kill by PID pattern (orphan ffmpeg for this job)
  let orphansKilled = 0;
  try {
    const { execSync } = require('child_process');
    const pids = execSync(`pgrep -f 'ffmpeg.*\\.tmp\\.${jobId}\\.' 2>/dev/null || true`).toString().trim();
    if (pids) {
      for (const pid of pids.split('\n').filter(Boolean)) {
        try { process.kill(parseInt(pid, 10), 'SIGKILL'); orphansKilled++; } catch { /* process already exited */ }
      }
      logger.warn('encoder', `Force-killed ${orphansKilled} orphan ffmpeg process(es) for job #${jobId}`);
    }
  } catch { /* non-critical */ }
  // Mark as ERROR (not 'cancelled') so the user can distinguish a force-kill
  // (admin action on a hung process) from a regular cancellation. Errors stay
  // in the queue for retry/inspection while cancelled jobs can be cleared.
  const errMsg = `Force-killed by admin (SIGKILL). Process was unresponsive.`;
  const pool = db.getPool();
  await pool.query(
    "UPDATE encode_jobs SET status='error', ended_at=NOW(), error=? WHERE id=? AND status IN ('pending','encoding')",
    [errMsg, jobId]
  );
  active.delete(jobId);
  clearProgressThrottle(jobId);
  broadcast('job_update', { id: jobId, status: 'error', error: errMsg });
  logger.warn('encoder', `Job #${jobId}: ${errMsg}`);
  return true;
}

async function retryJob(jobId) {
  const pool = db.getPool();
  const [[job]] = await pool.query('SELECT * FROM encode_jobs WHERE id=?', [jobId]);
  if (!job || !['error', 'cancelled'].includes(job.status)) throw new Error('Cannot retry this job');
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
  if (job.output_path) { try { await fsp.unlink(job.output_path); } catch { /* cleanup — file may not exist */ } }
  try { await fsp.unlink(path.join(LOG_DIR, `job_${jobId}.log`)); } catch { /* cleanup — file may not exist */ }
  await pool.query('DELETE FROM encode_jobs WHERE id=?', [jobId]);
  return true;
}

async function clearFinished() {
  const pool = db.getPool();
  // Delete done + cancelled jobs — keep 'error' jobs so the fail tag persists
  const [result] = await pool.query("DELETE FROM encode_jobs WHERE status IN ('done','cancelled')");
  if (result.affectedRows > 0) {
    logger.info('encoder', `Cleared ${result.affectedRows} finished job(s) from queue (errors preserved)`);
    broadcast('job_update', { cleared: true });
  }
  return result.affectedRows;
}

function setWorkerCount(n) {
  workerCount = Math.max(1, Math.min(8, n));
  logger.info('encoder', `Worker count set to ${workerCount}`);
  // Broadcast so the UI reflects the change without a poll
  broadcast('encoder_state', { paused, workerCount, activeJobs: active.size });
  setImmediate(processQueue);
  return workerCount;
}

function getStatus() {
  return {
    running, paused, workerCount, activeJobs: active.size,
    active: [...active.entries()].map(([id, e]) => ({ id, video_id: e.video_id })),
  };
}

async function getHistory(limit = 50, offset = 0) {
  const pool = db.getPool();

  // ── 1. Accurate counts from DB (unaffected by LIMIT) ──────────
  const [[countRow]] = await pool.query(
    `SELECT COUNT(*) as total,
            SUM(status='pending')   as pending,
            SUM(status='encoding')  as encoding,
            SUM(status='done')      as done,
            SUM(status='error')     as errors,
            SUM(status='cancelled') as cancelled
     FROM encode_jobs`
  );
  const counts = {
    total:     Number(countRow.total),
    pending:   Number(countRow.pending   || 0),
    encoding:  Number(countRow.encoding  || 0),
    done:      Number(countRow.done      || 0),
    error:     Number(countRow.errors    || 0),
    cancelled: Number(countRow.cancelled || 0),
  };

  // ── 2. Always fetch currently-encoding jobs (they may fall outside the LIMIT) ──
  const [encodingRows] = await pool.query(
    `SELECT j.*, v.filename, v.file_path, v.folder
     FROM encode_jobs j LEFT JOIN videos v ON j.video_id = v.id
     WHERE j.status = 'encoding'
     ORDER BY j.created_at ASC`
  );
  const encodingIds = new Set(encodingRows.map(r => r.id));

  // ── 3. Paginated rows (most recent first) ─────────────────────
  const [rows] = await pool.query(
    `SELECT j.*, v.filename, v.file_path, v.folder
     FROM encode_jobs j LEFT JOIN videos v ON j.video_id = v.id
     ORDER BY
       FIELD(j.status, 'encoding', 'pending', 'error', 'cancelled', 'done') ASC,
       j.created_at DESC
     LIMIT ? OFFSET ?`,
    [limit, offset]
  );

  // ── 4. Merge: encoding rows first, then the rest (de-duped) ───
  const merged = [...encodingRows];
  for (const r of rows) {
    if (!encodingIds.has(r.id)) merged.push(r);
  }

  return { rows: merged, total: counts.total, counts };
}

async function getJobLog(jobId) {
  const logPath = path.join(LOG_DIR, `job_${jobId}.log`);
  try { return await fsp.readFile(logPath, 'utf-8'); }
  catch { return null; }
}

async function start() {
  running = true;
  // Wait for the MySQL pool to actually answer before doing anything.
  // Without this, the first processQueue tick races MySQL's TCP handshake
  // and produces a benign-but-spammy "Queue error: connect ETIMEDOUT" on
  // every restart. We retry up to ~30 s with exponential backoff.
  {
    const pool = db.getPool();
    let delay = 250;
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        await pool.query('SELECT 1');
        if (attempt > 1) logger.info('encoder', `MySQL pool ready after ${attempt} attempt(s)`);
        break;
      } catch (e) {
        if (attempt === 8) {
          logger.error('encoder', `MySQL pool not ready after retries: ${e.message} — proceeding anyway`);
        } else {
          logger.warn('encoder', `MySQL not ready (attempt ${attempt}/8): ${e.code || e.message} — retrying in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          delay = Math.min(delay * 2, 5000);
        }
      }
    }
  }
  // Restore persisted pause state — survives server restart so the user
  // doesn't get a flood of jobs starting on boot if they had paused before.
  try {
    const persisted = await db.getSetting('queue_paused', '0');
    paused = persisted === '1' || persisted === 1 || persisted === true;
    if (paused) logger.info('encoder', 'Queue is PAUSED (restored from settings)');
  } catch (e) {
    logger.warn('encoder', `Could not restore pause state: ${e.message}`);
  }
  await recoverStalledJobs();
  setImmediate(processQueue);
  // Watchdog: periodically nudge the queue in case it got stuck
  if (_watchdogTimer) clearInterval(_watchdogTimer);
  _watchdogTimer = setInterval(() => {
    if (running && active.size < workerCount) {
      setImmediate(processQueue);
    }
  }, 10000);
  // Periodic encoder_state broadcast — keeps the UI's pause/worker indicator
  // in sync even across SSE reconnects, and lets clients reconcile state
  // without needing a polling endpoint.
  if (_stateBroadcastTimer) clearInterval(_stateBroadcastTimer);
  _stateBroadcastTimer = setInterval(() => {
    if (sseClients.size === 0) return;
    broadcast('encoder_state', { paused, workerCount, activeJobs: active.size, running });
  }, 15000);
  logger.info('encoder', `Encoder started with ${workerCount} worker(s)`);
}

async function stop() {
  running = false;
  if (_watchdogTimer) { clearInterval(_watchdogTimer); _watchdogTimer = null; }
  if (_stateBroadcastTimer) { clearInterval(_stateBroadcastTimer); _stateBroadcastTimer = null; }
  const jobIds = [...active.keys()];
  // Mark all active jobs as cancelled in DB BEFORE killing ffmpeg
  // This ensures DB state is correct even if the process dies immediately after
  const pool = db.getPool();
  for (const jobId of jobIds) {
    try {
      await pool.query(
        "UPDATE encode_jobs SET status='cancelled', ended_at=NOW(), error='Arrêt du serveur' WHERE id=? AND status='encoding'",
        [jobId]
      );
    } catch { /* non-critical */ }
  }
  // Now kill ffmpeg processes
  for (const e of active.values()) {
    try { e.cancel(); } catch { /* already cancelled */ }
  }
  logger.info('encoder', `Encoder stopped — cancelled ${active.size} active job(s): [${jobIds.join(', ')}]`);
}

function setPaused(value) {
  paused = !!value;
  logger.info('encoder', paused ? 'Queue PAUSED by user' : 'Queue RESUMED by user');
  // Persist so restart preserves pause state
  db.setSetting('queue_paused', paused ? '1' : '0').catch((e) => {
    logger.warn('encoder', `Failed to persist pause state: ${e.message}`);
  });
  broadcast('encoder_state', { paused });
  if (!paused) setImmediate(processQueue); // resume processing
  return paused;
}

function isPaused() { return paused; }

module.exports = {
  enqueue, enqueueBatch, cancelJob, cancelPending, cancelAll, forceKillJob, retryJob, deleteJob, clearFinished,
  setWorkerCount, getStatus, getHistory, getJobLog,
  addSSEClient, removeSSEClient, broadcast,
  start, stop, processQueue, setPaused, isPaused,
};
