/**
 * routes/api.js — All API endpoints for Encodium
 */
'use strict';

const express    = require('express');
const router     = express.Router();
const bcrypt     = require('bcryptjs');
const path       = require('path');
const fs         = require('fs');
const fsp        = require('fs/promises');
const rateLimit  = require('express-rate-limit');

const db         = require('../db');
const scanner    = require('../scanner');
const gpuDetect  = require('../services/gpu-detect');
const encoder    = require('../services/encoder');
const logger     = require('../services/logger');
const { mimeForExt } = require('../services/ffmpeg-args');
const { parseByteRange } = require('../services/http-range');
const { resolvePublicWebhookUrl } = require('../services/network-security');
const {
  signToken, setSessionCookie, clearSessionCookie, requireAuth, requireAdmin,
} = require('../middleware/auth');

const IS_PROD = process.env.NODE_ENV === 'production';
/** Return a safe error message — hides internals in production */
function safeError(e, fallback = 'Internal server error') {
  return IS_PROD ? fallback : (e.message || fallback);
}

/* ─── Shared SQL & query helpers ─────────────────────────── */

/** Sub-query: video has at least one 'error' job and no 'done' job */
const FAIL_EXISTS_SQL = "(EXISTS (SELECT 1 FROM encode_jobs ej WHERE ej.video_id = v.id AND ej.status = 'error') AND NOT EXISTS (SELECT 1 FROM encode_jobs ej2 WHERE ej2.video_id = v.id AND ej2.status = 'done'))";

/** Column whitelist for ORDER BY (prevents SQL injection) */
const SORT_COLUMN_MAP = {
  filename: 'v.filename', folder: 'v.folder', size: 'v.size',
  duration: 'v.duration', codec: 'v.codec', width: 'v.width', created_at: 'v.created_at',
};

/**
 * Build WHERE clause + params from video filter query-string values.
 * Shared between /videos and /videos/ids to eliminate duplication.
 */
function buildVideoFilterQuery({ q = '', folder = '', codec = '', skip = '', fail = '' }) {
  const where = [];
  const params = [];

  if (q) {
    where.push('(v.filename LIKE ? OR v.folder LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like);
  }
  if (folder) {
    where.push('v.folder = ?');
    params.push(folder);
  }
  if (codec) {
    if (codec === 'unknown') {
      where.push("(v.codec IS NULL OR v.codec = '')");
    } else {
      where.push('v.codec = ?');
      params.push(codec);
    }
  }
  if (skip === 'hide') {
    where.push('(v.encode_skip IS NULL OR v.encode_skip = 0)');
  } else if (skip === 'only') {
    where.push('v.encode_skip = 1');
  }
  if (fail === 'hide') {
    where.push(`NOT ${FAIL_EXISTS_SQL}`);
  } else if (fail === 'only') {
    where.push(FAIL_EXISTS_SQL);
  }

  const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return { whereSQL, params };
}

/* ─── Anti-brute-force limiter for login ──────────────────── */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // 10 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later' },
});

const dummyPasswordHash = bcrypt.hash('encodium-invalid-login-sentinel', 12);

/* ─── :id param validation ────────────────────────────────── */
router.param('id', (req, res, next, val) => {
  const n = Number(val);
  if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: 'Invalid id' });
  req.params.id = n;          // coerce once — downstream code gets a number
  next();
});

/* ═══════════════════════════════════════════════════════════════
   AUTH
   ═══════════════════════════════════════════════════════════════ */

router.post('/auth/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password || email.length > 255 || password.length > 1024) {
      return res.status(400).json({ error: 'Valid email and password required' });
    }
    const normalizedEmail = email.trim().toLowerCase();
    const user = await db.getUserByEmail(normalizedEmail);
    const ok = await bcrypt.compare(password, user ? user.password_hash : await dummyPasswordHash);
    if (!user || !ok) {
      logger.warn('auth', `Login failed for ${normalizedEmail.replace(/[\r\n\t]/g, '')}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    await db.updateLastLogin(user.id);
    logger.info('auth', `Login success: ${normalizedEmail} (id=${user.id})`);
    const token = signToken(user);
    setSessionCookie(req, res, token);
    const response = { user: { id: user.id, email: user.email, role: user.role } };
    // Browser sessions use the HttpOnly cookie. Explicit API clients can opt
    // into a bearer token without exposing it to the default web frontend.
    if (process.env.AUTH_RETURN_BEARER_TOKEN === 'true') response.token = token;
    res.json(response);
  } catch (e) { logger.error('auth', `Login error: ${e.message}`); res.status(500).json({ error: safeError(e) }); }
});

router.post('/auth/logout', (req, res) => {
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

router.get('/health', async (_req, res) => {
  try {
    await db.getPool().query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
});

router.get('/auth/me', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user.id, email: user.email, role: user.role });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

/* ═══════════════════════════════════════════════════════════════
   SCANNER
   ═══════════════════════════════════════════════════════════════ */

router.post('/scan', requireAdmin, async (req, res) => {
  try {
    const state = scanner.getState();
    if (state.running) return res.status(409).json({ error: 'Scan already in progress' });
    logger.info('scanner', 'Scan triggered by user');
    scanner.scanDirectory().catch(e => logger.error('scanner', `Scan error: ${e.message}`));
    res.json({ message: 'Scan started' });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

router.get('/scan/progress', requireAuth, (req, res) => {
  res.json(scanner.getState());
});

router.post('/scan/cancel', requireAdmin, (req, res) => {
  scanner.cancelScan();
  res.json({ message: 'Scan cancelled' });
});

router.post('/sync', requireAdmin, async (req, res) => {
  try {
    const syncState = scanner.getSyncProgress();
    if (syncState.running) return res.status(409).json({ error: 'Sync already in progress' });
    const scanState = scanner.getState();
    if (scanState.running) return res.status(409).json({ error: 'Scan in progress, cannot sync simultaneously' });
    logger.info('sync', 'Database sync triggered by user');
    scanner.syncDatabase().catch(e => logger.error('sync', `Sync error: ${e.message}`));
    res.json({ message: 'Sync started' });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

router.get('/sync/progress', requireAuth, (req, res) => {
  res.json(scanner.getSyncProgress());
});

router.post('/enrich', requireAdmin, async (req, res) => {
  try {
    const enrichState = scanner.getEnrichProgress();
    if (enrichState.running) return res.status(409).json({ error: 'Enrichment already in progress' });
    const state = scanner.getState();
    if (state.running) return res.status(409).json({ error: 'Scan in progress' });
    logger.info('enrich', 'Metadata enrichment triggered by user');
    scanner.enrichVideoMeta().catch(e => logger.error('enrich', `Enrichment error: ${e.message}`));
    res.json({ message: 'Metadata enrichment started' });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

router.get('/enrich/progress', requireAuth, (req, res) => {
  res.json(scanner.getEnrichProgress());
});

router.post('/thumbs', requireAdmin, async (req, res) => {
  try {
    const thumbsState = scanner.getThumbsProgress();
    if (thumbsState.running) return res.status(409).json({ error: 'Thumbnail generation already in progress' });
    logger.info('thumbs', 'Thumbnail generation triggered by user');
    scanner.generateMissingThumbs().catch(e => logger.error('thumbs', `Thumbs error: ${e.message}`));
    res.json({ message: 'Thumbnail generation started' });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

router.get('/thumbs/progress', requireAuth, (req, res) => {
  res.json(scanner.getThumbsProgress());
});

/* ═══════════════════════════════════════════════════════════════
   VIDEOS — Browse / search / filter
   ═══════════════════════════════════════════════════════════════ */

router.get('/videos', requireAuth, async (req, res) => {
  try {
    const pool = db.getPool();
    const { sort = 'filename', order = 'asc', page = 1, limit = 50 } = req.query;
    const { whereSQL, params } = buildVideoFilterQuery(req.query);

    const sortExpr = SORT_COLUMN_MAP[sort] || SORT_COLUMN_MAP.filename;
    const sortDir = order.toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    const lim = Math.min(200, Math.max(1, parseInt(limit, 10)));
    const off = Math.max(0, (parseInt(page, 10) - 1)) * lim;

    const [rows] = await pool.query(
      `SELECT v.*, ${FAIL_EXISTS_SQL} AS encode_failed FROM videos v ${whereSQL} ORDER BY ${sortExpr} ${sortDir} LIMIT ? OFFSET ?`,
      [...params, lim, off]
    );
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM videos v ${whereSQL}`,
      params
    );

    res.json({ videos: rows, total, page: parseInt(page, 10), pages: Math.ceil(total / lim) });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

/* Return ALL video ids matching current filters (no pagination) */
router.get('/videos/ids', requireAuth, async (req, res) => {
  try {
    const pool = db.getPool();
    const { whereSQL, params } = buildVideoFilterQuery(req.query);
    const [rows] = await pool.query(`SELECT v.id FROM videos v ${whereSQL}`, params);
    res.json({ ids: rows.map(r => r.id) });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

router.get('/videos/:id', requireAuth, async (req, res) => {
  try {
    const pool = db.getPool();
    const [[video]] = await pool.query('SELECT * FROM videos WHERE id=?', [req.params.id]);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    res.json(video);
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

router.post('/videos/delete', requireAdmin, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
    const pool = db.getPool();
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await pool.query(`SELECT id, file_path FROM videos WHERE id IN (${placeholders})`, ids);
    logger.info('api', `Delete request: ${ids.length} id(s) sent, ${rows.length} found in DB`);
    const fileErrors = [];
    for (const v of rows) {
      // Delete physical file
      if (v.file_path) {
        try { await fsp.unlink(v.file_path); } catch (e) {
          if (e.code !== 'ENOENT') fileErrors.push({ id: v.id, error: e.message });
        }
      }
      // Delete thumbnail
      const thumbPath = path.join(__dirname, '..', 'data', 'thumbs', `v_${v.id}.jpg`);
      try { await fsp.unlink(thumbPath); } catch { /* already gone */ }
    }
    // Batch delete from DB (cascade handles encode_jobs via FK)
    if (rows.length > 0) {
      const delIds = rows.map(v => v.id);
      const ph = delIds.map(() => '?').join(',');
      await pool.query(`DELETE FROM encode_jobs WHERE video_id IN (${ph})`, delIds);
      await pool.query(`DELETE FROM videos WHERE id IN (${ph})`, delIds);
    }
    logger.info('api', `Deleted ${rows.length} video(s) (requested: ${ids.length})`);
    res.json({ deleted: rows.length, fileErrors });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

router.get('/folders', requireAuth, async (req, res) => {
  try {
    const pool = db.getPool();
    const [rows] = await pool.query(
      `SELECT folder, COUNT(*) as count, SUM(size) as total_size
       FROM videos GROUP BY folder ORDER BY folder`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

router.get('/codec-stats', requireAuth, async (req, res) => {
  try {
    const pool = db.getPool();
    const [rows] = await pool.query(
      `SELECT COALESCE(codec,'unknown') as codec, COUNT(*) as count, SUM(size) as total_size
       FROM videos GROUP BY codec ORDER BY count DESC`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

router.get('/stats', requireAuth, async (req, res) => {
  try {
    const pool = db.getPool();
    const [[vStats]] = await pool.query('SELECT COUNT(*) as count, COALESCE(SUM(size),0) as total_size, COALESCE(SUM(duration),0) as total_duration FROM videos');
    const [[jStats]] = await pool.query(
      `SELECT COUNT(*) as total,
              SUM(status='pending') as pending,
              SUM(status='encoding') as encoding,
              SUM(status='done') as done,
              SUM(status='error') as errors,
              SUM(status='cancelled') as cancelled
       FROM encode_jobs`
    );
    const [[eStats]] = await pool.query(
      `SELECT COUNT(*) as encoded_count,
              COALESCE(SUM(size_before), 0) as total_before,
              COALESCE(SUM(size_after), 0) as total_after,
              COALESCE(SUM(saved), 0) as total_saved
       FROM encoding_savings`
    );
    res.json({
      videos: vStats,
      jobs: jStats,
      encoding: {
        count: Number(eStats.encoded_count),
        totalBefore: Number(eStats.total_before),
        totalAfter: Number(eStats.total_after),
        saved: Number(eStats.total_saved),
      },
      paths: {
        media: (await scanner.getSources()).map(s => s.path),
        thumbs: scanner.THUMB_DIR,
        encode: process.env.ENCODE_DIR || path.join(__dirname, '..', 'data', 'encoded'),
      },
    });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

/* ═══════════════════════════════════════════════════════════════
   THUMBNAILS
   ═══════════════════════════════════════════════════════════════ */

router.get('/thumb/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  const thumbPath = path.join(__dirname, '..', 'data', 'thumbs', `v_${id}.jpg`);

  // Already exists → serve immediately
  try {
    await fsp.access(thumbPath, fs.constants.F_OK);
    return res.sendFile(thumbPath);
  } catch { /* not found — continue below */ }

  // Thumb missing → kick off background generation and return 202 immediately.
  // This avoids blocking the HTTP connection (and the browser's per-origin
  // connection pool) while ffmpeg runs.  The frontend will retry after a delay.
  try {
    const pool = db.getPool();
    const [[video]] = await pool.query('SELECT file_path FROM videos WHERE id=?', [id]);
    if (!video || !video.file_path) return res.status(404).end();

    // Fire-and-forget: generate in background, update DB when done
    scanner.generateThumb(video.file_path, id).then(async (result) => {
      if (result) {
        try {
          await pool.query('UPDATE videos SET thumb_path=? WHERE id=?', [thumbPath, id]);
        } catch { /* non-critical */ }
      }
    }).catch(() => {});

    // Tell the client "accepted, come back later"
    return res.status(202).json({ generating: true });
  } catch {
    res.status(404).end();
  }
});

/* ═══════════════════════════════════════════════════════════════
   VIDEO STREAMING
   ═══════════════════════════════════════════════════════════════ */

router.get('/stream/:id', requireAuth, async (req, res) => {
  try {
    const pool = db.getPool();
    const [rows] = await pool.query('SELECT file_path, size FROM videos WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const video = rows[0];
    const filePath = video.file_path;
    let fileSize = video.size;
    if (!fileSize) {
      const st = await fsp.stat(filePath);
      fileSize = st.size;
    }

    const mime = mimeForExt(path.extname(filePath));
    const range = req.headers.range;
    if (range) {
      let parsed;
      try { parsed = parseByteRange(range, Number(fileSize)); }
      catch {
        res.set('Content-Range', `bytes */${fileSize}`);
        return res.status(416).end();
      }
      const { start, end, length: chunkSize } = parsed;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mime,
      });
      const stream = fs.createReadStream(filePath, { start, end });
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
      });
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    }
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

/* ═══════════════════════════════════════════════════════════════
   ENCODING
   ═══════════════════════════════════════════════════════════════ */

router.get('/encode/capabilities', requireAuth, async (req, res) => {
  try {
    const caps = await gpuDetect.detectAll(!!req.query.refresh);
    res.json(caps);
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

router.get('/encode/status', requireAuth, (req, res) => {
  res.json(encoder.getStatus());
});

router.get('/encode/history', requireAuth, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    // Cap limit to 1000 to avoid DOS / DB load on large histories
    const safeLimit = Math.max(1, Math.min(1000, parseInt(limit, 10) || 50));
    const safeOffset = Math.max(0, parseInt(offset, 10) || 0);
    const data = await encoder.getHistory(safeLimit, safeOffset);
    res.json(data);
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

router.post('/encode/enqueue', requireAuth, async (req, res) => {
  try {
    let { presetId, container, downscale, tonemap } = req.body;
    const { videoIds, replaceOriginal, force } = req.body;
    let customCq;
    if (!presetId) return res.status(400).json({ error: 'presetId required' });
    const ids = Array.isArray(videoIds) ? videoIds : [videoIds];
    if (!ids.length) return res.status(400).json({ error: 'videoIds required' });

    // If custom preset, resolve it and find the best matching hardware preset
    if (presetId.startsWith('custom_')) {
      const cpId = parseInt(presetId.replace('custom_', ''), 10);
      const pool = db.getPool();
      const [[cp]] = await pool.query('SELECT * FROM custom_presets WHERE id=?', [cpId]);
      if (!cp) return res.status(400).json({ error: 'Custom preset not found' });

      // Find best hardware preset for this codec
      const caps = await gpuDetect.detectAll();
      const hwPreset = caps.presets.find(p => p.codec === cp.codec);
      if (!hwPreset) return res.status(400).json({ error: `No encoder available for codec ${cp.codec}` });
      presetId = hwPreset.id;
      customCq = cp.cq;  // pass custom CQ via opts (avoids mutating cached preset)
      container = cp.container || 'auto';
      downscale = cp.downscale || '';
      tonemap = !!cp.tonemap;
    }

    const opts = { container: container || 'auto', downscale: downscale || '', tonemap: !!tonemap, force: !!force, customCq: customCq || undefined };
    const result = await encoder.enqueueBatch(ids, presetId, !!replaceOriginal, opts);
    res.json({ jobs: result.jobs, skipped: result.skipped });
  } catch (e) { res.status(400).json({ error: safeError(e, 'Bad request') }); }
});

router.post('/encode/cancel/:id', requireAdmin, (req, res) => {
  const ok = encoder.cancelJob(parseInt(req.params.id, 10));
  res.json({ cancelled: ok });
});

router.post('/encode/cancel-all', requireAdmin, async (req, res) => {
  const n = await encoder.cancelAll();
  res.json({ cancelled: n });
});

router.post('/encode/force-kill/:id', requireAdmin, async (req, res) => {
  try {
    await encoder.forceKillJob(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: safeError(e, 'Bad request') }); }
});

router.post('/encode/pause', requireAdmin, (req, res) => {
  const p = encoder.setPaused(true);
  res.json({ paused: p });
});

router.post('/encode/resume', requireAdmin, (req, res) => {
  const p = encoder.setPaused(false);
  res.json({ paused: p });
});

router.post('/encode/clear-finished', requireAdmin, async (req, res) => {
  try {
    const n = await encoder.clearFinished();
    res.json({ cleared: n });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

router.post('/encode/retry/:id', requireAdmin, async (req, res) => {
  try {
    await encoder.retryJob(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: safeError(e, 'Bad request') }); }
});

router.delete('/encode/job/:id', requireAdmin, async (req, res) => {
  try {
    await encoder.deleteJob(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: safeError(e, 'Bad request') }); }
});

router.post('/encode/workers', requireAdmin, (req, res) => {
  const { count } = req.body;
  if (!count || count < 1 || count > 8) return res.status(400).json({ error: 'count 1-8' });
  const n = encoder.setWorkerCount(count);
  res.json({ workers: n });
});

/* Clear encode_skip flag for given video ids */
router.post('/videos/clear-skip', requireAdmin, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
    const pool = db.getPool();
    const ph = ids.map(() => '?').join(',');
    const [result] = await pool.query(`UPDATE videos SET encode_skip = 0 WHERE id IN (${ph})`, ids);
    res.json({ cleared: result.affectedRows });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

/* Job log endpoint — returns detailed per-job ffmpeg log */
router.get('/encode/job/:id/log', requireAuth, async (req, res) => {
  try {
    const log = await encoder.getJobLog(parseInt(req.params.id, 10));
    if (log === null) return res.status(404).json({ error: 'Log not found' });
    res.type('text/plain').send(log);
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

/* Job priority — set priority of a pending job */
router.post('/encode/job/:id/priority', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { priority } = req.body;
    const pVal = Math.max(-10, Math.min(10, parseInt(priority, 10) || 0));
    const pool = db.getPool();
    await pool.query("UPDATE encode_jobs SET priority=? WHERE id=? AND status='pending'", [pVal, id]);
    res.json({ ok: true, priority: pVal });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

/* Move job up/down in queue */
router.post('/encode/job/:id/move', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { direction } = req.body; // 'up' or 'down'
    const pool = db.getPool();
    const delta = direction === 'up' ? 1 : -1;
    await pool.query("UPDATE encode_jobs SET priority = priority + ? WHERE id=? AND status='pending'", [delta, id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

/* SSE stream for real-time updates (authenticated by HttpOnly session cookie) */
router.get('/events', requireAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('event: connected\ndata: {}\n\n');
  encoder.addSSEClient(res);
  logger.addClient(res);
  req.on('close', () => { encoder.removeSSEClient(res); logger.removeClient(res); });
});

/* ═══════════════════════════════════════════════════════════════
   LOGS — Recent logs endpoint
   ═══════════════════════════════════════════════════════════════ */

router.get('/logs', requireAdmin, (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit || '100', 10));
  const level = req.query.level || 'info';
  res.json(logger.getRecent(limit, level));
});

/* ═══════════════════════════════════════════════════════════════
   STATS HISTORY (for charts)
   ═══════════════════════════════════════════════════════════════ */

router.get('/stats/history', requireAuth, async (req, res) => {
  try {
    const pool = db.getPool();
    // Daily encoding stats for the last 30 days
    const [rows] = await pool.query(`
      SELECT
        DATE(created_at) as day,
        COUNT(*) as count,
        SUM(size_before) as total_before,
        SUM(size_after) as total_after,
        SUM(saved) as saved
      FROM encoding_savings
      WHERE created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY DATE(created_at)
      ORDER BY day ASC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

/* ═══════════════════════════════════════════════════════════════
   CUSTOM PRESETS
   ═══════════════════════════════════════════════════════════════ */

router.get('/custom-presets', requireAuth, async (req, res) => {
  try {
    const pool = db.getPool();
    const [rows] = await pool.query('SELECT * FROM custom_presets ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

// CQ ranges per codec (constant-quality target).
// AV1 supports 0-63; H.265/H.264 use 0-51.
const CQ_RANGES = { av1: [0, 63], h265: [0, 51], hevc: [0, 51], h264: [0, 51], avc: [0, 51] };
// Containers we explicitly support
const ALLOWED_CONTAINERS = new Set(['auto', 'mkv', 'mp4']);
// Downscale heights — must be a known target or empty
const ALLOWED_DOWNSCALE = new Set(['', '480', '720', '1080', '1440', '2160']);

router.post('/custom-presets', requireAdmin, async (req, res) => {
  try {
    const { name, codec, cq, container, downscale, tonemap, extra_args } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name required' });
    }
    const codecKey = (codec || 'h265').toString().toLowerCase();
    const range = CQ_RANGES[codecKey];
    if (!range) {
      return res.status(400).json({ error: `Unsupported codec '${codec}' — must be one of: av1, h265, h264` });
    }
    const cqNum = parseInt(cq, 10);
    if (cq !== undefined && cq !== null && cq !== '') {
      if (!Number.isFinite(cqNum) || cqNum < range[0] || cqNum > range[1]) {
        return res.status(400).json({
          error: `CQ value ${cq} out of range for ${codecKey} (allowed: ${range[0]}-${range[1]})`,
        });
      }
    }
    const containerVal = (container || 'auto').toString().toLowerCase();
    if (!ALLOWED_CONTAINERS.has(containerVal)) {
      return res.status(400).json({ error: `Invalid container '${container}'` });
    }
    const downscaleVal = downscale != null ? String(downscale) : '';
    if (!ALLOWED_DOWNSCALE.has(downscaleVal)) {
      return res.status(400).json({ error: `Invalid downscale '${downscale}' — must be empty, 480, 720, 1080, 1440 or 2160` });
    }
    const pool = db.getPool();
    const [result] = await pool.query(
      'INSERT INTO custom_presets (name, codec, cq, container, downscale, tonemap, extra_args) VALUES (?,?,?,?,?,?,?)',
      [name.trim(), codecKey, Number.isFinite(cqNum) ? cqNum : (codecKey === 'av1' ? 30 : 23),
        containerVal, downscaleVal, tonemap ? 1 : 0, (extra_args || '').toString().slice(0, 500)]
    );
    res.json({ id: result.insertId, ok: true });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

router.delete('/custom-presets/:id', requireAdmin, async (req, res) => {
  try {
    const pool = db.getPool();
    await pool.query('DELETE FROM custom_presets WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

/* ═══════════════════════════════════════════════════════════════
   SETTINGS — Schedule
   ═══════════════════════════════════════════════════════════════ */

router.get('/settings/schedule', requireAuth, async (req, res) => {
  try {
    const enabled = await db.getSetting('schedule_enabled', '0');
    const start   = await db.getSetting('schedule_start', '0');
    const end     = await db.getSetting('schedule_end', '24');
    res.json({ enabled: enabled === '1', start: parseInt(start, 10), end: parseInt(end, 10) });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

router.post('/settings/schedule', requireAdmin, async (req, res) => {
  try {
    const { enabled, start, end } = req.body;
    if (enabled !== undefined) await db.setSetting('schedule_enabled', enabled ? '1' : '0');
    if (start !== undefined) await db.setSetting('schedule_start', String(Math.max(0, Math.min(23, parseInt(start, 10)))));
    if (end !== undefined)   await db.setSetting('schedule_end', String(Math.max(1, Math.min(24, parseInt(end, 10)))));
    logger.info('settings', `Schedule updated by ${req.user.email}: enabled=${enabled}, start=${start}, end=${end}`);
    res.json({ ok: true });
  } catch (e) { logger.error('settings', `Schedule save error: ${e.message}`); res.status(500).json({ error: safeError(e) }); }
});

/* ═══════════════════════════════════════════════════════════════
   SETTINGS — Notifications (webhooks)
   ═══════════════════════════════════════════════════════════════ */

router.get('/settings/notifications', requireAdmin, async (req, res) => {
  try {
    const webhookUrl = await db.getSetting('webhook_url', '');
    const webhookEnabled = await db.getSetting('webhook_enabled', '0');
    res.json({ enabled: webhookEnabled === '1', configured: !!webhookUrl });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

router.post('/settings/notifications', requireAdmin, async (req, res) => {
  try {
    const { enabled, url } = req.body;
    let normalizedUrl;
    if (url !== undefined) {
      const trimmed = String(url).trim();
      if (trimmed) {
        try { normalizedUrl = (await resolvePublicWebhookUrl(trimmed)).url.toString(); }
        catch (validationError) { return res.status(400).json({ error: validationError.message }); }
      } else {
        normalizedUrl = '';
      }
    }
    if (enabled) {
      const effectiveUrl = normalizedUrl !== undefined ? normalizedUrl : await db.getSetting('webhook_url', '');
      if (!effectiveUrl) return res.status(400).json({ error: 'A webhook URL is required before enabling notifications' });
    }
    if (normalizedUrl !== undefined) await db.setSetting('webhook_url', normalizedUrl);
    if (enabled !== undefined) await db.setSetting('webhook_enabled', enabled ? '1' : '0');
    logger.info('settings', `Webhook updated by ${req.user.email}: enabled=${enabled}, url=${url ? '(set)' : '(unchanged)'}`);
    res.json({ ok: true });
  } catch (e) { logger.error('settings', `Webhook save error: ${e.message}`); res.status(500).json({ error: safeError(e) }); }
});

/* ═══════════════════════════════════════════════════════════════
   SETTINGS — Auto-scan
   ═══════════════════════════════════════════════════════════════ */

router.get('/settings/autoscan', requireAuth, async (req, res) => {
  try {
    const watcher = require('../services/watcher');
    const interval = await db.getSetting('autoscan_interval', '0');
    res.json({ interval: parseInt(interval, 10), options: Object.keys(watcher.INTERVAL_OPTIONS).map(Number) });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

router.post('/settings/autoscan', requireAdmin, async (req, res) => {
  try {
    const watcher = require('../services/watcher');
    const { interval } = req.body;
    await watcher.setAutoScanInterval(interval);
    logger.info('settings', `Auto-scan interval updated by ${req.user.email}: ${interval}`);
    res.json({ ok: true });
  } catch (e) { logger.error('settings', `Auto-scan save error: ${e.message}`); res.status(500).json({ error: safeError(e) }); }
});

/* ═══════════════════════════════════════════════════════════════
   SETTINGS — Media Sources (multi-directory)
   ═══════════════════════════════════════════════════════════════ */

/** Get all media source directories */
router.get('/settings/sources', requireAuth, async (req, res) => {
  try {
    const sources = await scanner.getSources();
    res.json(sources);
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

/** Add a new media source directory */
router.post('/settings/sources', requireAdmin, async (req, res) => {
  try {
    const { path: dirPath, label } = req.body;
    if (!dirPath || typeof dirPath !== 'string') return res.status(400).json({ error: 'Path required' });
    const resolved = path.resolve(dirPath.trim());
    // Verify it exists and is a directory
    try {
      const stat = await fsp.stat(resolved);
      if (!stat.isDirectory()) return res.status(400).json({ error: 'Path is not a directory' });
    } catch { return res.status(400).json({ error: 'Path does not exist or is not accessible' }); }
    let source;
    try {
      source = await scanner.addSource(resolved, (label || '').trim() || path.basename(resolved));
    } catch (addErr) {
      if (addErr.code === 'ER_DUP_ENTRY' || (addErr.message && addErr.message.includes('Duplicate'))) {
        return res.status(409).json({ error: 'This directory is already added as a source' });
      }
      throw addErr;
    }
    res.json(source);
    logger.info('settings', `Source added by ${req.user.email}: ${resolved}`);
    // Auto-scan the new source in background (scan + enrich)
    const watcher = require('../services/watcher');
    watcher.refreshWatchers().catch(() => {});
    watcher.runFullPipeline('source added').catch(() => {});
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

/** Remove a media source directory */
router.delete('/settings/sources/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    await scanner.removeSource(id);
    logger.info('settings', `Source removed by ${req.user.email}: id=${id}`);
    // Refresh watchers (stop watching removed source)
    const watcher = require('../services/watcher');
    watcher.refreshWatchers().catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

/* ═══════════════════════════════════════════════════════════════
   FILE BROWSER — Browse server filesystem directories
   ═══════════════════════════════════════════════════════════════ */

router.get('/browse', requireAdmin, async (req, res) => {
  try {
    const requestedPath = req.query.path || '/';
    const resolved = path.resolve(requestedPath);

    // Security: check path exists
    let stat;
    try { stat = await fsp.stat(resolved); } catch {
      return res.status(404).json({ error: 'Path not found' });
    }
    if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a directory' });

    // Read directory entries
    const entries = await fsp.readdir(resolved, { withFileTypes: true });
    const dirs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue; // hide dotfiles
      let readable = true;
      try { await fsp.access(path.join(resolved, entry.name), fs.constants.R_OK); } catch { readable = false; }
      dirs.push({ name: entry.name, path: path.join(resolved, entry.name), readable });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));

    // Count video files in this directory (non-recursive)
    let videoCount = 0;
    for (const entry of entries) {
      if (entry.isFile() && scanner.VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) {
        videoCount++;
      }
    }

    res.json({
      current: resolved,
      parent: resolved === '/' ? null : path.dirname(resolved),
      dirs,
      videoCount,
    });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});

/* ═══════════════════════════════════════════════════════════════
   DATABASE MANAGEMENT
   ═══════════════════════════════════════════════════════════════ */

router.post('/clear', requireAdmin, async (req, res) => {
  try {
    await db.clearAll();
    logger.warn('api', `Database cleared by ${req.user.email}`);
    res.json({ message: 'Database cleared' });
  } catch (e) { logger.error('api', `Clear DB error: ${e.message}`); res.status(500).json({ error: safeError(e) }); }
});

module.exports = router;
