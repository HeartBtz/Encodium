/**
 * services/webhook.js — Webhook notification service
 *
 * Extracted from encoder.js. Sends notification when the encoding queue
 * is empty (supports Discord and generic HTTP webhooks).
 */
'use strict';

const db = require('../db');
const logger = require('./logger');

/**
 * Check if queue is empty and fire webhook notification if configured.
 */
async function checkAndFire() {
  try {
    const pool = db.getPool();
    const [[{ cnt }]] = await pool.query(
      "SELECT COUNT(*) as cnt FROM encode_jobs WHERE status IN ('pending','encoding')"
    );
    if (parseInt(cnt, 10) > 0) return; // still jobs running

    const webhookEnabled = await db.getSetting('webhook_enabled', '0');
    if (webhookEnabled !== '1') return;
    const webhookUrl = await db.getSetting('webhook_url', '');
    if (!webhookUrl) return;

    // Gather summary
    const [[summary]] = await pool.query(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) as done,
              SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as errors
       FROM encode_jobs WHERE ended_at > DATE_SUB(NOW(), INTERVAL 1 DAY)`
    );

    const isDiscord = webhookUrl.includes('discord.com/api/webhooks');
    const payload = isDiscord
      ? { content: `✅ **Encodium** — Encoding queue completed\n🎬 ${summary.done || 0} succeeded · ❌ ${summary.errors || 0} error(s)` }
      : { event: 'queue_complete', done: summary.done || 0, errors: summary.errors || 0, total: summary.total || 0 };

    const httpMod = webhookUrl.startsWith('https') ? require('https') : require('http');
    const body = JSON.stringify(payload);
    const url = new URL(webhookUrl);
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    };
    const req = httpMod.request(options, () => {});
    req.on('timeout', () => { req.destroy(); logger.warn('encoder', 'Webhook request timed out'); });
    req.on('error', (e) => logger.warn('encoder', `Webhook error: ${e.message}`));
    req.write(body);
    req.end();

    logger.info('encoder', `Webhook sent to ${url.hostname}`);
  } catch (e) {
    logger.warn('encoder', `Webhook check error: ${e.message}`);
  }
}

module.exports = { checkAndFire };
