/**
 * services/encoder.js — Video encoding engine
 *
 * Queue-based multi-worker encoder with GPU allocation,
 * progress tracking, and SSE event broadcast.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const db = require('../db');
const gpuDetect = require('./gpu-detect');

const ENCODE_DIR = process.env.ENCODE_DIR || path.join(__dirname, '..', 'data', 'encoded');
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

/* ─── Build ffmpeg args ──────────────────────────────────────── */
function buildArgs(preset, inFile, outFile) {
  const args = ['-y', '-hide_banner', '-progress', 'pipe:1'];
  const isAv1 = preset.codec === 'av1';

  switch (preset.type) {
    case 'nvidia':
    case 'nvidia_group': {
      // hwaccel decode + encode
      const gpuIdx = preset.gpuIndex ?? pickNvidiaGpu(preset);
      args.push('-hwaccel', 'cuda', '-hwaccel_device', String(gpuIdx), '-hwaccel_output_format', 'cuda');
      args.push('-i', inFile, '-c:v', preset.encoder);
      args.push('-gpu', String(gpuIdx));
      if (isAv1) {
        args.push('-preset', 'p4', '-cq', '30', '-b:v', '0');
      } else {
        args.push('-preset', 'p4', '-cq', '23', '-b:v', '0');
      }
      break;
    }
    case 'vaapi':
    case 'vaapi_group': {
      const dev = preset.renderDevice || pickVaapiDevice(preset);
      args.push('-init_hw_device', `vaapi=va:${dev}`, '-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi', '-filter_hw_device', 'va');
      args.push('-i', inFile, '-vf', 'format=nv12|vaapi,hwupload');
      args.push('-c:v', preset.encoder);
      isAv1 ? args.push('-rc_mode', 'CQP', '-global_quality', '30')
             : args.push('-rc_mode', 'CQP', '-global_quality', '23');
      break;
    }
    case 'qsv':
      args.push('-hwaccel', 'qsv', '-i', inFile, '-c:v', preset.encoder, '-global_quality', isAv1 ? '30' : '23', '-preset', 'medium');
      break;
    default: // cpu
      args.push('-i', inFile, '-c:v', preset.encoder);
      if (preset.encoder === 'libx265') args.push('-crf', '23', '-preset', 'medium');
      else if (preset.encoder === 'libsvtav1') args.push('-crf', '30', '-preset', '6');
      else if (preset.encoder === 'libaom-av1') args.push('-crf', '30', '-cpu-used', '4');
      break;
  }

  args.push('-c:a', 'copy', '-movflags', '+faststart', outFile);
  return args;
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
  if (preset.type === 'nvidia') return `nvidia_${preset.gpuIndex}`;
  if (preset.type === 'nvidia_group') return `nvidia_${pickNvidiaGpu(preset)}`;
  if (preset.type === 'vaapi') return `vaapi_${preset.renderDevice}`;
  if (preset.type === 'vaapi_group') return `vaapi_${pickVaapiDevice(preset)}`;
  if (preset.type === 'qsv') return 'qsv_0';
  return 'cpu';
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

/* ─── Core encode worker ─────────────────────────────────────── */
async function processJob(job) {
  const pool = db.getPool();
  const [[video]] = await pool.query('SELECT * FROM videos WHERE id=?', [job.video_id]);
  if (!video) {
    await pool.query("UPDATE encode_jobs SET status='error', error='Video not found', ended_at=NOW() WHERE id=?", [job.id]);
    broadcast('job_update', { id: job.id, status: 'error', error: 'Video not found' });
    return;
  }

  // Parse preset from DB JSON
  let preset;
  try { preset = JSON.parse(job.preset_json); }
  catch { preset = { encoder: 'libx265', codec: 'h265', type: 'cpu', id: 'cpu_h265' }; }

  const inFile = video.file_path;
  const ext = preset.codec === 'av1' ? '.mkv' : '.mp4';
  const baseName = path.basename(inFile, path.extname(inFile));
  const replaceOriginal = !!job.replace_original;

  await fsp.mkdir(ENCODE_DIR, { recursive: true });
  const outFile = replaceOriginal
    ? path.join(ENCODE_DIR, `${baseName}_enc_${job.id}${ext}`)
    : path.join(ENCODE_DIR, `${baseName}_${preset.codec}${ext}`);

  const devKey = devKeyFor(preset);
  lockDevice(devKey);
  await pool.query("UPDATE encode_jobs SET status='encoding', started_at=NOW() WHERE id=?", [job.id]);
  broadcast('job_update', { id: job.id, status: 'encoding', video_id: job.video_id });

  const args = buildArgs(preset, inFile, outFile);
  console.log(`[enc] #${job.id} ffmpeg ${args.join(' ').substring(0, 120)}…`);

  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let cancelled = false;
    let lastProgress = {};

    active.set(job.id, {
      proc,
      video_id: job.video_id,
      cancel() { cancelled = true; proc.kill('SIGTERM'); setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000); },
    });

    // Parse ffmpeg progress
    proc.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        const [k, v] = line.split('=').map(s => s.trim());
        if (k && v) lastProgress[k] = v;
      }
      if (lastProgress.out_time_ms && video.duration) {
        const pct = Math.min(100, Math.round((parseInt(lastProgress.out_time_ms, 10) / 1e6 / video.duration) * 100));
        broadcast('job_progress', { id: job.id, percent: pct, speed: lastProgress.speed || '', fps: lastProgress.fps || '' });
      }
    });

    let stderrBuf = '';
    proc.stderr.on('data', (d) => { stderrBuf += d.toString(); if (stderrBuf.length > 50000) stderrBuf = stderrBuf.slice(-30000); });

    proc.on('close', async (code) => {
      active.delete(job.id);
      unlockDevice(devKey);

      if (cancelled) {
        await pool.query("UPDATE encode_jobs SET status='cancelled', ended_at=NOW() WHERE id=?", [job.id]);
        broadcast('job_update', { id: job.id, status: 'cancelled' });
        try { await fsp.unlink(outFile); } catch {}
        resolve();
        return;
      }

      if (code !== 0) {
        const errTail = stderrBuf.slice(-500);
        await pool.query("UPDATE encode_jobs SET status='error', error=?, ended_at=NOW() WHERE id=?", [errTail, job.id]);
        broadcast('job_update', { id: job.id, status: 'error', error: errTail });
        try { await fsp.unlink(outFile); } catch {}
        resolve();
        return;
      }

      // Success — optionally replace original
      let finalPath = outFile;
      let newSize = 0;
      try {
        const st = await fsp.stat(outFile);
        newSize = st.size;
      } catch {}

      if (replaceOriginal) {
        try {
          await fsp.unlink(inFile);
          const targetPath = path.join(path.dirname(inFile), `${baseName}${ext}`);
          await moveFile(outFile, targetPath);
          finalPath = targetPath;
          await pool.query('UPDATE videos SET file_path=?, size=?, codec=? WHERE id=?',
            [targetPath, newSize, preset.codec === 'av1' ? 'av1' : 'hevc', job.video_id]);
        } catch (e) {
          console.error(`[enc] #${job.id} replace-original failed:`, e.message);
        }
      }

      await pool.query("UPDATE encode_jobs SET status='done', output_path=?, output_size=?, ended_at=NOW() WHERE id=?",
        [finalPath, newSize, job.id]);
      broadcast('job_update', { id: job.id, status: 'done', output_path: finalPath, output_size: newSize });
      console.log(`[enc] #${job.id} done → ${finalPath} (${(newSize / 1e6).toFixed(1)} MB)`);
      resolve();
    });
  });
}

/* ─── Queue processor ────────────────────────────────────────── */
async function processQueue() {
  if (_processing || !running) return;
  _processing = true;
  try {
    const pool = db.getPool();
    while (running && active.size < workerCount) {
      const [rows] = await pool.query("SELECT * FROM encode_jobs WHERE status='pending' ORDER BY created_at ASC LIMIT 1");
      if (!rows.length) break;
      const job = rows[0];
      processJob(job).catch(e => console.error(`[enc] #${job.id} crash:`, e.message)).finally(() => {
        setImmediate(processQueue);
      });
    }
  } catch (e) {
    console.error('[enc] queue error:', e.message);
  }
  _processing = false;
}

/* ─── Public API ─────────────────────────────────────────────── */

async function enqueue(video_id, presetId, replaceOriginal = false) {
  const caps = await gpuDetect.detectAll();
  const preset = caps.presets.find(p => p.id === presetId);
  if (!preset) throw new Error(`Unknown preset: ${presetId}`);

  const pool = db.getPool();
  const [result] = await pool.query(
    "INSERT INTO encode_jobs (video_id, preset_id, preset_json, replace_original, status) VALUES (?,?,?,?,?)",
    [video_id, presetId, JSON.stringify(preset), replaceOriginal ? 1 : 0, 'pending']
  );
  const id = result.insertId;
  broadcast('job_update', { id, status: 'pending', video_id, preset: preset.label });
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
  if (entry) { entry.cancel(); return true; }
  return false;
}

async function cancelPending() {
  const pool = db.getPool();
  const [result] = await pool.query("UPDATE encode_jobs SET status='cancelled', ended_at=NOW() WHERE status='pending'");
  return result.affectedRows;
}

async function retryJob(jobId) {
  const pool = db.getPool();
  const [[job]] = await pool.query('SELECT * FROM encode_jobs WHERE id=?', [jobId]);
  if (!job || !['failed', 'error', 'cancelled'].includes(job.status)) throw new Error('Cannot retry');
  await pool.query("UPDATE encode_jobs SET status='pending', error=NULL, started_at=NULL, ended_at=NULL, output_path=NULL, output_size=NULL WHERE id=?", [jobId]);
  broadcast('job_update', { id: jobId, status: 'pending' });
  setImmediate(processQueue);
  return jobId;
}

async function deleteJob(jobId) {
  const pool = db.getPool();
  const [[job]] = await pool.query('SELECT * FROM encode_jobs WHERE id=?', [jobId]);
  if (!job) throw new Error('Job not found');
  if (job.status === 'encoding') cancelJob(jobId);
  // Try to clean up output file
  if (job.output_path) { try { await fsp.unlink(job.output_path); } catch {} }
  await pool.query('DELETE FROM encode_jobs WHERE id=?', [jobId]);
  return true;
}

function setWorkerCount(n) {
  workerCount = Math.max(1, Math.min(8, n));
  setImmediate(processQueue);
  return workerCount;
}

function getStatus() {
  return {
    running,
    workerCount,
    activeJobs: active.size,
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

function start() { running = true; setImmediate(processQueue); }
function stop()  { running = false; for (const e of active.values()) e.cancel(); }

module.exports = {
  enqueue, enqueueBatch, cancelJob, cancelPending, retryJob, deleteJob,
  setWorkerCount, getStatus, getHistory,
  addSSEClient, broadcast,
  start, stop, processQueue,
};
