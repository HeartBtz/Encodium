/**
 * scanner.js — Encodium video scanner & thumbnail generator
 *
 * Scans MEDIA_DIR for video files, indexes them in the database,
 * extracts metadata via ffprobe, and generates thumbnails.
 *
 * Directory layout:
 *   MEDIA_DIR/
 *   ├── FolderName/        ← folder category
 *   │   ├── video.mp4
 *   │   └── sub/dir/video.mkv
 *   └── video_at_root.mp4  ← folder = '(root)'
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { getAllExistingPaths, batchInsertVideos, updateVideoMeta, updateVideoThumb, pool } = require('./db');
require('dotenv').config();

const logger = require('./services/logger');

const MEDIA_DIR = process.env.MEDIA_DIR || '/home/coder/Videos';
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv', '.flv', '.m4v', '.ts', '.3gp']);
const THUMB_DIR  = process.env.THUMB_DIR || path.join(__dirname, 'data', 'thumbs');

if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

let ffmpeg, ffprobeBin;
try { ffmpeg = require('fluent-ffmpeg'); } catch { ffmpeg = null; }
try { const fp = require('ffprobe-static'); if (ffmpeg) ffmpeg.setFfprobePath(fp.path); ffprobeBin = fp.path; } catch {}

/* ── Scan state ──────────────────────────────────────────── */
let scanProgress = {
  running: false, total: 0, done: 0, skipped: 0, errors: 0,
  startedAt: null, finishedAt: null, lastError: null, cancelled: false, currentFolder: null,
};
let cancelRequested = false;

/* ── Enrich state ────────────────────────────────────────── */
let enrichProgress = { running: false, total: 0, done: 0, errors: 0, startedAt: null, finishedAt: null };

/* ── Thumbs state ────────────────────────────────────────── */
let thumbsProgress = { running: false, total: 0, done: 0, errors: 0, startedAt: null, finishedAt: null };

function getProgress() { return { ...scanProgress }; }
function getEnrichProgress() { return { ...enrichProgress }; }
function getThumbsProgress() { return { ...thumbsProgress }; }

function cancelScan() {
  if (!scanProgress.running) return false;
  cancelRequested = true;
  return true;
}

// Backwards compatibility: some callers expect `getState()`
function getState() { return getProgress(); }

/* ── ffprobe helpers ─────────────────────────────────────── */
function parseFraction(str) {
  if (!str) return null;
  const parts = str.split('/').map(Number);
  if (parts.length !== 2 || !parts[1]) return parts[0] || null;
  return Math.round((parts[0] / parts[1]) * 100) / 100;
}

function getVideoMeta(filePath) {
  return new Promise((resolve) => {
    if (!ffmpeg) return resolve(null);
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err || !meta) return resolve(null);
      const video = meta.streams?.find(s => s.codec_type === 'video');
      const audio = meta.streams?.find(s => s.codec_type === 'audio');
      resolve({
        duration:        meta.format?.duration        ? Number(meta.format.duration)                      : null,
        codec:           video?.codec_name            || null,
        width:           video?.width                 || null,
        height:          video?.height                || null,
        bitrate:         meta.format?.bit_rate        ? Math.round(Number(meta.format.bit_rate) / 1000)   : null,
        fps:             parseFraction(video?.avg_frame_rate),
        audioCodec:      audio?.codec_name            || null,
        audioSampleRate: audio?.sample_rate           ? Number(audio.sample_rate) : null,
        audioChannels:   audio?.channels              || null,
      });
    });
  });
}

/* ── Thumbnail generation ────────────────────────────────── */
const thumbGenerating = new Map();

function generateThumb(filePath, videoId) {
  if (!ffmpeg) return Promise.resolve(null);
  const thumbName = `v_${videoId}.jpg`;
  const thumbPath = path.join(THUMB_DIR, thumbName);
  if (fs.existsSync(thumbPath)) return Promise.resolve(thumbPath);
  if (thumbGenerating.has(thumbPath)) return thumbGenerating.get(thumbPath);

  const p = new Promise((resolve) => {
    try {
      ffmpeg(filePath)
        .on('error', () => { thumbGenerating.delete(thumbPath); resolve(null); })
        .on('end',   () => { thumbGenerating.delete(thumbPath); resolve(thumbPath); })
        .screenshots({ count: 1, timemarks: ['10%'], folder: THUMB_DIR, filename: thumbName, size: '320x?' });
    } catch { thumbGenerating.delete(thumbPath); resolve(null); }
  });
  thumbGenerating.set(thumbPath, p);
  return p;
}

/* ── Concurrency & directory walker ──────────────────────── */
async function runConcurrent(tasks, concurrency) {
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) { const t = queue.shift(); if (t) await t(); }
  });
  await Promise.all(workers);
}

async function* walkFiles(dirPath) {
  let entries;
  try { entries = await fs.promises.readdir(dirPath, { withFileTypes: true }); } catch { return; }
  const subdirs = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) subdirs.push(fullPath);
    else if (entry.isFile()) yield fullPath;
  }
  for (const sub of subdirs) yield* walkFiles(sub);
}

/* ── Main scanner ────────────────────────────────────────── */
const BATCH_SIZE = 500;

async function scanDirectory(onProgress = null) {
  if (scanProgress.running) throw new Error('Scan already in progress');
  cancelRequested = false;
  scanProgress = {
    running: true, total: 0, done: 0, skipped: 0, errors: 0,
    startedAt: new Date().toISOString(), finishedAt: null, lastError: null,
    cancelled: false, currentFolder: null,
  };
  const notify = () => { if (onProgress) try { onProgress({ ...scanProgress }); } catch {} };

  try {
    logger.info('scanner', `Starting scan of ${MEDIA_DIR}`);
    if (!fs.existsSync(MEDIA_DIR)) {
      logger.error('scanner', `MEDIA_DIR not found: ${MEDIA_DIR}`);
      throw new Error(`MEDIA_DIR not found: ${MEDIA_DIR}`);
    }

    const existingPaths = await getAllExistingPaths();
    logger.info('scanner', `${existingPaths.size} files already in database`);
    const entries = fs.readdirSync(MEDIA_DIR, { withFileTypes: true });

    // Process top-level directories as folders
    const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));
    // Process root-level files
    const rootFiles = entries.filter(e => e.isFile() && !e.name.startsWith('.'));

    // Helper to process files from a folder
    const processFolder = async (folderName, folderPath) => {
      scanProgress.currentFolder = folderName;
      notify();
      let batch = [];
      const flush = async () => {
        if (!batch.length) return;
        await batchInsertVideos(batch);
        scanProgress.done += batch.length;
        batch = [];
        notify();
      };

      for await (const filePath of walkFiles(folderPath)) {
        if (cancelRequested) break;
        const ext = path.extname(filePath).toLowerCase();
        if (!VIDEO_EXTS.has(ext)) continue;
        if (existingPaths.has(filePath)) { scanProgress.skipped++; continue; }

        try {
          const stat = await fs.promises.stat(filePath);
          scanProgress.total++;
          batch.push([folderName, path.basename(filePath), filePath, stat.size]);
          if (batch.length >= BATCH_SIZE) await flush();
        } catch (e) {
          scanProgress.errors++;
          scanProgress.lastError = e.message;
        }
      }
      await flush();
    };

    // Scan each subdirectory
    for (const dir of dirs) {
      if (cancelRequested) break;
      await processFolder(dir.name, path.join(MEDIA_DIR, dir.name));
    }

    // Scan root-level video files
    if (!cancelRequested && rootFiles.length) {
      let batch = [];
      const flush = async () => {
        if (!batch.length) return;
        await batchInsertVideos(batch);
        scanProgress.done += batch.length;
        batch = [];
        notify();
      };
      for (const f of rootFiles) {
        if (cancelRequested) break;
        const ext = path.extname(f.name).toLowerCase();
        if (!VIDEO_EXTS.has(ext)) continue;
        const filePath = path.join(MEDIA_DIR, f.name);
        if (existingPaths.has(filePath)) { scanProgress.skipped++; continue; }
        try {
          const stat = await fs.promises.stat(filePath);
          scanProgress.total++;
          batch.push(['(root)', f.name, filePath, stat.size]);
          if (batch.length >= BATCH_SIZE) await flush();
        } catch (e) {
          scanProgress.errors++;
          scanProgress.lastError = e.message;
        }
      }
      await flush();
    }

    scanProgress.running = false;
    scanProgress.cancelled = cancelRequested;
    scanProgress.currentFolder = null;
    scanProgress.finishedAt = new Date().toISOString();
    notify();
    if (cancelRequested) {
      logger.warn('scanner', 'Scan cancelled by user');
    } else {
      logger.success('scanner', `Scan complete: ${scanProgress.total} new, ${scanProgress.skipped} skipped, ${scanProgress.errors} errors`);
    }
    cancelRequested = false;
  } catch (e) {
    scanProgress.running = false;
    scanProgress.finishedAt = new Date().toISOString();
    scanProgress.lastError = e.message;
    logger.error('scanner', `Scan failed: ${e.message}`);
    throw e;
  }
}

/* ── Post-scan: enrich metadata with ffprobe ─────────────── */
async function enrichVideoMeta(concurrency = 3) {
  if (!ffmpeg) return;
  if (enrichProgress.running) { logger.warn('enrich', 'Enrichment already in progress'); return; }
  try {
    const [rows] = await pool.query(
      "SELECT id, file_path FROM videos WHERE codec IS NULL OR duration IS NULL LIMIT 2000"
    );
    if (!rows.length) { logger.info('enrich', 'No videos to enrich — all up to date'); return; }
    enrichProgress = { running: true, total: rows.length, done: 0, errors: 0, startedAt: new Date().toISOString(), finishedAt: null };
    logger.info('enrich', `Enriching metadata for ${rows.length} video(s)…`);
    const tasks = rows.map(row => async () => {
      try {
        const meta = await getVideoMeta(row.file_path);
        if (meta) await updateVideoMeta(row.id, meta);
      } catch { enrichProgress.errors++; }
      enrichProgress.done++;
    });
    await runConcurrent(tasks, concurrency);
    enrichProgress.running = false;
    enrichProgress.finishedAt = new Date().toISOString();
    logger.success('enrich', `Metadata enrichment complete (${rows.length} videos, ${enrichProgress.errors} errors)`);
  } catch (e) {
    enrichProgress.running = false;
    enrichProgress.finishedAt = new Date().toISOString();
    logger.error('enrich', `Enrichment failed: ${e.message}`);
  }
}

/* ── Post-scan: generate missing thumbnails ──────────────── */
async function generateMissingThumbs(limit = 5000, concurrency = 4) {
  if (thumbsProgress.running) { logger.warn('thumbs', 'Thumbnail generation already in progress'); return; }
  try {
    const [rows] = await pool.query(
      'SELECT id, file_path FROM videos WHERE thumb_path IS NULL ORDER BY id DESC LIMIT ?', [limit]
    );
    if (!rows.length) { logger.info('thumbs', 'No thumbnails to generate — all up to date'); return; }
    thumbsProgress = { running: true, total: rows.length, done: 0, errors: 0, startedAt: new Date().toISOString(), finishedAt: null };
    logger.info('thumbs', `Generating ${rows.length} thumbnail(s)…`);
    const tasks = rows.map(v => async () => {
      try {
        const tp = await generateThumb(v.file_path, v.id);
        if (tp) await updateVideoThumb(v.id, tp);
      } catch { thumbsProgress.errors++; }
      thumbsProgress.done++;
    });
    await runConcurrent(tasks, concurrency);
    thumbsProgress.running = false;
    thumbsProgress.finishedAt = new Date().toISOString();
    logger.success('thumbs', `Thumbnail generation complete (${rows.length} videos, ${thumbsProgress.errors} errors)`);
  } catch (e) {
    thumbsProgress.running = false;
    thumbsProgress.finishedAt = new Date().toISOString();
    logger.error('thumbs', `Thumbnail generation failed: ${e.message}`);
  }
}

module.exports = {
  MEDIA_DIR, THUMB_DIR, VIDEO_EXTS,
  scanDirectory, getProgress, cancelScan,
  getState, enrichVideoMeta, generateMissingThumbs, generateThumb,
  getEnrichProgress, getThumbsProgress,
};
