/**
 * db.js — Encodium database layer
 *
 * Own MariaDB database with tables:
 *   - users        : admin authentication
 *   - videos       : scanned video files
 *   - encode_jobs  : encoding queue & history
 *   - settings     : key-value app settings
 */
'use strict';

require('dotenv').config({ override: true });
const mysql = require('mysql2/promise');

const DB_PASS = process.env.DB_PASS;
if (!DB_PASS) console.warn('  ⚠️  DB_PASS non défini — utilisation du mot de passe par défaut.');

const pool = mysql.createPool({
  host:     process.env.DB_HOST || 'localhost',
  port:     Number(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER || 'encodium',
  password: DB_PASS || 'encodium2026',
  database: process.env.DB_NAME || 'encodium',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  timezone: '+00:00',
});

async function safeAlter(conn, sql) {
  try { await conn.query(sql); } catch (e) {
    // Ignore "duplicate column", "column doesn't exist" (for CHANGE), "Unknown column" etc.
    if (e.errno === 1060 || e.errno === 1054 || e.errno === 1091) return;
    // If it's just "can't drop / already exists" type, also ignore
    if (e.message && e.message.includes('Duplicate')) return;
    console.warn(`[DB] migration skipped: ${e.message}`);
  }
}

async function initSchema() {
  const conn = await pool.getConnection();
  try {
    // ── Users ──
    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(100) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        role ENUM('admin','member') DEFAULT 'admin',
        avatar VARCHAR(500),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // ── Videos (scanned files) ──
    await conn.query(`
      CREATE TABLE IF NOT EXISTS videos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        folder VARCHAR(500) COMMENT 'parent folder name (category/performer)',
        filename VARCHAR(500) NOT NULL,
        file_path VARCHAR(1000) NOT NULL UNIQUE,
        size BIGINT DEFAULT 0,
        duration FLOAT,
        codec VARCHAR(50),
        width INT,
        height INT,
        bitrate INT COMMENT 'kbps',
        fps FLOAT,
        audio_codec VARCHAR(50),
        audio_sample_rate INT,
        audio_channels INT,
        thumb_path VARCHAR(1000),
        favorite TINYINT DEFAULT 0,
        view_count INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_folder (folder),
        KEY idx_codec (codec),
        KEY idx_size (size),
        KEY idx_favorite (favorite)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // ── Encode jobs ──
    await conn.query(`
      CREATE TABLE IF NOT EXISTS encode_jobs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        video_id INT NOT NULL,
        target_codec VARCHAR(20) DEFAULT '' COMMENT 'h265 or av1',
        encoder VARCHAR(50) DEFAULT '' COMMENT 'hevc_nvenc, libx265, etc.',
        preset_id VARCHAR(100),
        preset_json TEXT,
        quality VARCHAR(20) DEFAULT 'balanced',
        replace_original TINYINT DEFAULT 0,
        status ENUM('pending','encoding','done','failed','error','cancelled') DEFAULT 'pending',
        progress TINYINT UNSIGNED DEFAULT 0,
        file_size_before BIGINT DEFAULT 0,
        output_size BIGINT DEFAULT 0,
        output_path VARCHAR(1000),
        error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        ended_at DATETIME,
        KEY idx_status (status),
        KEY idx_video (video_id),
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // ── Settings ──
    await conn.query(`
      CREATE TABLE IF NOT EXISTS settings (
        \`key\` VARCHAR(100) PRIMARY KEY,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // ── Migrations for existing databases ──
    await safeAlter(conn, 'ALTER TABLE encode_jobs ADD COLUMN preset_json TEXT AFTER preset_id');
    await safeAlter(conn, 'ALTER TABLE encode_jobs ADD COLUMN output_size BIGINT DEFAULT 0 AFTER file_size_before');
    await safeAlter(conn, 'ALTER TABLE encode_jobs ADD COLUMN ended_at DATETIME AFTER started_at');
    await safeAlter(conn, "ALTER TABLE encode_jobs MODIFY COLUMN target_codec VARCHAR(20) DEFAULT ''");
    await safeAlter(conn, "ALTER TABLE encode_jobs MODIFY COLUMN encoder VARCHAR(50) DEFAULT ''");
    await safeAlter(conn, "ALTER TABLE encode_jobs MODIFY COLUMN status ENUM('pending','encoding','done','failed','error','cancelled') DEFAULT 'pending'");
    // Migrate old column names if they exist
    await safeAlter(conn, 'ALTER TABLE encode_jobs CHANGE COLUMN file_size_after output_size BIGINT DEFAULT 0');
    await safeAlter(conn, 'ALTER TABLE encode_jobs CHANGE COLUMN finished_at ended_at DATETIME');
  } finally {
    conn.release();
  }
}

/* ── Video helpers ─────────────────────────────────────────────── */

async function getAllExistingPaths() {
  const [rows] = await pool.query('SELECT file_path FROM videos');
  return new Set(rows.map(r => r.file_path));
}

async function batchInsertVideos(records) {
  if (!records.length) return;
  const placeholders = records.map(() => '(?, ?, ?, ?)').join(', ');
  const values = records.flat();
  try {
    await pool.query(
      `INSERT IGNORE INTO videos (folder, filename, file_path, size) VALUES ${placeholders}`,
      values
    );
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return;
    console.error('[DB] batchInsertVideos error:', e.message);
  }
}

async function updateVideoMeta(id, meta) {
  await pool.query(
    `UPDATE videos SET
       duration          = COALESCE(?, duration),
       codec             = COALESCE(?, codec),
       width             = COALESCE(?, width),
       height            = COALESCE(?, height),
       bitrate           = COALESCE(?, bitrate),
       fps               = COALESCE(?, fps),
       audio_codec       = COALESCE(?, audio_codec),
       audio_sample_rate = COALESCE(?, audio_sample_rate),
       audio_channels    = COALESCE(?, audio_channels)
     WHERE id = ?`,
    [meta.duration, meta.codec, meta.width, meta.height, meta.bitrate,
     meta.fps, meta.audioCodec, meta.audioSampleRate, meta.audioChannels, id]
  );
}

async function updateVideoThumb(id, thumbPath) {
  await pool.query('UPDATE videos SET thumb_path = ? WHERE id = ?', [thumbPath, id]);
}

async function clearAll() {
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  await pool.query('TRUNCATE TABLE encode_jobs');
  await pool.query('TRUNCATE TABLE videos');
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');
}

/* ── Settings ──────────────────────────────────────────────────── */

async function getSetting(key, defaultValue = null) {
  const [rows] = await pool.query('SELECT value FROM settings WHERE `key` = ?', [key]);
  return rows.length ? rows[0].value : defaultValue;
}

async function setSetting(key, value) {
  await pool.query(
    'INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?, updated_at = NOW()',
    [key, value, value]
  );
}

/* ── Users ─────────────────────────────────────────────────────── */

async function createUser(username, email, passwordHash, role = 'admin') {
  const [res] = await pool.query(
    'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)',
    [username, email, passwordHash, role]
  );
  return res.insertId;
}

async function getUserByEmail(email) {
  const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  return rows[0] || null;
}

async function getUserById(id) {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
  return rows[0] || null;
}

async function updateLastLogin(userId) {
  await pool.query('UPDATE users SET last_login = NOW() WHERE id = ?', [userId]);
}

async function listUsers() {
  const [rows] = await pool.query(
    'SELECT id, username, email, role, created_at, last_login FROM users ORDER BY created_at DESC'
  );
  return rows;
}

async function deleteUser(userId) {
  await pool.query('DELETE FROM users WHERE id = ?', [userId]);
}

async function countAdmins() {
  const [[{ cnt }]] = await pool.query("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin'");
  return cnt;
}

function getPool() { return pool; }

module.exports = {
  pool, getPool, initSchema, clearAll,
  getAllExistingPaths, batchInsertVideos, updateVideoMeta, updateVideoThumb,
  getSetting, setSetting,
  createUser, getUserByEmail, getUserById, updateLastLogin, listUsers, deleteUser, countAdmins,
};
