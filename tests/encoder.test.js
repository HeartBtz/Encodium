'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { promisify } = require('node:util');
const load = require('./helpers/load-module');

async function until(predicate) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Fixture timed out');
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'encodium-worker-'));
  const media = path.join(root, 'media');
  const out = path.join(root, 'out');
  await fs.mkdir(media);
  await fs.mkdir(out);
  const input = path.join(media, 'film.mp4');
  await fs.writeFile(input, 'original-fixture-bytes');
  const video = { id: 1, file_path: input, filename: 'film.mp4', size: 999, codec: 'h264', duration: 1 };
  const job = { id: 10, video_id: 1, preset_id: 'test', preset_json: JSON.stringify({ type: 'cpu', encoder: 'libx265', codec: 'h265', cq: 23 }), status: 'pending', replace_original: options.replace ? 1 : 0, encode_options: JSON.stringify({ container: options.container || 'mp4' }) };
  const queries = [];
  const pool = { query: async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql === 'SELECT path FROM media_sources') return [[{ path: media }]];
    if (sql.startsWith('SELECT * FROM encode_jobs WHERE status=')) return [job.status === 'pending' ? [job] : []];
    if (sql.startsWith('SELECT * FROM videos')) return [[{ ...video }]];
    if (sql.startsWith('SELECT * FROM encode_jobs WHERE id=')) return [[{ ...job }]];
    if (sql.startsWith('SELECT status FROM encode_jobs')) return [[{ status: job.status }]];
    if (sql.startsWith('UPDATE encode_jobs SET status=')) {
      const status = /SET status='([^']+)'/.exec(sql)?.[1] || params[0];
      job.status = status;
      if (sql.includes('output_path=?')) job.output_path = params[0];
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE videos SET') && sql.includes('file_path')) {
      if (options.dbFailure) throw new Error('fixture metadata update failed');
      video.file_path = params[0];
    }
    return [{ affectedRows: 1 }];
  } };
  const db = { getPool: () => pool, getSetting: async (_key, fallback) => fallback, setSetting: async () => {} };
  const files = load('services/media-files.js', { '../db': db }, { env: { ENCODE_DIR: out } });
  const noop = () => {};
  const logger = Object.fromEntries(['info', 'warn', 'error', 'success', 'debug'].map(k => [k, noop]));
  const processes = [];
  const execFile = noop;
  execFile[promisify.custom] = async () => ({ stdout: '', stderr: '' });
  let probing = false;
  let releaseProbe;
  const gate = new Promise(resolve => { releaseProbe = resolve; });
  const ffprobe = {
    firstVideoCodec: async () => { probing = true; if (options.holdProbe) await gate; return 'h264'; },
    colorMeta: async () => ({}), bitDepth: async () => 8, sideDataTypes: async () => '',
    duration: async file => options.shortOutput ? (file === input ? 100 : 95) : 1, badSubtitleIndices: async () => [],
    ffprobeValue: async () => { if (options.onValidation) await options.onValidation(); return 'hevc'; },
    fullInfo: async () => ({ streams: [{ index: 0, codec_type: 'audio', codec_name: 'aac' }, { index: 1, codec_type: 'video', codec_name: 'hevc', width: 16, height: 16, pix_fmt: 'yuv420p' }], format: { duration: '1' } }),
  };
  const encoder = load('services/encoder.js', {
    '../db': db, './media-files': files, './gpu-detect': {}, './logger': logger, './ffprobe': ffprobe,
    './webhook': { checkAndFire: async () => {} },
    child_process: {
      execFile, execFileSync: () => { throw new Error('No system process lookup allowed in fixture'); },
      spawn: (command, args) => {
        assert.equal(command, 'ffmpeg');
        const proc = new EventEmitter();
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        proc.exitCode = null;
        proc.signalCode = null;
        proc.kill = signal => {
          proc.signalCode = signal;
          setImmediate(() => proc.emit('close', null, signal));
          return true;
        };
        processes.push({ proc, args });
        if (!options.holdProcess) {
          setImmediate(async () => {
            await fs.writeFile(args.at(-1), options.large ? 'x'.repeat(100) : 'encoded');
            proc.exitCode = 0;
            proc.emit('close', 0, null);
          });
        }
        return proc;
      },
    },
  }, { dirname: path.join(root, 'services'), env: { ENCODE_DIR: out, MAX_WORKERS: '1' } });
  t.after(async () => { releaseProbe(); encoder.setPaused(true); await until(() => encoder.getStatus().activeJobs === 0); await fs.rm(root, { recursive: true, force: true }); });
  return { encoder, job, video, input, root, out, media, queries, processes, releaseProbe, probing: () => probing };
}

test('non-replacing worker keeps original bytes and video path; history deletion keeps output', async t => {
  const f = await fixture(t);
  await f.encoder.processQueue();
  await until(() => f.encoder.getStatus().activeJobs === 0);
  assert.equal(f.job.status, 'done');
  assert.equal(await fs.readFile(f.input, 'utf8'), 'original-fixture-bytes');
  assert.equal(f.video.file_path, f.input);
  assert.equal(await fs.readFile(f.job.output_path, 'utf8'), 'encoded');
  assert.equal(f.processes[0].args.includes('-c:v:1'), false, 'first video may have global stream index 1');
  await f.encoder.deleteJob(10);
  assert.equal(await fs.readFile(f.job.output_path, 'utf8'), 'encoded');
});

test('replacement succeeds, size guard preserves original, metadata failure does not delete source', async t => {
  for (const options of [{ replace: true }, { replace: true, large: true }, { replace: true, container: 'mkv', dbFailure: true }]) {
    const f = await fixture(t, options);
    await f.encoder.processQueue();
    await until(() => f.encoder.getStatus().activeJobs === 0);
    if (options.dbFailure) {
      assert.equal(f.job.status, 'error');
      assert.equal(await fs.readFile(f.input, 'utf8'), 'original-fixture-bytes');
      assert.equal(await fs.readFile(path.join(f.media, 'film.mkv'), 'utf8'), 'encoded');
    } else {
      assert.equal(f.job.status, 'done');
      assert.equal(await fs.readFile(f.input, 'utf8'), options.large ? 'original-fixture-bytes' : 'encoded');
    }
  }
});

test('cancel during probing reserves worker until cleanup and never spawns ffmpeg', async t => {
  const f = await fixture(t, { holdProbe: true });
  await f.encoder.processQueue();
  await until(f.probing);
  assert.equal(await f.encoder.cancelJob(10), true);
  assert.equal(f.encoder.getStatus().activeJobs, 1);
  await assert.rejects(f.encoder.deleteJob(10), /Cancel|stop/);
  await assert.rejects(f.encoder.retryJob(10), /stopping/);
  f.releaseProbe();
  await until(() => f.encoder.getStatus().activeJobs === 0);
  assert.equal(f.job.status, 'cancelled');
  assert.equal(f.processes.length, 0);
});

test('cancel and force-kill during ffmpeg do not retry an intentional signal', async t => {
  for (const force of [false, true]) {
    const f = await fixture(t, { holdProcess: true });
    await f.encoder.processQueue();
    await until(() => f.processes.length === 1);
    if (force) await f.encoder.forceKillJob(10); else await f.encoder.cancelJob(10);
    await until(() => f.encoder.getStatus().activeJobs === 0);
    assert.equal(f.job.status, force ? 'error' : 'cancelled');
    assert.equal(f.processes.length, 1);
    assert.equal(await fs.readFile(f.input, 'utf8'), 'original-fixture-bytes');
  }
});

test('cancel during validation does not publish output', async t => {
  const f = await fixture(t, { onValidation: async () => { await f.encoder.cancelJob(10); } });
  await f.encoder.processQueue();
  await until(() => f.encoder.getStatus().activeJobs === 0);
  assert.equal(f.job.status, 'cancelled');
  assert.equal((await fs.readdir(f.out)).length, 0);
});

test('invalid persisted preset releases placeholder and device lock', async t => {
  const f = await fixture(t);
  f.job.preset_json = 'null';
  await f.encoder.processQueue();
  await until(() => f.encoder.getStatus().activeJobs === 0);
  assert.equal(f.job.status, 'error');
  assert.equal(f.processes.length, 0);
});

test('output five percent shorter is rejected before touching the original', async t => {
  const f = await fixture(t, { replace: true, shortOutput: true });
  await f.encoder.processQueue();
  await until(() => f.encoder.getStatus().activeJobs === 0);
  assert.equal(f.job.status, 'error');
  assert.equal(await fs.readFile(f.input, 'utf8'), 'original-fixture-bytes');
});
