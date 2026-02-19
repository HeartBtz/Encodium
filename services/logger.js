/**
 * services/logger.js — Centralized log system for Encodium
 *
 * Captures all app events in memory (ring buffer) and streams
 * them to connected SSE clients in real-time.
 */
'use strict';

const MAX_ENTRIES = 500;
const logs = [];
const sseClients = new Set();

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, success: 4 };

/**
 * Add a log entry and broadcast to SSE clients
 * @param {'debug'|'info'|'warn'|'error'|'success'} level
 * @param {string} source - Module name (scanner, encoder, db, system…)
 * @param {string} message
 * @param {object} [extra] - Optional structured data
 */
function log(level, source, message, extra = null) {
  const entry = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    ts: new Date().toISOString(),
    level,
    source,
    message,
    extra,
  };

  logs.push(entry);
  if (logs.length > MAX_ENTRIES) logs.shift();

  // Broadcast to SSE clients
  const data = JSON.stringify(entry);
  for (const client of sseClients) {
    try {
      client.write(`event: log\ndata: ${data}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }

  // Also log to console (PM2 captures this)
  const prefix = `[${source}]`;
  if (level === 'error') console.error(prefix, message, extra || '');
  else if (level === 'warn') console.warn(prefix, message, extra || '');
  else console.log(prefix, message, extra ? JSON.stringify(extra) : '');
}

/** Convenience wrappers */
const info    = (source, msg, extra) => log('info', source, msg, extra);
const warn    = (source, msg, extra) => log('warn', source, msg, extra);
const error   = (source, msg, extra) => log('error', source, msg, extra);
const success = (source, msg, extra) => log('success', source, msg, extra);
const debug   = (source, msg, extra) => log('debug', source, msg, extra);

/** Get recent logs (for initial page load) */
function getRecent(limit = 100, minLevel = 'info') {
  const min = LEVELS[minLevel] || 0;
  return logs.filter(l => (LEVELS[l.level] || 0) >= min).slice(-limit);
}

/** Register/unregister SSE client */
function addClient(res) { sseClients.add(res); }
function removeClient(res) { sseClients.delete(res); }

module.exports = {
  log, info, warn, error, success, debug,
  getRecent, addClient, removeClient,
};
