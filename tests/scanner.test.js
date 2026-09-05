'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const load = require('./helpers/load-module');

test('sync keeps inaccessible files: EACCES is not evidence of removal', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'encodium-sync-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'denied.mp4');
  await fs.promises.writeFile(input, 'fixture');
  const db = {
    getPool: () => ({ query: async sql => sql.includes('FROM media_sources') ? [[{ id: 1, path: root, enabled: 1 }]] : [[{ id: 1, file_path: input }]] }),
    withIdleVideos: () => { throw new Error('Must not delete an inaccessible file'); },
    batchInsertVideos: async () => {},
  };
  const scanner = load('scanner.js', {
    './db': db, dotenv: { config: () => {} }, './services/media-files': {},
    fs: { ...fs, promises: { ...fs.promises, access: async file => {
      if (file === input) { const err = new Error('Permission denied'); err.code = 'EACCES'; throw err; }
      return fs.promises.access(file);
    } } },
  }, { env: { THUMB_DIR: root } });
  await scanner.syncDatabase();
  assert.equal(scanner.getSyncProgress().removed, 0);
  assert.equal(scanner.getSyncProgress().errors, 1);
  assert.equal(await fs.promises.readFile(input, 'utf8'), 'fixture');
});

test('enrichment claims its running state before awaiting the database', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'encodium-enrich-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  let release;
  let queries = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const scanner = load('scanner.js', {
    './db': { getPool: () => ({ query: async () => { queries++; await gate; return [[]]; } }) },
    dotenv: { config: () => {} }, './services/media-files': {},
  }, { env: { THUMB_DIR: root } });
  const first = scanner.enrichVideoMeta();
  assert.equal(scanner.getEnrichProgress().running, true);
  await scanner.enrichVideoMeta();
  assert.equal(queries, 1);
  release();
  await first;
  assert.equal(scanner.getEnrichProgress().running, false);
});

test('autoscan rejects inherited object properties', async () => {
  const watcher = load('services/watcher.js');
  await assert.rejects(watcher.setAutoScanInterval('constructor'), /Invalid interval/);
});
