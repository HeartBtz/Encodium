/**
 * routes/api.js — All API endpoints for Encodium
 */
'use strict';

const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const path     = require('path');
const fs       = require('fs');

const db         = require('../db');
const scanner    = require('../scanner');
const gpuDetect  = require('../services/gpu-detect');
const encoder    = require('../services/encoder');
const logger     = require('../services/logger');
const { signToken, verifyToken, requireAuth, requireAdmin } = require('../middleware/auth');

/* ═══════════════════════════════════════════════════════════════
   AUTH
   ═══════════════════════════════════════════════════════════════ */

router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await db.getUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    await db.updateLastLogin(user.id);
    res.json({ token: signToken(user), user: { id: user.id, email: user.email, role: user.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/auth/me', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user.id, email: user.email, role: user.role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════════════════════════════
   SCANNER
   ═══════════════════════════════════════════════════════════════ */

router.post('/scan', requireAuth, async (req, res) => {
  try {
    const state = scanner.getState();
    if (state.running) return res.status(409).json({ error: 'Scan already in progress' });
    logger.info('scanner', 'Scan triggered by user');
    scanner.scanDirectory().catch(e => logger.error('scanner', `Scan error: ${e.message}`));
    res.json({ message: 'Scan started' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/scan/progress', requireAuth, (req, res) => {
  res.json(scanner.getState());
});

router.post('/scan/cancel', requireAuth, (req, res) => {
  scanner.cancelScan();
  res.json({ message: 'Scan cancelled' });
});

router.post('/enrich', requireAuth, async (req, res) => {
  try {
    const enrichState = scanner.getEnrichProgress();
    if (enrichState.running) return res.status(409).json({ error: 'Enrichment already in progress' });
    const state = scanner.getState();
    if (state.running) return res.status(409).json({ error: 'Scan in progress' });
    logger.info('enrich', 'Metadata enrichment triggered by user');
    scanner.enrichVideoMeta().catch(e => logger.error('enrich', `Enrichment error: ${e.message}`));
    res.json({ message: 'Metadata enrichment started' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/enrich/progress', requireAuth, (req, res) => {
  res.json(scanner.getEnrichProgress());
});

router.post('/thumbs', requireAuth, async (req, res) => {
  try {
    const thumbsState = scanner.getThumbsProgress();
    if (thumbsState.running) return res.status(409).json({ error: 'Thumbnail generation already in progress' });
    logger.info('thumbs', 'Thumbnail generation triggered by user');
    scanner.generateMissingThumbs().catch(e => logger.error('thumbs', `Thumbs error: ${e.message}`));
    res.json({ message: 'Thumbnail generation started' });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    const {
      q = '',              // search query (filename / folder)
      folder = '',         // exact folder filter
      codec = '',          // video_codec filter
      sort = 'filename',   // sort column
      order = 'asc',       // asc | desc
      page = 1,
      limit = 50,
    } = req.query;

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
      where.push('v.codec = ?');
      params.push(codec);
    }

    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const allowedSorts = ['filename', 'folder', 'size', 'duration', 'codec', 'width', 'created_at'];
    const sortCol = allowedSorts.includes(sort) ? sort : 'filename';
    const sortDir = order.toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    const lim = Math.min(200, Math.max(1, parseInt(limit, 10)));
    const off = Math.max(0, (parseInt(page, 10) - 1)) * lim;

    const [rows] = await pool.query(
      `SELECT v.* FROM videos v ${whereSQL} ORDER BY v.${sortCol} ${sortDir} LIMIT ? OFFSET ?`,
      [...params, lim, off]
    );
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM videos v ${whereSQL}`,
      params
    );

    res.json({ videos: rows, total, page: parseInt(page, 10), pages: Math.ceil(total / lim) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/videos/:id', requireAuth, async (req, res) => {
  try {
    const pool = db.getPool();
    const [[video]] = await pool.query('SELECT * FROM videos WHERE id=?', [req.params.id]);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    res.json(video);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/folders', requireAuth, async (req, res) => {
  try {
    const pool = db.getPool();
    const [rows] = await pool.query(
      `SELECT folder, COUNT(*) as count, SUM(size) as total_size
       FROM videos GROUP BY folder ORDER BY folder`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/codec-stats', requireAuth, async (req, res) => {
  try {
    const pool = db.getPool();
    const [rows] = await pool.query(
      `SELECT COALESCE(codec,'unknown') as codec, COUNT(*) as count, SUM(size) as total_size
       FROM videos GROUP BY codec ORDER BY count DESC`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    res.json({ videos: vStats, jobs: jStats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════════════════════════════
   THUMBNAILS
   ═══════════════════════════════════════════════════════════════ */

router.get('/thumb/:id', (req, res) => {
  const thumbPath = path.join(__dirname, '..', 'data', 'thumbs', `v_${req.params.id}.jpg`);
  if (fs.existsSync(thumbPath)) return res.sendFile(thumbPath);
  res.status(404).end();
});

/* ═══════════════════════════════════════════════════════════════
   ENCODING
   ═══════════════════════════════════════════════════════════════ */

router.get('/encode/capabilities', requireAuth, async (req, res) => {
  try {
    const caps = await gpuDetect.detectAll(!!req.query.refresh);
    res.json(caps);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/encode/status', requireAuth, (req, res) => {
  res.json(encoder.getStatus());
});

router.get('/encode/history', requireAuth, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const data = await encoder.getHistory(parseInt(limit, 10), parseInt(offset, 10));
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/encode/enqueue', requireAuth, async (req, res) => {
  try {
    const { videoIds, presetId, replaceOriginal } = req.body;
    if (!presetId) return res.status(400).json({ error: 'presetId required' });
    const ids = Array.isArray(videoIds) ? videoIds : [videoIds];
    if (!ids.length) return res.status(400).json({ error: 'videoIds required' });
    const jobIds = await encoder.enqueueBatch(ids, presetId, !!replaceOriginal);
    res.json({ jobs: jobIds });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/encode/cancel/:id', requireAuth, (req, res) => {
  const ok = encoder.cancelJob(parseInt(req.params.id, 10));
  res.json({ cancelled: ok });
});

router.post('/encode/cancel-all', requireAuth, async (req, res) => {
  const n = await encoder.cancelPending();
  res.json({ cancelled: n });
});

router.post('/encode/retry/:id', requireAuth, async (req, res) => {
  try {
    await encoder.retryJob(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/encode/job/:id', requireAuth, async (req, res) => {
  try {
    await encoder.deleteJob(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/encode/workers', requireAuth, (req, res) => {
  const { count } = req.body;
  if (!count || count < 1 || count > 8) return res.status(400).json({ error: 'count 1-8' });
  const n = encoder.setWorkerCount(count);
  res.json({ workers: n });
});

/* SSE stream for real-time updates (token via query param for EventSource) */
router.get('/events', (req, res) => {
  const tkn = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  try {
    verifyToken(tkn);
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('event: connected\ndata: {}\n\n');
  encoder.addSSEClient(res);
  logger.addClient(res);
  req.on('close', () => { logger.removeClient(res); });
});

/* ═══════════════════════════════════════════════════════════════
   LOGS — Recent logs endpoint
   ═══════════════════════════════════════════════════════════════ */

router.get('/logs', requireAuth, (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit || '100', 10));
  const level = req.query.level || 'info';
  res.json(logger.getRecent(limit, level));
});

/* ═══════════════════════════════════════════════════════════════
   DATABASE MANAGEMENT
   ═══════════════════════════════════════════════════════════════ */

router.post('/clear', requireAdmin, async (req, res) => {
  try {
    await db.clearAll();
    res.json({ message: 'Database cleared' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
