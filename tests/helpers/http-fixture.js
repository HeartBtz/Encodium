'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const bcrypt = require('bcryptjs');
const load = require('./load-module');

module.exports = async function createFixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'encodium-http-'));
  const media = path.join(root, 'media');
  const thumbs = path.join(root, 'thumbs');
  await fs.mkdir(media);
  await fs.mkdir(thumbs);
  const env = { NODE_ENV: 'production', JWT_SECRET: 'fixture-only-jwt-signing-key-at-least-32', COOKIE_SECURE: 'false', TRUST_PROXY: '', CORS_ORIGINS: '', AUTH_RETURN_BEARER_TOKEN: 'false', ENCODE_DIR: media, ...options.env };
  const users = new Map([[1, { id: 1, role: 'admin', email: 'admin@example.test', password_hash: await bcrypt.hash('fixture-password', 4) }], [2, { id: 2, role: 'member', email: 'member@example.test', password_hash: await bcrypt.hash('fixture-password', 4) }]]);
  const calls = [];
  const videos = [{ id: 1, filename: 'fixture.mp4', file_path: path.join(media, 'fixture.mp4'), folder: '(root)', size: 999, codec: 'h264', width: 16, height: 16, duration: 1 }];
  await fs.writeFile(videos[0].file_path, '0123456789');
  const pool = { query: async (sql, params = []) => {
    calls.push({ sql, params });
    if (options.query) {
      const result = await options.query(sql, params);
      if (result !== undefined) return result;
    }
    if (sql === 'SELECT path FROM media_sources') return [[{ path: media }]];
    if (sql.includes('FROM videos')) {
      if (sql.includes('COUNT(*)')) return [[{ total: videos.length, count: videos.length, total_size: 10, total_duration: 1 }]];
      if (sql.includes('GROUP BY folder')) return [[{ folder: '(root)', count: 1, total_size: 10 }]];
      if (sql.includes('GROUP BY codec')) return [[{ codec: 'h264', count: 1, total_size: 10 }]];
      return [videos];
    }
    if (sql.includes('encoding_savings')) return [[{ encoded_count: 0, total_before: 0, total_after: 0, total_saved: 0 }]];
    if (sql.includes('COUNT(*)') && sql.includes('encode_jobs')) return [[{ total: 0, pending: 0, encoding: 0, done: 0, errors: 0, cancelled: 0 }]];
    if (sql.startsWith('DELETE FROM videos')) { videos.splice(0); return [{ affectedRows: 1 }]; }
    return [[]];
  } };
  const db = {
    getPool: () => pool,
    getUserById: async id => users.get(id),
    getUserByEmail: async email => [...users.values()].find(u => u.email === email),
    updateLastLogin: async () => {},
    getSetting: async (_key, fallback) => fallback,
    setSetting: async (key, value) => { calls.push({ setting: key, value }); },
    withIdleVideos: async (ids, action) => action(pool, videos.filter(v => ids.includes(v.id))),
    clearAll: async () => { calls.push({ clear: true }); },
  };
  const idle = () => ({ running: false });
  const scanner = { THUMB_DIR: thumbs, getState: idle, getSyncProgress: idle, getEnrichProgress: idle, getThumbsProgress: idle, getSources: async () => [{ id: 1, path: media, enabled: 1 }], generateThumb: async () => null, VIDEO_EXTS: new Set(['.mp4']) };
  const encoder = {
    getStatus: () => ({ activeJobs: 0, workerCount: 1, paused: true, active: [] }),
    getHistory: async () => ({ rows: [], counts: {}, total: 0 }),
    enqueueBatch: async (...args) => { calls.push({ enqueue: args }); return { jobs: [10], skipped: [] }; },
    cancelJob: async () => true, cancelAll: async () => 1, setWorkerCount: n => n,
    addSSEClient: () => {}, removeSSEClient: () => {},
  };
  const logger = Object.fromEntries(['info', 'warn', 'error', 'success', 'debug', 'removeClient'].map(k => [k, () => {}]));
  logger.addClient = () => calls.push({ logSubscription: true });
  logger.getRecent = () => [];
  const auth = load('middleware/auth.js', { '../db': db }, { env });
  const web = load('services/web-security.js', {}, { env });
  const files = load('services/media-files.js', { '../db': db }, { env });
  const api = load('routes/api.js', {
    '../db': db, '../scanner': scanner, '../services/encoder': encoder,
    '../services/gpu-detect': { detectAll: async () => ({ presets: [{ id: 'cpu_h265', codec: 'h265', label: 'CPU fixture', encoder: 'libx265' }] }) },
    '../middleware/auth': auth, '../services/logger': logger, '../services/media-files': files,
  }, { env });
  const app = load('server.js', {
    dotenv: { config: () => {} }, './db': db, './services/encoder': encoder,
    './services/watcher': {}, './routes/api': api, './services/web-security': web,
  }, { env });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return {
    root, media, thumbs, users, videos, calls, db, encoder, scanner, auth, app, server,
    url: `http://127.0.0.1:${server.address().port}`,
    cookie: (id = 1) => `encodium_session=${auth.signToken(users.get(id))}`,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); },
  };
};
