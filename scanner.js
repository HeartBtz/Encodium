/**
 * scanner.js — Encodium video scanner & thumbnail generator
 *
 * Scans all configured media source directories for video files, indexes
 * them in the database, and extracts metadata via ffprobe.
 * Thumbnails are generated on-demand when browsing the library (not during
 * the scan pipeline).
 *
 * Media sources are stored in the `media_sources` DB table and managed via
 * Settings → Sources in the UI or via the CLI.
 *
 * The folder category shown in the library is the first subdirectory
 * beneath each source root:
 *   /your/source/
 *   ├── FolderName/        ← folder category
 *   │   ├── video.mp4
 *   │   └── sub/dir/video.mkv
 *   └── video_at_root.mp4  ← folder = '(root)'
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getAllExistingPaths, batchInsertVideos, updateVideoMeta, updateVideoThumb, getPool, withIdleVideos } = require('./db');
require('dotenv').config({ override: true });

const logger = require('./services/logger');
const ffprobe = require('./services/ffprobe');
const { resolveMediaPath, contains } = require('./services/media-files');

// Legacy MEDIA_DIR kept for backwards compat (initial migration seed)
const LEGACY_MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, 'data', 'media');
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv', '.flv', '.m4v', '.ts', '.3gp']);
const THUMB_DIR  = process.env.THUMB_DIR || path.join(__dirname, 'data', 'thumbs');

if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

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

async function getVideoMeta(filePath) {
  await resolveMediaPath(filePath);
  const meta = await ffprobe.fullInfo(filePath);
  if (!meta) return null;
  const video = meta.streams?.find(s => s.codec_type === 'video');
  const audio = meta.streams?.find(s => s.codec_type === 'audio');
  return {
    duration:        meta.format?.duration        ? Number(meta.format.duration)                    : null,
    codec:           video?.codec_name            || null,
    width:           video?.width                 || null,
    height:          video?.height                || null,
    bitrate:         meta.format?.bit_rate        ? Math.round(Number(meta.format.bit_rate) / 1000) : null,
    fps:             parseFraction(video?.avg_frame_rate),
    audioCodec:      audio?.codec_name            || null,
    audioSampleRate: audio?.sample_rate           ? Number(audio.sample_rate) : null,
    audioChannels:   audio?.channels              || null,
  };
}

function runThumbnailFfmpeg(filePath, thumbPath, seekSeconds) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-protocol_whitelist', 'file,pipe', '-ss', String(seekSeconds), '-i', filePath,
      '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '3', thumbPath,
    ], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 30000, killSignal: 'SIGKILL' });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg thumbnail exited with ${code}`)));
  });
}

/* ── Thumbnail generation (on-demand, concurrency-limited) ── */
const thumbGenerating = new Map();
let thumbActive = 0;
const THUMB_MAX_CONCURRENT = 3;   // max simultaneous ffmpeg thumb processes
const thumbQueue = [];             // pending thumb requests

function _runNextThumb() {
  while (thumbActive < THUMB_MAX_CONCURRENT && thumbQueue.length) {
    const next = thumbQueue.shift();
    next();
  }
}

function generateThumb(filePath, videoId) {
  const thumbName = `v_${videoId}.jpg`;
  const thumbPath = path.join(THUMB_DIR, thumbName);
  if (fs.existsSync(thumbPath)) return Promise.resolve(thumbPath);
  if (thumbGenerating.has(thumbPath)) return thumbGenerating.get(thumbPath);
  if (thumbQueue.length >= 200) return Promise.resolve(null);

  const p = new Promise((resolve) => {
    async function doGenerate() {
      thumbActive++;
      try {
        await resolveMediaPath(filePath);
        const duration = await ffprobe.duration(filePath);
        const seekSeconds = duration > 0 ? Math.max(0, duration * 0.1) : 0;
        await runThumbnailFfmpeg(filePath, thumbPath, seekSeconds);
        resolve(thumbPath);
      } catch {
        try { await fs.promises.unlink(thumbPath); } catch { /* no partial thumbnail */ }
        resolve(null);
      } finally {
        thumbActive--;
        thumbGenerating.delete(thumbPath);
        _runNextThumb();
      }
    }
    if (thumbActive < THUMB_MAX_CONCURRENT) {
      doGenerate();
    } else {
      thumbQueue.push(doGenerate);
    }
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

/* ── Media Sources (multi-directory) ─────────────────────── */

async function getSources() {
  try {
    const pool = getPool();
    const [rows] = await pool.query('SELECT id, path, label, enabled FROM media_sources ORDER BY id');
    return rows;
  } catch {
    // DB not ready yet — return legacy env var as fallback
    if (fs.existsSync(LEGACY_MEDIA_DIR)) {
      return [{ id: 0, path: LEGACY_MEDIA_DIR, label: path.basename(LEGACY_MEDIA_DIR), enabled: 1 }];
    }
    return [];
  }
}

async function addSource(dirPath, label) {
  const pool = getPool();
  const [result] = await pool.query(
    'INSERT INTO media_sources (path, label) VALUES (?, ?)',
    [dirPath, label]
  );
  return { id: result.insertId, path: dirPath, label, enabled: 1 };
}

async function removeSource(id) {
  const pool = getPool();
  const [sources] = await pool.query('SELECT id, path FROM media_sources');
  const source = sources.find(s => s.id === id);
  if (!source) return;
  const remaining = sources.filter(s => s.id !== id);
  const [videos] = await pool.query('SELECT id, file_path FROM videos');
  // Literal path containment, not LIKE: '%' and '_' are legal filenames.
  const ids = videos.filter(v => contains(source.path, v.file_path) && !remaining.some(s => contains(s.path, v.file_path))).map(v => v.id);
  await withIdleVideos(ids, async conn => {
    await conn.query('DELETE FROM media_sources WHERE id=?', [id]);
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500);
      await conn.query(`DELETE FROM videos WHERE id IN (${batch.map(() => '?').join(',')})`, batch);
    }
  });
  for (const videoId of ids) {
    await fs.promises.unlink(path.join(THUMB_DIR, `v_${videoId}.jpg`)).catch(() => {});
  }
}

/** Get all enabled source paths (convenience) */
async function getSourcePaths() {
  const sources = await getSources();
  return sources.filter(s => s.enabled).map(s => s.path);
}

/* ── Main scanner ────────────────────────────────────────── */
const BATCH_SIZE = 500;

async function scanDirectory(onProgress = null) {
  if (scanProgress.running) throw new Error('Scan already in progress');
  if (syncProgress.running) throw new Error('Sync already in progress');
  cancelRequested = false;
  scanProgress = {
    running: true, total: 0, done: 0, skipped: 0, errors: 0,
    startedAt: new Date().toISOString(), finishedAt: null, lastError: null,
    cancelled: false, currentFolder: null,
  };
  const notify = () => { if (onProgress) try { onProgress({ ...scanProgress }); } catch { /* callback error */ } };

  try {
    const sourcePaths = await getSourcePaths();
    if (!sourcePaths.length) {
      logger.error('scanner', 'No media sources configured');
      throw new Error('No media sources configured. Add at least one source directory in Settings.');
    }

    const existingPaths = await getAllExistingPaths();
    logger.info('scanner', `${existingPaths.size} files already in database`);

    for (const mediaDir of sourcePaths) {
      if (cancelRequested) break;
      logger.info('scanner', `Scanning source: ${mediaDir}`);
      if (!fs.existsSync(mediaDir)) {
        logger.error('scanner', `Source not found: ${mediaDir}`);
        scanProgress.errors++;
        continue;
      }

      const entries = fs.readdirSync(mediaDir, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));
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
        await processFolder(dir.name, path.join(mediaDir, dir.name));
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
          const filePath = path.join(mediaDir, f.name);
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
    return { found: scanProgress.total + scanProgress.skipped, inserted: scanProgress.total, skipped: scanProgress.skipped, errors: scanProgress.errors };
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
  if (enrichProgress.running) { logger.warn('enrich', 'Enrichment already in progress'); return; }
  enrichProgress.running = true;
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      "SELECT id, file_path FROM videos WHERE codec IS NULL OR duration IS NULL"
    );
    if (!rows.length) { enrichProgress.running = false; logger.info('enrich', 'No videos to enrich — all up to date'); return; }
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
  thumbsProgress.running = true;
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT id, file_path FROM videos WHERE thumb_path IS NULL ORDER BY id DESC LIMIT ?', [limit]
    );
    if (!rows.length) { thumbsProgress.running = false; logger.info('thumbs', 'No thumbnails to generate — all up to date'); return; }
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

/* ── Sync: remove orphans + add missing without full rescan ─ */
let syncProgress = { running: false, total: 0, done: 0, removed: 0, added: 0, errors: 0, startedAt: null, finishedAt: null };

function getSyncProgress() { return { ...syncProgress }; }

async function syncDatabase() {
  if (syncProgress.running) throw new Error('Sync already in progress');
  if (scanProgress.running) throw new Error('Scan already in progress');
  syncProgress = { running: true, total: 0, done: 0, removed: 0, added: 0, errors: 0, startedAt: new Date().toISOString(), finishedAt: null };

  try {
    logger.info('sync', 'Starting database sync…');

    const pool = getPool();
    // Phase 1: Remove orphan DB entries (file no longer on disk).
    //
    // ⚠ NFS RESILIENCE: a transient NFS hiccup (network blip, server
    // momentarily slow) can make `fs.access` fail with ENOENT/ETIMEDOUT
    // even though the file is fine. Without protection, we'd remove
    // hundreds of valid videos from DB on every blip — they get re-added
    // in Phase 2 with NEW IDs, which:
    //   - cascades-deletes their encode_jobs (lost queue),
    //   - changes video.id (frontend selection / filters break),
    //   - thrashes thumbnails (regenerated for nothing).
    //
    // Strategy:
    //   1. Verify each source mount root is accessible AND non-empty FIRST.
    //      If any source is broken, abort the sync entirely — the user gets
    //      a clear error instead of silently losing their library.
    //   2. For every candidate orphan, double-check by stat'ing the parent
    //      directory. If the parent dir is also missing, it's a mount issue
    //      → keep the entry (don't remove).
    //   3. Re-check every "missing" file ONE more time after a 200ms delay
    //      to dodge transient NFS hiccups.
    const sourcePaths = await getSourcePaths();
    if (!sourcePaths.length) {
      logger.error('sync', 'No media sources configured');
      throw new Error('No media sources configured. Add at least one source directory in Settings.');
    }
    // Mount sanity check: each source must exist AND contain at least one
    // entry. An empty mount almost always means "NFS not mounted yet" —
    // safer to abort than wipe the DB.
    for (const src of sourcePaths) {
      try {
        const entries = await fs.promises.readdir(src);
        if (entries.length === 0) {
          const msg = `Source "${src}" appears empty — refusing to sync (likely NFS mount issue)`;
          logger.error('sync', msg);
          syncProgress.running = false;
          syncProgress.errors++;
          syncProgress.finishedAt = new Date().toISOString();
          throw new Error(msg);
        }
      } catch (e) {
        if (e.message.includes('refusing to sync')) throw e;
        const msg = `Source "${src}" not accessible (${e.code || e.message}) — aborting sync`;
        logger.error('sync', msg);
        syncProgress.running = false;
        syncProgress.errors++;
        syncProgress.finishedAt = new Date().toISOString();
        throw new Error(msg);
      }
    }

    const [dbRows] = await pool.query('SELECT id, file_path FROM videos');
    const dbPaths = new Map(); // file_path → id
    for (const r of dbRows) dbPaths.set(r.file_path, r.id);
    syncProgress.total = dbRows.length;
    logger.info('sync', `Phase 1: Checking ${dbRows.length} DB entries against disk…`);

    const candidates = [];
    for (const [fp, id] of dbPaths) {
      try {
        await fs.promises.access(fp, fs.constants.F_OK);
      } catch (err) {
        if (err.code === 'ENOENT') candidates.push({ id, fp });
        else syncProgress.errors++;
      }
      syncProgress.done++;
    }

    // Re-verify candidates with parent-dir check + retry to avoid NFS-flap mass deletions.
    let toRemove = [];
    if (candidates.length) {
      logger.info('sync', `Phase 1b: Re-verifying ${candidates.length} candidate orphan(s) (NFS-safe double-check)…`);
      // Small delay lets transient NFS issues clear
      await new Promise(r => setTimeout(r, 200));
      for (const { id, fp } of candidates) {
        // Check parent dir first — if it's gone, it's a mount issue, keep the entry.
        const parent = path.dirname(fp);
        let parentOk = false;
        try { await fs.promises.access(parent, fs.constants.F_OK); parentOk = true; } catch { /* parent missing */ }
        if (!parentOk) {
          // Parent dir vanished — almost certainly NFS-related, NOT a real deletion.
          continue;
        }
        // Parent dir exists but file doesn't → re-check the file itself once more.
        try {
          await fs.promises.access(fp, fs.constants.F_OK);
          // File came back on retry — was a transient hiccup.
        } catch (err) {
          if (err.code === 'ENOENT') toRemove.push(id);
          else syncProgress.errors++;
        }
      }
      const transient = candidates.length - toRemove.length;
      if (transient > 0) {
        logger.warn('sync', `Skipped ${transient} entries that look like NFS hiccups (parent dir missing or file came back on retry)`);
      }
    }

    if (toRemove.length) {
      const removed = [];
      // Delete in batches of 500
      for (let i = 0; i < toRemove.length; i += 500) {
        const batch = toRemove.slice(i, i + 500);
        try {
          await withIdleVideos(batch, async conn => {
            await conn.query(`DELETE FROM videos WHERE id IN (${batch.map(() => '?').join(',')})`, batch);
          });
        } catch (err) {
          if (err.status === 409) continue; // Keep rows AND thumbnails while jobs are outstanding.
          throw err;
        }
        removed.push(...batch);
        // Also remove thumbnails
        for (const id of batch) {
          const tp = path.join(THUMB_DIR, `v_${id}.jpg`);
          try { await fs.promises.unlink(tp); } catch { /* file may not exist */ }
        }
      }
      toRemove = removed;
      syncProgress.removed = removed.length;
      logger.info('sync', `Removed ${toRemove.length} orphan DB entries`);
    }

    // Phase 2: Add files on disk not in DB
    logger.info('sync', `Phase 2: Scanning disk for new files…`);
    const existingPaths = new Set(dbPaths.keys());
    // Remove the orphan paths from existingPaths — use reverse map for O(1) lookup
    const idToPath = new Map();
    for (const [fp, fid] of dbPaths) idToPath.set(fid, fp);
    for (const id of toRemove) {
      const fp = idToPath.get(id);
      if (fp) existingPaths.delete(fp);
    }

    // Note: sourcePaths already validated and bound above (Phase 1 mount check).
    // Phase 2 reuses the same array — no need to re-fetch / re-validate.

    let batch = [];
    let addCount = 0;

    const flushBatch = async () => {
      if (!batch.length) return;
      await batchInsertVideos(batch);
      addCount += batch.length;
      batch = [];
    };

    for (const mediaDir of sourcePaths) {
      if (!fs.existsSync(mediaDir)) {
        logger.error('sync', `Source not found: ${mediaDir}`);
        syncProgress.errors++;
        continue;
      }

      logger.info('sync', `Scanning source: ${mediaDir}`);
      const entries = fs.readdirSync(mediaDir, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));
      const rootFiles = entries.filter(e => e.isFile() && !e.name.startsWith('.'));

      for (const dir of dirs) {
        const folderPath = path.join(mediaDir, dir.name);
        for await (const filePath of walkFiles(folderPath)) {
          const ext = path.extname(filePath).toLowerCase();
          if (!VIDEO_EXTS.has(ext)) continue;
          if (existingPaths.has(filePath)) continue;
          try {
            const stat = await fs.promises.stat(filePath);
            batch.push([dir.name, path.basename(filePath), filePath, stat.size]);
            if (batch.length >= BATCH_SIZE) await flushBatch();
          } catch (e) {
            syncProgress.errors++;
          }
        }
      }

      // Root files
      for (const f of rootFiles) {
        const ext = path.extname(f.name).toLowerCase();
        if (!VIDEO_EXTS.has(ext)) continue;
        const filePath = path.join(mediaDir, f.name);
        if (existingPaths.has(filePath)) continue;
        try {
          const stat = await fs.promises.stat(filePath);
          batch.push(['(root)', f.name, filePath, stat.size]);
          if (batch.length >= BATCH_SIZE) await flushBatch();
        } catch (e) {
          syncProgress.errors++;
        }
      }
    }
    await flushBatch();
    syncProgress.added = addCount;

    syncProgress.running = false;
    syncProgress.finishedAt = new Date().toISOString();
    logger.success('sync', `Sync complete — removed: ${syncProgress.removed}, added: ${syncProgress.added}, errors: ${syncProgress.errors}`);
  } catch (e) {
    syncProgress.running = false;
    syncProgress.finishedAt = new Date().toISOString();
    logger.error('sync', `Sync failed: ${e.message}`);
    throw e;
  }
}

module.exports = {
  LEGACY_MEDIA_DIR, THUMB_DIR, VIDEO_EXTS,
  getSources, addSource, removeSource, getSourcePaths,
  scanDirectory, getProgress, cancelScan,
  getState, enrichVideoMeta, generateMissingThumbs, generateThumb,
  getEnrichProgress, getThumbsProgress,
  syncDatabase, getSyncProgress,
};
