/**
 * services/watcher.js — Auto-scan & file watcher for Encodium
 *
 * Provides two mechanisms to keep the library up-to-date automatically:
 *   1. File system watchers on all source directories (debounced sync)
 *   2. Configurable periodic sync interval (fallback for NFS/CIFS/etc.)
 *
 * Also exposes `runFullPipeline()` to trigger scan → enrich.
 * Thumbnails are generated on-demand when browsing the library, not during
 * the auto-scan pipeline.
 */
'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

let encoder;
function getBroadcast() {
  if (!encoder) encoder = require('./encoder');
  return encoder.broadcast;
}

let scanner;  // lazy-loaded to avoid circular deps
function getScanner() {
  if (!scanner) scanner = require('../scanner');
  return scanner;
}

let db;
function getDb() {
  if (!db) db = require('../db');
  return db;
}

/* ── State ───────────────────────────────────────────────── */
const activeWatchers = new Map();   // sourcePath → FSWatcher
let periodicTimer    = null;
let syncDebounce     = null;
const DEBOUNCE_MS    = 8000;        // wait 8s after last fs event before syncing
let pipelineRunning  = false;
let pendingPipeline  = null;        // queued reason when pipeline skipped (re-runs after current)

/* ── Full pipeline: scan → enrich → thumbs ───────────────── */

/**
 * Run the full indexing pipeline (scan + enrich + thumbs).
 * Skips if any step is already running.
 * @param {string} [reason] - Log reason (e.g. 'source added', 'file watcher', 'periodic')
 */
async function runFullPipeline(reason = 'auto') {
  const sc = getScanner();
  if (pipelineRunning || sc.getState().running || sc.getSyncProgress().running) {
    // Queue a re-run so the new source gets scanned after the current pipeline finishes
    pendingPipeline = reason;
    logger.info('watcher', `Pipeline queued (already running) — trigger: ${reason}`);
    return;
  }
  pipelineRunning = true;
  pendingPipeline = null;
  const broadcast = getBroadcast();
  logger.info('watcher', `Auto-pipeline started — trigger: ${reason}`);
  broadcast('pipeline_status', { step: 'scan', status: 'running', reason });
  try {
    await sc.scanDirectory();
    broadcast('pipeline_status', { step: 'scan', status: 'done', reason });
    // Enrich metadata if not already running
    if (!sc.getEnrichProgress().running) {
      broadcast('pipeline_status', { step: 'enrich', status: 'running', reason });
      await sc.enrichVideoMeta();
      broadcast('pipeline_status', { step: 'enrich', status: 'done', reason });
    }
    // Thumbnails are generated on-demand when the library is viewed
    broadcast('pipeline_status', { step: 'complete', status: 'done', reason });
    logger.success('watcher', `Auto-pipeline complete — trigger: ${reason}`);
  } catch (e) {
    broadcast('pipeline_status', { step: 'error', status: 'error', error: e.message, reason });
    logger.error('watcher', `Auto-pipeline error: ${e.message}`);
  } finally {
    pipelineRunning = false;
    // If another pipeline was queued while we were running, execute it now
    if (pendingPipeline) {
      const nextReason = pendingPipeline;
      pendingPipeline = null;
      setImmediate(() => runFullPipeline(nextReason).catch(() => {}));
    }
  }
}

/**
 * Lightweight auto-sync (no full scan — just remove orphans + add new).
 * Falls back to full pipeline if sync is unavailable.
 */
async function runAutoSync(reason = 'auto') {
  const sc = getScanner();
  if (pipelineRunning || sc.getState().running || sc.getSyncProgress().running) {
    logger.info('watcher', `Auto-sync skipped (busy) — trigger: ${reason}`);
    return;
  }
  pipelineRunning = true;
  const broadcast = getBroadcast();
  logger.info('watcher', `Auto-sync started — trigger: ${reason}`);
  broadcast('pipeline_status', { step: 'sync', status: 'running', reason });
  try {
    await sc.syncDatabase();
    broadcast('pipeline_status', { step: 'sync', status: 'done', reason });
    // Also enrich for any newly added files
    if (!sc.getEnrichProgress().running) {
      broadcast('pipeline_status', { step: 'enrich', status: 'running', reason });
      await sc.enrichVideoMeta();
      broadcast('pipeline_status', { step: 'enrich', status: 'done', reason });
    }
    // Thumbnails are generated on-demand when the library is viewed
    broadcast('pipeline_status', { step: 'complete', status: 'done', reason });
    logger.success('watcher', `Auto-sync complete — trigger: ${reason}`);
  } catch (e) {
    broadcast('pipeline_status', { step: 'error', status: 'error', error: e.message, reason });
    logger.error('watcher', `Auto-sync error: ${e.message}`);
  } finally {
    pipelineRunning = false;
    // If a full pipeline was queued while sync ran, execute it now
    if (pendingPipeline) {
      const nextReason = pendingPipeline;
      pendingPipeline = null;
      setImmediate(() => runFullPipeline(nextReason).catch(() => {}));
    }
  }
}

/* ── Debounced sync (triggered by fs events) ─────────────── */
function scheduleDebouncedSync() {
  // Suppress fs events while a pipeline/sync is already active
  // (walking directories to sync generates inotify events → infinite loop)
  if (pipelineRunning) return;
  if (syncDebounce) clearTimeout(syncDebounce);
  syncDebounce = setTimeout(() => {
    syncDebounce = null;
    runAutoSync('file watcher').catch(() => {});
  }, DEBOUNCE_MS);
}

/* ── File system watchers ────────────────────────────────── */

function startWatchingSource(srcPath) {
  if (activeWatchers.has(srcPath)) return;
  if (!fs.existsSync(srcPath)) {
    logger.warn('watcher', `Cannot watch — path not found: ${srcPath}`);
    return;
  }
  try {
    const watcher = fs.watch(srcPath, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      // Ignore dotfiles and non-video events noise
      if (path.basename(filename).startsWith('.')) return;
      scheduleDebouncedSync();
    });
    watcher.on('error', (err) => {
      logger.warn('watcher', `Watcher error on ${srcPath}: ${err.message}`);
      stopWatchingSource(srcPath);
    });
    activeWatchers.set(srcPath, watcher);
    logger.info('watcher', `Watching: ${srcPath}`);
  } catch (e) {
    logger.warn('watcher', `Failed to watch ${srcPath}: ${e.message}`);
  }
}

function stopWatchingSource(srcPath) {
  const w = activeWatchers.get(srcPath);
  if (w) {
    try { w.close(); } catch {}
    activeWatchers.delete(srcPath);
    logger.info('watcher', `Stopped watching: ${srcPath}`);
  }
}

/** Refresh watchers to match current enabled sources */
async function refreshWatchers() {
  try {
    const sc = getScanner();
    const paths = await sc.getSourcePaths();
    const pathSet = new Set(paths);

    // Stop watchers for removed sources
    for (const [p] of activeWatchers) {
      if (!pathSet.has(p)) stopWatchingSource(p);
    }
    // Start watchers for new sources
    for (const p of paths) {
      startWatchingSource(p);
    }
  } catch (e) {
    logger.error('watcher', `refreshWatchers error: ${e.message}`);
  }
}

/* ── Periodic auto-sync ──────────────────────────────────── */

const INTERVAL_OPTIONS = {
  '0':     0,         // disabled
  '5':     5 * 60000,
  '15':    15 * 60000,
  '30':    30 * 60000,
  '60':    60 * 60000,
  '360':   360 * 60000,
};

async function getAutoScanInterval() {
  try {
    const val = await getDb().getSetting('autoscan_interval', '0');
    return INTERVAL_OPTIONS[val] || 0;
  } catch { return 0; }
}

async function setAutoScanInterval(minutes) {
  const key = String(minutes);
  if (!(key in INTERVAL_OPTIONS)) throw new Error('Invalid interval');
  await getDb().setSetting('autoscan_interval', key);
  restartPeriodicTimer();
}

async function restartPeriodicTimer() {
  if (periodicTimer) { clearInterval(periodicTimer); periodicTimer = null; }
  const ms = await getAutoScanInterval();
  if (ms > 0) {
    logger.info('watcher', `Periodic auto-sync every ${ms / 60000} min`);
    periodicTimer = setInterval(() => {
      runAutoSync('periodic').catch(() => {});
    }, ms);
  }
}

/* ── Init / Shutdown ─────────────────────────────────────── */

async function start() {
  await refreshWatchers();
  await restartPeriodicTimer();
  logger.info('watcher', `Watcher service started (${activeWatchers.size} source(s) watched)`);
}

function stop() {
  if (periodicTimer) { clearInterval(periodicTimer); periodicTimer = null; }
  if (syncDebounce) { clearTimeout(syncDebounce); syncDebounce = null; }
  for (const [p] of activeWatchers) stopWatchingSource(p);
  logger.info('watcher', 'Watcher service stopped');
}

module.exports = {
  start,
  stop,
  refreshWatchers,
  runFullPipeline,
  runAutoSync,
  getAutoScanInterval,
  setAutoScanInterval,
  INTERVAL_OPTIONS,
};
