'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const load = require('./helpers/load-module');

test('media roots use literal canonical containment and reject symlink escapes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'encodium-path-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const media = path.join(root, 'media_%');
  await fs.mkdir(media);
  const files = load('services/media-files.js', { '../db': { getPool: () => ({ query: async () => [[{ path: media }]] }) } }, { env: { ENCODE_DIR: media } });
  const local = path.join(media, 'film.mp4');
  await fs.writeFile(local, 'local');
  assert.equal(await files.resolveMediaPath(local), local);
  assert.equal(await files.resolveMediaPath(path.join(media, 'missing.mp4'), { allowMissing: true }), path.join(media, 'missing.mp4'));
  await fs.symlink(root, path.join(media, 'escape'));
  await fs.symlink(local, path.join(media, 'leaf.mp4'));
  await assert.rejects(files.resolveMediaPath(path.join(media, 'escape', 'private.mp4'), { allowMissing: true }), /outside/);
  await assert.rejects(files.resolveMediaPath(path.join(media, 'leaf.mp4')), /symlink/);
  await assert.rejects(files.resolveMediaPath('http://127.0.0.1/private.mp4'), /Invalid/);
  assert.equal(files.contains('/media/a', '/media/ab/video'), false);
  assert.equal(files.contains('/media/a', '/media/a/video'), true);
});

test('publication is no-clobber; replacement checks original identity before atomic rename', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'encodium-move-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { moveFile } = load('services/media-files.js', { '../db': {} });
  const src = path.join(root, 'encoded');
  const dst = path.join(root, 'original');
  await fs.writeFile(src, 'encoded');
  await fs.writeFile(dst, 'original');
  await assert.rejects(moveFile(src, dst), { code: 'EEXIST' });
  assert.equal(await fs.readFile(dst, 'utf8'), 'original');
  const before = await fs.stat(dst);
  await fs.writeFile(dst, 'external-change');
  await assert.rejects(moveFile(src, dst, null, before), /Original changed/);
  assert.equal(await fs.readFile(dst, 'utf8'), 'external-change');
  await moveFile(src, dst, null, await fs.stat(dst));
  assert.equal(await fs.readFile(dst, 'utf8'), 'encoded');
  await assert.rejects(fs.stat(src), { code: 'ENOENT' });
  await fs.writeFile(src, 'second');
  const linked = path.join(root, 'symlink');
  await fs.symlink(dst, linked);
  await assert.rejects(moveFile(src, linked), { code: 'EEXIST' });
  assert.equal(await fs.readFile(dst, 'utf8'), 'encoded');
  await moveFile(src, path.join(root, 'new-copy'));
  assert.equal(await fs.readFile(path.join(root, 'new-copy'), 'utf8'), 'second');
  assert.equal((await fs.readdir(root)).some(n => n.startsWith('.encodium-')), false);
});
