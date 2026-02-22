/**
 * server.js — Encodium entry point
 */
'use strict';

require('dotenv').config({ override: true });

const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

const db      = require('./db');
const encoder = require('./services/encoder');
const watcher = require('./services/watcher');
const api     = require('./routes/api');
const { version } = require('./package.json');

const PORT = parseInt(process.env.PORT || '4000', 10);
const app  = express();

/* ─── Security & middleware ───────────────────────────────── */
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false,
}));
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 1200,
  standardHeaders: true,
  legacyHeaders: false,
  // Don't count thumbnails, SSE events, or static assets against the limit
  skip: (req) => {
    const p = req.path;
    return p.startsWith('/api/thumb/') || p.startsWith('/api/events');
  },
});

/* ─── Static files ────────────────────────────────────────── */
app.use(express.static(path.join(__dirname, 'public')));

/* ─── API ─────────────────────────────────────────────────── */
app.use('/api', apiLimiter, api);

/* ─── SPA fallback ────────────────────────────────────────── */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ─── Boot ────────────────────────────────────────────────── */
async function boot() {
  // DB init with retry
  for (let i = 0; i < 10; i++) {
    try {
      await db.initSchema();
      console.log('[db] Schema ready');
      break;
    } catch (e) {
      console.error(`[db] Init attempt ${i + 1} failed:`, e.message);
      if (i === 9) { console.error('[db] Giving up'); process.exit(1); }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Start encode queue processor (recovers stalled jobs from DB)
  await encoder.start();

  // Start file watcher & auto-sync service
  await watcher.start();

  app.listen(PORT, () => {
    console.log(`\n  ╔══════════════════════════════════════╗`);
    console.log(`  ║   Encodium v${version.padEnd(24)}║`);
    console.log(`  ║   http://localhost:${PORT}              ║`);
    console.log(`  ╚══════════════════════════════════════╝\n`);
  });

  /* ── Graceful shutdown ─────────────────────────────────── */
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;   // prevent double-shutdown
    shuttingDown = true;
    const mem = process.memoryUsage();
    const rss = (mem.rss / 1e6).toFixed(0);
    const heap = (mem.heapUsed / 1e6).toFixed(0);
    console.log(`\n[server] ${signal} received — RSS: ${rss}MB, Heap: ${heap}MB — shutting down gracefully…`);
    console.log(`[server] Active encoding jobs: ${encoder.getStatus().activeJobs}`);
    watcher.stop();
    encoder.stop();
    // Give ffmpeg processes time to exit after SIGTERM (up to 8s)
    const deadline = Date.now() + 8000;
    while (encoder.getStatus().activeJobs > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
    }
    try { await db.getPool().end(); } catch {}
    console.log('[server] Cleanup complete. Exiting.');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

boot().catch(e => { console.error('Boot failed:', e); process.exit(1); });
