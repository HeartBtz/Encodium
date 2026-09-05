'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const db = require('../db');

function contains(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function resolveMediaPath(file, { allowMissing = false, pool = db.getPool() } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Invalid media path');
  const resolved = path.resolve(file);
  const [sources] = await pool.query('SELECT path FROM media_sources');
  const roots = [...sources.map(s => s.path), process.env.ENCODE_DIR || path.join(__dirname, '..', 'data', 'encoded')];
  const parent = await fsp.realpath(path.dirname(resolved));
  let allowed = false;
  for (const root of roots) {
    if (!contains(path.resolve(root), resolved)) continue;
    try {
      const realRoot = await fsp.realpath(root);
      if (contains(realRoot, path.join(parent, path.basename(resolved)))) { allowed = true; break; }
    } catch { /* unavailable source is not an authorization grant */ }
  }
  if (!allowed) throw new Error('Media path is outside configured roots');
  try {
    const stat = await fsp.lstat(resolved);
    if (!stat.isFile()) throw new Error('Media path must be a regular file, not a symlink');
  } catch (err) {
    if (!allowMissing || err.code !== 'ENOENT') throw err;
  }
  return resolved;
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

async function moveFile(src, dst, jobLog, expectedDestination = null) {
  // Stage on the destination filesystem: EXDEV or interrupted copying must
  // never truncate the original. A new output is published without clobbering.
  const dir = await fsp.mkdtemp(path.join(path.dirname(dst), '.encodium-'));
  const staged = path.join(dir, 'output');
  try {
    const source = await fsp.stat(src);
    await pipeline(fs.createReadStream(src), fs.createWriteStream(staged, { flags: 'wx', mode: 0o600 }));
    if ((await fsp.stat(staged)).size !== source.size) throw new Error('Copy integrity check failed');
    await fsp.chmod(staged, (expectedDestination || source).mode & 0o777);
    if (expectedDestination) {
      if (!sameFile(expectedDestination, await fsp.lstat(dst))) throw new Error('Original changed during encoding');
      await fsp.rename(staged, dst);
    } else {
      await fsp.link(staged, dst); // EEXIST protects other media and symlinks.
    }
    await fsp.unlink(src);
    jobLog?.info(`Published output: ${dst}`);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { contains, resolveMediaPath, sameFile, moveFile };
