'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateAddress, resolvePublicWebhookUrl } = require('../services/network-security');
const { parseByteRange } = require('../services/http-range');
const { parseVaapiOutput } = require('../services/gpu-detect');

test('private, loopback, link-local and reserved addresses are blocked', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.1.1', '172.31.0.1', '192.168.1.1', '::1', 'fd00::1', 'fe80::1', '2001:db8::1', '0:0:0:0:0:0:0:1', '0:0:0:0:0:ffff:7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:0::1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
});

test('mixed public/private DNS answers, unsupported schemes and redirects targets fail closed', async () => {
  const lookup = async () => [{ address: '8.8.8.8', family: 4 }, { address: '0:0:0:0:0:0:0:1', family: 6 }];
  await assert.rejects(resolvePublicWebhookUrl('https://example.test', lookup), /private|reserved/);
  await assert.rejects(resolvePublicWebhookUrl('file:///etc/passwd', lookup), /http/);
});

test('webhook validation rejects DNS rebinding candidates and credentials', async () => {
  const privateLookup = async () => [{ address: '192.168.1.5', family: 4 }];
  await assert.rejects(() => resolvePublicWebhookUrl('https://example.test/hook', privateLookup), /private|reserved/i);
  await assert.rejects(() => resolvePublicWebhookUrl('https://user:pass@example.test/hook', privateLookup), /credentials/i);
});

test('webhook validation returns a pinned public address', async () => {
  const publicLookup = async () => [{ address: '203.1.2.3', family: 4 }];
  const target = await resolvePublicWebhookUrl('https://hooks.example.test/path', publicLookup);
  assert.equal(target.address, '203.1.2.3');
  assert.equal(target.url.hostname, 'hooks.example.test');
});

test('literal IPv6 webhook hosts are normalized and checked', async () => {
  await assert.rejects(() => resolvePublicWebhookUrl('http://[::1]/hook'), /private|reserved/i);
  const target = await resolvePublicWebhookUrl('https://[2606:4700:4700::1111]/hook');
  assert.equal(target.hostname, '2606:4700:4700::1111');
  assert.equal(target.family, 6);
});

test('byte ranges are bounded and malformed ranges are rejected', () => {
  assert.deepEqual(parseByteRange('bytes=10-19', 100), { start: 10, end: 19, length: 10 });
  assert.deepEqual(parseByteRange('bytes=-10', 100), { start: 90, end: 99, length: 10 });
  assert.deepEqual(parseByteRange('bytes=95-999', 100), { start: 95, end: 99, length: 5 });
  assert.throws(() => parseByteRange('bytes=100-101', 100), RangeError);
  assert.throws(() => parseByteRange('bytes=0-1,4-5', 100), RangeError);
});

test('VA-API capabilities are derived from actual encode entrypoints', () => {
  const output = `
vainfo: Driver version: Mesa Gallium driver for AMD Radeon Graphics
VAProfileH264High               : VAEntrypointEncSlice
VAProfileHEVCMain               : VAEntrypointEncSlice
VAProfileAV1Profile0            : VAEntrypointVLD
`;
  const parsed = parseVaapiOutput(output, '/dev/dri/renderD129');
  assert.equal(parsed.vendor, 'AMD');
  assert.deepEqual(parsed.encoders.sort(), ['h264_vaapi', 'hevc_vaapi']);
  assert.equal(parsed.encoders.includes('av1_vaapi'), false);
});
