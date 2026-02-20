/**
 * routes/api.js — All API endpoints for Encodium
 */
'use strict';

const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const path     = require('path');
const fs       = require('fs');
const fsp      = require('fs/promises');

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

router.post('/sync', requireAuth, async (req, res) => {
  try {
    const syncState = scanner.getSyncProgress();
    if (syncState.running) return res.status(409).json({ error: 'Sync already in progress' });
    const scanState = scanner.getState();
    if (scanState.running) return res.status(409).json({ error: 'Scan in progress, cannot sync simultaneously' });
    logger.info('sync', 'Database sync triggered by user');
    scanner.syncDatabase().catch(e => logger.error('sync', `Sync error: ${e.message}`));
    res.json({ message: 'Sync started' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/sync/progress', requireAuth, (req, res) => {
  res.json(scanner.getSyncProgress());
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
      if (codec === 'unknown') {
        where.push("(v.codec IS NULL OR v.codec = '')");
      } else {
        where.push('v.codec = ?');
        params.push(codec);
      }
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

router.post('/videos/delete', requireAuth, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
    const pool = db.getPool();
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await pool.query(`SELECT id, file_path FROM videos WHERE id IN (${placeholders})`, ids);
    logger.info('api', `Delete request: ${ids.length} id(s) sent, ${rows.length} found in DB`);
    let deleted = 0, fileErrors = [];
    for (const v of rows) {
      // Delete physical file
      if (v.file_path) {
        try { await fsp.unlink(v.file_path); } catch (e) {
          if (e.code !== 'ENOENT') fileErrors.push({ id: v.id, error: e.message });
        }
      }
      // Delete thumbnail
      const thumbPath = path.join(__dirname, '..', 'data', 'thumbs', `v_${v.id}.jpg`);
      try { await fsp.unlink(thumbPath); } catch {}
      deleted++;
    }
    // Batch delete from DB (cascade handles encode_jobs via FK)
    if (deleted > 0) {
      const delIds = rows.map(v => v.id);
      const ph = delIds.map(() => '?').join(',');
      await pool.query(`DELETE FROM encode_jobs WHERE video_id IN (${ph})`, delIds);
      await pool.query(`DELETE FROM videos WHERE id IN (${ph})`, delIds);
    }
    logger.info('api', `Deleted ${deleted} video(s) (requested: ${ids.length})`);
    res.json({ deleted, fileErrors });
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
        media: scanner.MEDIA_DIR,
        thumbs: scanner.THUMB_DIR,
        encode: process.env.ENCODE_DIR || path.join(__dirname, '..', 'data', 'encoded'),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════════════════════════════
   THUMBNAILS
   ═══════════════════════════════════════════════════════════════ */

router.get('/thumb/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const thumbPath = path.join(__dirname, '..', 'data', 'thumbs', `v_${id}.jpg`);

  // Already exists → serve immediately
  if (fs.existsSync(thumbPath)) return res.sendFile(thumbPath);

  // Generate on the fly
  try {
    const pool = db.getPool();
    const [[video]] = await pool.query('SELECT file_path FROM videos WHERE id=?', [id]);
    if (!video || !video.file_path) return res.status(404).end();

    const result = await scanner.generateThumb(video.file_path, id);
    if (result && fs.existsSync(thumbPath)) {
      // Update DB so we know it exists
      await pool.query('UPDATE videos SET thumb_path=? WHERE id=?', [thumbPath, id]);
      return res.sendFile(thumbPath);
    }
    res.status(404).end();
  } catch {
    res.status(404).end();
  }
});

/* ═══════════════════════════════════════════════════════════════
   VIDEO STREAMING
   ═══════════════════════════════════════════════════════════════ */

router.get('/stream/:id', async (req, res) => {
  // Token via query param for <video> tag
  const tkn = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  try { verifyToken(tkn); } catch { return res.status(401).json({ error: 'Invalid token' }); }

  try {
    const pool = db.getPool();
    const [rows] = await pool.query('SELECT file_path, size FROM videos WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const video = rows[0];
    const filePath = video.file_path;
    const fileSize = video.size || fs.statSync(filePath).size;

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : Math.min(start + 5 * 1024 * 1024, fileSize - 1);
      const chunkSize = end - start + 1;

      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === '.mkv' ? 'video/x-matroska' : ext === '.webm' ? 'video/webm' : 'video/mp4';

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mime,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === '.mkv' ? 'video/x-matroska' : ext === '.webm' ? 'video/webm' : 'video/mp4';
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    let { videoIds, presetId, replaceOriginal, container, downscale, tonemap, force } = req.body;
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
      // Override with custom CQ
      hwPreset.cq = cp.cq;
      container = cp.container || 'auto';
      downscale = cp.downscale || '';
      tonemap = !!cp.tonemap;
    }

    const opts = { container: container || 'auto', downscale: downscale || '', tonemap: !!tonemap, force: !!force };
    const result = await encoder.enqueueBatch(ids, presetId, !!replaceOriginal, opts);
    res.json({ jobs: result.jobs, skipped: result.skipped });
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

router.post('/encode/clear-finished', requireAuth, async (req, res) => {
  try {
    const n = await encoder.clearFinished();
    res.json({ cleared: n });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

/* Clear encode_skip flag for given video ids */
router.post('/videos/clear-skip', requireAuth, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
    const pool = db.getPool();
    const ph = ids.map(() => '?').join(',');
    const [result] = await pool.query(`UPDATE videos SET encode_skip = 0 WHERE id IN (${ph})`, ids);
    res.json({ cleared: result.affectedRows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Job log endpoint — returns detailed per-job ffmpeg log */
router.get('/encode/job/:id/log', requireAuth, async (req, res) => {
  try {
    const log = await encoder.getJobLog(parseInt(req.params.id, 10));
    if (log === null) return res.status(404).json({ error: 'Log not found' });
    res.type('text/plain').send(log);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Job priority — set priority of a pending job */
router.post('/encode/job/:id/priority', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { priority } = req.body;
    const pVal = Math.max(-10, Math.min(10, parseInt(priority, 10) || 0));
    const pool = db.getPool();
    await pool.query("UPDATE encode_jobs SET priority=? WHERE id=? AND status='pending'", [pVal, id]);
    res.json({ ok: true, priority: pVal });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Move job up/down in queue */
router.post('/encode/job/:id/move', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { direction } = req.body; // 'up' or 'down'
    const pool = db.getPool();
    const delta = direction === 'up' ? 1 : -1;
    await pool.query("UPDATE encode_jobs SET priority = priority + ? WHERE id=? AND status='pending'", [delta, id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  req.on('close', () => { encoder.removeSSEClient(res); logger.removeClient(res); });
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════════════════════════════
   CUSTOM PRESETS
   ═══════════════════════════════════════════════════════════════ */

router.get('/custom-presets', requireAuth, async (req, res) => {
  try {
    const pool = db.getPool();
    const [rows] = await pool.query('SELECT * FROM custom_presets ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/custom-presets', requireAuth, async (req, res) => {
  try {
    const { name, codec, cq, container, downscale, tonemap, extra_args } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const pool = db.getPool();
    const [result] = await pool.query(
      'INSERT INTO custom_presets (name, codec, cq, container, downscale, tonemap, extra_args) VALUES (?,?,?,?,?,?,?)',
      [name, codec || 'h265', cq || 23, container || 'auto', downscale || '', tonemap ? 1 : 0, extra_args || '']
    );
    res.json({ id: result.insertId, ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/custom-presets/:id', requireAuth, async (req, res) => {
  try {
    const pool = db.getPool();
    await pool.query('DELETE FROM custom_presets WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/settings/schedule', requireAuth, async (req, res) => {
  try {
    const { enabled, start, end } = req.body;
    if (enabled !== undefined) await db.setSetting('schedule_enabled', enabled ? '1' : '0');
    if (start !== undefined) await db.setSetting('schedule_start', String(Math.max(0, Math.min(23, parseInt(start, 10)))));
    if (end !== undefined)   await db.setSetting('schedule_end', String(Math.max(1, Math.min(24, parseInt(end, 10)))));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════════════════════════════
   SETTINGS — Notifications (webhooks)
   ═══════════════════════════════════════════════════════════════ */

router.get('/settings/notifications', requireAuth, async (req, res) => {
  try {
    const webhookUrl = await db.getSetting('webhook_url', '');
    const webhookEnabled = await db.getSetting('webhook_enabled', '0');
    res.json({ enabled: webhookEnabled === '1', url: webhookUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/settings/notifications', requireAuth, async (req, res) => {
  try {
    const { enabled, url } = req.body;
    if (enabled !== undefined) await db.setSetting('webhook_enabled', enabled ? '1' : '0');
    if (url !== undefined) await db.setSetting('webhook_url', String(url).trim());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
