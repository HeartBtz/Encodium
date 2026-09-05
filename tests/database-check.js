'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const mysql = require('mysql2/promise');
const load = require('./helpers/load-module');

(async () => {
  const port = Number(process.env.ENCODIUM_TEST_DB_PORT);
  if (!Number.isInteger(port) || port <= 1024) throw new Error('Set ENCODIUM_TEST_DB_PORT to a disposable loopback MariaDB container port');
  const admin = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: 'fixture-only' });
  const database = `encodium_audit_${crypto.randomBytes(8).toString('hex')}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'encodium-db-'));
  let db;
  try {
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`);
    db = load('db.js', { dotenv: { config: () => {} } }, { env: { DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_USER: 'root', DB_PASS: 'fixture-only', DB_NAME: database, MEDIA_DIR: '' } });
    await db.initSchema();
    const pool = db.getPool();
    await db.createUser('fixture', 'fixture@example.test', 'not-a-real-password-hash');
    await db.setSetting('fixture', 'retained');
    await pool.query("INSERT INTO videos (id, filename, file_path, size) VALUES (10, 'legacy.mp4', '/fixture/legacy.mp4', 100)");
    await pool.query('ALTER TABLE encode_jobs ADD COLUMN file_size_after BIGINT, ADD COLUMN finished_at DATETIME');
    await pool.query("INSERT INTO encode_jobs (video_id, status, file_size_before, file_size_after, finished_at, preset_json) VALUES (10, 'done', 100, 40, '2026-01-01 00:00:00', ?)", [JSON.stringify({ codec: 'h265' })]);
    await db.initSchema();
    await db.initSchema();
    const [[migrated]] = await pool.query('SELECT output_size, ended_at, file_size_after FROM encode_jobs WHERE video_id=10');
    assert.equal(migrated.output_size, 40);
    assert.equal(migrated.file_size_after, 40);
    assert.equal(migrated.ended_at.toISOString(), '2026-01-01T00:00:00.000Z');
    const [[ledger]] = await pool.query('SELECT COUNT(*) AS count, SUM(saved) AS saved FROM encoding_savings');
    assert.equal(ledger.count, 1);
    assert.equal(Number(ledger.saved), 60);
    await pool.query('UPDATE encode_jobs SET output_size=0');
    await db.initSchema();
    assert.equal((await pool.query('SELECT output_size FROM encode_jobs'))[0][0].output_size, 0, 'legacy copy must not resurrect an intentionally cleared output');
    await pool.query("INSERT INTO encode_jobs (video_id, status) VALUES (10, 'pending')");
    await assert.rejects(db.clearAll(), { status: 409 });
    const [[kept]] = await pool.query('SELECT COUNT(*) AS count FROM videos');
    assert.equal(kept.count, 1);
    await pool.query("UPDATE encode_jobs SET status='cancelled' WHERE status='pending'");
    await assert.rejects(db.withIdleVideos([10], async conn => {
      await conn.query('DELETE FROM videos WHERE id=10');
      throw new Error('Injected failure');
    }), /Injected/);
    assert.equal((await pool.query('SELECT id FROM videos WHERE id=10'))[0].length, 1);

    const sources = [path.join(root, 'a_%'), path.join(root, 'abX'), path.join(root, 'a_%', 'nested')];
    for (const source of sources) await fs.mkdir(source, { recursive: true });
    for (const source of sources) await pool.query('INSERT INTO media_sources (path) VALUES (?)', [source]);
    for (const [i, source] of sources.entries()) await pool.query('INSERT INTO videos (id, filename, file_path) VALUES (?, ?, ?)', [20 + i, 'film.mp4', path.join(source, 'film.mp4')]);
    const scanner = load('scanner.js', { './db': db, dotenv: { config: () => {} }, './services/ffprobe': {}, './services/media-files': load('services/media-files.js', { '../db': db }) }, { env: { THUMB_DIR: path.join(root, 'thumbs') } });
    const [[source]] = await pool.query('SELECT id FROM media_sources WHERE path=?', [sources[0]]);
    await scanner.removeSource(source.id);
    assert.equal((await pool.query('SELECT id FROM videos WHERE id=20'))[0].length, 0);
    assert.equal((await pool.query('SELECT id FROM videos WHERE id IN (21,22)'))[0].length, 2);
    await assert.rejects(scanner.syncDatabase(), /empty/);
    assert.equal((await pool.query('SELECT id FROM videos WHERE id IN (21,22)'))[0].length, 2);
    for (const dir of sources.slice(1)) await fs.writeFile(path.join(dir, 'mount-marker.txt'), 'fixture');
    const thumbnail = path.join(root, 'thumbs', 'v_21.jpg');
    await fs.writeFile(thumbnail, 'fixture-thumb');
    await pool.query("INSERT INTO encode_jobs (video_id, status) VALUES (21, 'pending')");
    await scanner.syncDatabase();
    assert.equal(scanner.getSyncProgress().removed, 0);
    assert.equal(await fs.readFile(thumbnail, 'utf8'), 'fixture-thumb');
    await pool.query("UPDATE encode_jobs SET status='cancelled' WHERE status='pending'");
    await scanner.syncDatabase();
    assert.equal(scanner.getSyncProgress().removed, 2);
    await assert.rejects(fs.stat(thumbnail), { code: 'ENOENT' });
    await db.clearAll();
    assert.equal((await pool.query('SELECT id FROM videos'))[0].length, 0);
    assert.equal((await db.listUsers()).length, 1);
    assert.equal(await db.getSetting('fixture'), 'retained');
    assert.equal((await pool.query('SELECT id FROM media_sources'))[0].length, 2);
    const [newVideo] = await pool.query("INSERT INTO videos (filename, file_path) VALUES ('next.mp4', '/fixture/next.mp4')");
    assert.ok(newVideo.insertId > 22, 'clear must not reset auto-increment IDs');
    for (let i = 0; i < 10; i++) {
      const conn = await pool.getConnection();
      const [[state]] = await conn.query('SELECT @@FOREIGN_KEY_CHECKS AS enabled');
      assert.equal(state.enabled, 1);
      conn.release();
    }
    console.log('PASS MariaDB: schema creation, additive legacy data copy, migration replay, busy clear refusal, rollback, literal/nested source removal, sync mount/busy protections, clear ID/FK/user/settings preservation');
  } finally {
    await db?.getPool().end();
    await admin.query(`DROP DATABASE ${database}`);
    await admin.end();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
