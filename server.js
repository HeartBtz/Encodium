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
const api     = require('./routes/api');

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

const apiLimiter = rateLimit({ windowMs: 60_000, max: 600, standardHeaders: true, legacyHeaders: false });

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

  app.listen(PORT, () => {
    console.log(`\n  ╔══════════════════════════════════════╗`);
    console.log(`  ║   Encodium v1.0.0                    ║`);
    console.log(`  ║   http://localhost:${PORT}              ║`);
    console.log(`  ╚══════════════════════════════════════╝\n`);
  });
}

boot().catch(e => { console.error('Boot failed:', e); process.exit(1); });
