'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const createFixture = require('./helpers/http-fixture');

async function fixture(t, options) {
  const f = await createFixture(options);
  t.after(() => f.close());
  f.request = (route, body, headers = {}, method = body === undefined ? 'GET' : 'POST') => fetch(f.url + '/api' + route, {
    method, headers: { Cookie: f.cookie(), 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return f;
}

test('HTTP authentication, current roles, deleted accounts and production errors', async t => {
  const f = await fixture(t);
  for (const route of ['/videos', '/stream/1', '/thumb/1', '/events', '/encode/status', '/logs']) {
    assert.equal((await fetch(f.url + '/api' + route)).status, 401, route);
    assert.equal((await fetch(f.url + '/api' + route + '?token=' + f.auth.signToken(f.users.get(1)))).status, 401);
  }
  const login = await f.request('/auth/login', { email: ' ADMIN@example.test ', password: 'fixture-password' });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
  assert.doesNotMatch(login.headers.get('set-cookie'), /; Secure/);
  assert.equal((await login.json()).token, undefined);
  assert.equal((await f.request('/auth/login', { email: 'admin@example.test', password: 'wrong' })).status, 401);
  assert.equal((await f.request('/auth/login', { email: {}, password: 'wrong' })).status, 400);
  const oldCookie = f.cookie();
  f.users.get(1).role = 'member';
  assert.equal((await f.request('/encode/enqueue', { videoIds: [1], presetId: 'cpu_h265', replaceOriginal: true }, { Cookie: oldCookie })).status, 403);
  assert.equal((await f.request('/videos', undefined, { Cookie: oldCookie })).status, 200);
  f.users.delete(1);
  assert.equal((await fetch(f.url + '/api/videos', { headers: { Cookie: oldCookie } })).status, 401);
  f.db.getUserById = async () => { throw new Error('secret database address'); };
  const unavailable = await fetch(f.url + '/api/videos', { headers: { Cookie: oldCookie } });
  assert.equal(unavailable.status, 503);
  assert.doesNotMatch(await unavailable.text(), /secret database/);
});

test('HTTP LAN/proxy origins, Secure cookie and forged forwarded headers', async t => {
  const lan = await fixture(t);
  const body = { email: 'admin@example.test', password: 'fixture-password' };
  assert.equal((await lan.request('/auth/login', body, { Origin: lan.url })).status, 200);
  assert.equal((await lan.request('/auth/login', body, { Origin: 'https://evil.example.test' })).status, 403);
  assert.equal((await lan.request('/auth/logout', {}, { Origin: 'null' })).status, 403);
  const forged = await lan.request('/auth/login', body, { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '8.8.8.8' });
  assert.doesNotMatch(forged.headers.get('set-cookie'), /; Secure/);
  const proxy = await fixture(t, { env: { COOKIE_SECURE: 'true' } });
  const response = await proxy.request('/auth/login', body, { Origin: proxy.url.replace('http:', 'https:') });
  assert.equal(response.status, 200); // req.protocol is HTTP behind TLS termination.
  assert.match(response.headers.get('set-cookie'), /; Secure/);
  const trusted = await fixture(t, { env: { TRUST_PROXY: 'loopback' } });
  const tls = await trusted.request('/auth/login', body, { 'X-Forwarded-Proto': 'https', Origin: trusted.url.replace('http:', 'https:') });
  assert.equal(tls.status, 200);
  assert.match(tls.headers.get('set-cookie'), /; Secure/);
});

test('login throttle cannot be bypassed by rotating spoofed X-Forwarded-For', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) {
    assert.equal((await f.request('/auth/login', { email: '', password: '' }, { 'X-Forwarded-For': `8.8.8.${i}` })).status, 400);
  }
  assert.equal((await f.request('/auth/login', { email: '', password: '' }, { 'X-Forwarded-For': '9.9.9.9' })).status, 429);
});

test('query/ID validation blocks object expansion and preserves valid enqueue/CQ zero', async t => {
  const f = await fixture(t, { query: sql => sql.includes('SELECT * FROM custom_presets WHERE') ? [[{ codec: 'h265', cq: 0 }]] : undefined });
  for (const route of ['/videos?folder[x]=1', '/videos?folder=a&folder=b', '/videos?page=no', '/videos?limit=-1', '/videos/9007199254740992']) {
    assert.equal((await f.request(route)).status, 400, route);
  }
  assert.equal((await f.request('/videos?sort=constructor&q=%27%20OR%201%3D1--')).status, 200);
  const query = f.calls.find(c => c.sql?.includes('ORDER BY v.filename'));
  assert.ok(query);
  assert.ok(query.params.includes("%' OR 1=1--%"));
  for (const route of ['/videos/delete', '/videos/clear-skip']) {
    assert.equal((await f.request(route, { ids: [{ id: 1 }] })).status, 400);
  }
  assert.equal((await f.request('/encode/enqueue', { videoIds: [1], presetId: 'cpu_h265', replaceOriginal: 'false' })).status, 400);
  assert.equal((await f.request('/encode/enqueue', { videoIds: [1], presetId: 'cpu_h265', downscale: '720,evil' })).status, 400);
  assert.equal((await f.request('/encode/enqueue', { videoIds: [1, 1], presetId: 'custom_1', replaceOriginal: false })).status, 200);
  const enqueue = f.calls.find(c => c.enqueue).enqueue;
  assert.deepEqual(enqueue[0], [1]);
  assert.equal(enqueue[3].customCq, 0);
  assert.equal((await f.request('/encode/workers', { count: 'bad' })).status, 400);
  assert.equal((await f.request('/encode/workers', { count: 2 })).status, 200);
});

test('stream uses real size, handles ranges and rejects symlink/out-of-root files', async t => {
  const f = await fixture(t);
  const full = await f.request('/stream/1');
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-length'), '10');
  assert.equal(await full.text(), '0123456789');
  const partial = await f.request('/stream/1', undefined, { Range: 'bytes=2-5' });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await partial.text(), '2345');
  assert.equal((await f.request('/stream/1', undefined, { Range: 'bytes=10-20' })).status, 416);
  const outside = path.join(f.root, 'private.mp4');
  await fs.writeFile(outside, 'private');
  await fs.symlink(outside, path.join(f.media, 'link.mp4'));
  f.videos[0].file_path = path.join(f.media, 'link.mp4');
  assert.equal((await f.request('/stream/1')).status, 404);
  f.videos[0].file_path = outside;
  assert.equal((await f.request('/stream/1')).status, 404);
  await fs.writeFile(path.join(f.thumbs, 'v_1.jpg'), 'fixture-thumb');
  assert.equal(await (await f.request('/thumb/1')).text(), 'fixture-thumb');
});

test('destructive routes keep rows on unsafe files and reject busy workers', async t => {
  const f = await fixture(t);
  const original = f.videos[0].file_path;
  f.encoder.getStatus = () => ({ activeJobs: 1 });
  assert.equal((await f.request('/videos/delete', { ids: [1] })).status, 409);
  assert.equal((await f.request('/clear', {})).status, 409);
  f.encoder.getStatus = () => ({ activeJobs: 0 });
  await fs.unlink(original);
  await fs.symlink(path.join(f.root, 'outside'), original);
  const rejected = await (await f.request('/videos/delete', { ids: [1] })).json();
  assert.equal(rejected.deleted, 0);
  assert.equal(rejected.fileErrors.length, 1);
  assert.equal(f.videos.length, 1);
  await fs.unlink(original);
  await fs.writeFile(original, 'fixture');
  const deleted = await (await f.request('/videos/delete', { ids: [1] })).json();
  assert.equal(deleted.deleted, 1);
  await assert.rejects(fs.stat(original), { code: 'ENOENT' });
});

test('public surface has CSP, safe JSON parser errors, no DB/static secrets', async t => {
  const f = await fixture(t);
  const page = await fetch(f.url);
  assert.equal(page.status, 200);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);
  for (const route of ['/api/not-found', '/api/.env']) assert.equal((await fetch(f.url + route)).status, 404);
  const bad = await fetch(f.url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{secret' });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'Invalid JSON' });
});

test('SSE member subscriptions exclude admin logs and connection count is bounded', async t => {
  const f = await fixture(t);
  const responses = [];
  try {
    for (let i = 0; i < 5; i++) {
      const response = await f.request('/events', undefined, { Cookie: f.cookie(2) });
      assert.equal(response.status, 200);
      responses.push(response);
    }
    assert.equal(f.calls.some(c => c.logSubscription), false);
    assert.equal((await f.request('/events', undefined, { Cookie: f.cookie(2) })).status, 429);
    assert.equal((await f.request('/encode/job/1/log', undefined, { Cookie: f.cookie(2) })).status, 403);
    assert.equal((await f.request('/logs', undefined, { Cookie: f.cookie(2) })).status, 403);
    const admin = await f.request('/events');
    responses.push(admin);
    assert.equal(admin.status, 200);
    assert.equal(f.calls.filter(c => c.logSubscription).length, 1);
  } finally {
    await Promise.all(responses.map(r => r.body.cancel()));
  }
});

test('presets and schedule reject invalid numbers/prototype keys before persistence', async t => {
  const f = await fixture(t);
  for (const body of [{ name: 'bad', codec: 'constructor', cq: 23 }, { name: 'bad', codec: 'h265', cq: '23garbage' }, { name: 'bad', codec: 'h265', cq: 2.5 }]) {
    assert.equal((await f.request('/custom-presets', body)).status, 400);
  }
  assert.equal((await f.request('/settings/schedule', { enabled: true, start: 'NaN', end: 24 })).status, 400);
  assert.equal(f.calls.some(c => c.setting), false);
  assert.equal((await f.request('/settings/schedule', { enabled: true, start: 22, end: 6 })).status, 200);
  assert.ok(f.calls.some(c => c.setting === 'schedule_start' && c.value === '22'));
});
