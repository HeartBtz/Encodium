#!/usr/bin/env node
/**
 * Encodium CLI — Command-line interface
 *
 * Usage:
 *   node cli.js scan      — Scan MEDIA_DIR for video files
 *   node cli.js enrich    — Enrich metadata (ffprobe) for scanned videos
 *   node cli.js thumbs    — Generate missing thumbnails
 *   node cli.js clear     — Clear all videos from the database
 *   node cli.js stats     — Show database statistics
 *   node cli.js useradd <email> <password> [role]  — Create a user
 */
'use strict';

require('dotenv').config({ override: true });

const db      = require('./db');
const scanner = require('./scanner');

const cmd = process.argv[2];

const commands = {
  async scan() {
    console.log('[cli] Initializing database…');
    await db.initSchema();
    console.log(`[cli] Scanning: ${process.env.MEDIA_DIR || '(MEDIA_DIR not set)'}`);
    const result = await scanner.scanDirectory();
    console.log(`[cli] Scan complete. Found ${result.found} files, inserted ${result.inserted}.`);
    console.log('[cli] Enriching metadata…');
    await scanner.enrichVideoMeta();
    console.log('[cli] Generating thumbnails…');
    await scanner.generateMissingThumbs();
    console.log('[cli] All done.');
    process.exit(0);
  },

  async enrich() {
    await db.initSchema();
    console.log('[cli] Enriching metadata…');
    await scanner.enrichVideoMeta();
    console.log('[cli] Done.');
    process.exit(0);
  },

  async thumbs() {
    await db.initSchema();
    console.log('[cli] Generating thumbnails…');
    await scanner.generateMissingThumbs();
    console.log('[cli] Done.');
    process.exit(0);
  },

  async clear() {
    await db.initSchema();
    console.log('[cli] Clearing database…');
    await db.clearAll();
    console.log('[cli] Database cleared.');
    process.exit(0);
  },

  async stats() {
    await db.initSchema();
    const pool = db.getPool();
    const [[vStats]] = await pool.query('SELECT COUNT(*) as count, COALESCE(SUM(size),0) as total_size FROM videos');
    const [[jStats]] = await pool.query(
      `SELECT COUNT(*) as total,
              SUM(status='pending') as pending,
              SUM(status='encoding') as encoding,
              SUM(status='done') as done,
              SUM(status='error') as errors,
              SUM(status='cancelled') as cancelled
       FROM encode_jobs`
    );
    console.log('\n  Encodium Statistics');
    console.log('  ─────────────────────');
    console.log(`  Videos:       ${vStats.count}`);
    console.log(`  Total size:   ${(vStats.total_size / 1e9).toFixed(2)} GB`);
    console.log(`  Jobs total:   ${jStats.total}`);
    console.log(`  Jobs pending: ${jStats.pending || 0}`);
    console.log(`  Jobs encoding:${jStats.encoding || 0}`);
    console.log(`  Jobs done:    ${jStats.done || 0}`);
    console.log(`  Jobs errors:  ${jStats.errors || 0}`);
    console.log(`  Jobs cancelled:${jStats.cancelled || 0}`);
    console.log('');
    process.exit(0);
  },

  async useradd() {
    const email = process.argv[3];
    const password = process.argv[4];
    const role = process.argv[5] || 'admin';
    if (!email || !password) {
      console.error('[cli] Usage: node cli.js useradd <email> <password> [admin|member]');
      process.exit(1);
    }
    if (!['admin', 'member'].includes(role)) {
      console.error('[cli] Role must be "admin" or "member"');
      process.exit(1);
    }
    const bcrypt = require('bcryptjs');
    await db.initSchema();
    const existing = await db.getUserByEmail(email);
    if (existing) { console.error(`[cli] User ${email} already exists`); process.exit(1); }
    const hash = await bcrypt.hash(password, 10);
    const id = await db.createUser(email.split('@')[0], email, hash, role);
    console.log(`[cli] User created: ${email} (id=${id}, role=${role})`);
    process.exit(0);
  },
};

if (!cmd || !commands[cmd]) {
  console.log('Usage: node cli.js <command>\n');
  console.log('Commands:');
  console.log('  scan                          Scan MEDIA_DIR for video files');
  console.log('  enrich                        Enrich metadata (ffprobe)');
  console.log('  thumbs                        Generate missing thumbnails');
  console.log('  clear                         Clear all videos from database');
  console.log('  stats                         Show database statistics');
  console.log('  useradd <email> <pass> [role]  Create a user (role: admin|member)');
  process.exit(1);
}

commands[cmd]().catch(e => { console.error(`[cli] Error: ${e.message}`); process.exit(1); });
