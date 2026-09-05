/**
 * db.js — Encodium database layer
 *
 * MariaDB schema & helpers. Tables:
 *   - users             : admin authentication
 *   - videos            : scanned video files
 *   - encode_jobs       : encoding queue & history
 *   - settings          : key‑value app settings
 *   - encoding_savings  : persistent encode savings ledger
 *   - custom_presets    : user-defined encoding presets
 *   - media_sources     : configured media source directories
 */
'use strict';

require('dotenv').config({ override: true });
const mysql = require('mysql2/promise');

const DB_PASS = process.env.DB_PASS;
if (!DB_PASS) {
  console.error('\n  ❌  DB_PASS is not set! The database password must be configured.');
  console.error('     Set DB_PASS in your .env file or environment variables.\n');
  process.exit(1);
}

const pool = mysql.createPool({
  host:     process.env.DB_HOST || 'localhost',
  port:     Number(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER || 'encodium',
  password: DB_PASS,
  database: process.env.DB_NAME || 'encodium',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  timezone: '+00:00',
  connectTimeout: 10000,      // 10s connection timeout
});

async function safeAlter(conn, sql) {
  try { await conn.query(sql); } catch (e) {
    if (e.errno === 1060) return; // Additive migration already applied.
    throw e;
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
    // Preserve legacy columns and copy data after adding their replacements.
    // CHANGE after ADD used to fail on a duplicate destination column.
    const [jobColumns] = await conn.query('SHOW COLUMNS FROM encode_jobs');
    const [legacyMigration] = await conn.query("SELECT value FROM settings WHERE `key`='migration_legacy_job_columns_v1'");
    if (!legacyMigration.length && jobColumns.some(c => ['file_size_after', 'finished_at'].includes(c.Field))) {
      await conn.beginTransaction();
      try {
        if (jobColumns.some(c => c.Field === 'file_size_after')) {
          await conn.query('UPDATE encode_jobs SET output_size=file_size_after WHERE COALESCE(output_size,0)=0 AND file_size_after > 0');
        }
        if (jobColumns.some(c => c.Field === 'finished_at')) {
          await conn.query('UPDATE encode_jobs SET ended_at=finished_at WHERE ended_at IS NULL AND finished_at IS NOT NULL');
        }
        await conn.query("INSERT INTO settings (`key`, value) VALUES ('migration_legacy_job_columns_v1', '1')");
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      }
    }
    // v1.1 — encode options (container, downscale, tonemap)
    await safeAlter(conn, "ALTER TABLE encode_jobs ADD COLUMN encode_options TEXT AFTER quality");
    // v1.1 — job priority
    await safeAlter(conn, "ALTER TABLE encode_jobs ADD COLUMN priority INT DEFAULT 0 AFTER replace_original");
    // v1.2 — encode_skip flag on videos (size guard hit)
    await safeAlter(conn, "ALTER TABLE videos ADD COLUMN encode_skip TINYINT DEFAULT 0 COMMENT 'set when encode output was larger than original'");
    // v1.3 — retry_count for SIGKILL recovery (prevents infinite retry loop)
    await safeAlter(conn, "ALTER TABLE encode_jobs ADD COLUMN retry_count TINYINT UNSIGNED DEFAULT 0 AFTER progress");

    // ── Encoding Savings Ledger (persistent, survives queue clears) ──
    await conn.query(`
      CREATE TABLE IF NOT EXISTS encoding_savings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        video_id INT,
        filename VARCHAR(500),
        codec_before VARCHAR(50),
        codec_after VARCHAR(50),
        size_before BIGINT DEFAULT 0,
        size_after BIGINT DEFAULT 0,
        saved BIGINT DEFAULT 0,
        preset_id VARCHAR(100),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        KEY idx_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Backfill savings from existing encode_jobs (one-time migration)
    const [[{ savingsCount }]] = await conn.query('SELECT COUNT(*) as savingsCount FROM encoding_savings');
    if (savingsCount === 0) {
      await conn.query(`
        INSERT INTO encoding_savings (video_id, filename, codec_after, size_before, size_after, saved, preset_id, created_at)
        SELECT ej.video_id, v.filename, CASE WHEN JSON_VALID(ej.preset_json) THEN COALESCE(JSON_UNQUOTE(JSON_EXTRACT(ej.preset_json, '$.codec')), '') ELSE '' END, ej.file_size_before, ej.output_size,
               ej.file_size_before - ej.output_size, ej.preset_id, ej.ended_at
        FROM encode_jobs ej LEFT JOIN videos v ON ej.video_id = v.id
        WHERE ej.status = 'done' AND ej.file_size_before > 0 AND ej.output_size > 0
      `);
    }

    // ── Custom Presets ──
    await conn.query(`
      CREATE TABLE IF NOT EXISTS custom_presets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        codec VARCHAR(20) NOT NULL DEFAULT 'h265',
        cq INT DEFAULT 23,
        container VARCHAR(10) DEFAULT 'auto',
        downscale VARCHAR(10) DEFAULT '',
        tonemap TINYINT DEFAULT 0,
        extra_args TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // ── Media Sources ──
    await conn.query(`
      CREATE TABLE IF NOT EXISTS media_sources (
        id INT AUTO_INCREMENT PRIMARY KEY,
        path VARCHAR(1000) NOT NULL UNIQUE,
        label VARCHAR(200) NOT NULL DEFAULT '',
        enabled TINYINT DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Migrate legacy MEDIA_DIR env var to media_sources table (one-time)
    const [[{ srcCount }]] = await conn.query('SELECT COUNT(*) as srcCount FROM media_sources');
    if (srcCount === 0) {
      const legacyDir = process.env.MEDIA_DIR;
      if (legacyDir) {
        await conn.query(
          'INSERT IGNORE INTO media_sources (path, label) VALUES (?, ?)',
          [legacyDir, require('path').basename(legacyDir)]
        );
      }
    }
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
  return withIdleVideos(null, async conn => {
    await conn.query('DELETE FROM encode_jobs');
    await conn.query('DELETE FROM videos');
    await conn.query('DELETE FROM encoding_savings');
    await conn.query('DELETE FROM custom_presets');
  });
}

async function withIdleVideos(ids, action) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const where = ids === null ? '' : `WHERE id IN (${ids.map(() => '?').join(',') || 'NULL'})`;
    const [videos] = await conn.query(`SELECT id, file_path FROM videos ${where} ORDER BY id FOR UPDATE`, ids || []);
    const selected = videos.map(v => v.id);
    if (selected.length) {
      const [busy] = await conn.query(`SELECT id FROM encode_jobs WHERE video_id IN (${selected.map(() => '?').join(',')}) AND status IN ('pending','encoding') LIMIT 1 FOR UPDATE`, selected);
      if (busy.length) {
        const err = new Error('Cancel queued jobs and wait for workers to stop first');
        err.status = 409;
        throw err;
      }
    }
    const result = await action(conn, videos);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
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
  getPool, initSchema, clearAll, withIdleVideos,
  getAllExistingPaths, batchInsertVideos, updateVideoMeta, updateVideoThumb,
  getSetting, setSetting,
  createUser, getUserByEmail, getUserById, updateLastLogin, listUsers, deleteUser, countAdmins,
};
