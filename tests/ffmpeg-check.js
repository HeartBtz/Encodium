'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { buildArgs } = require('../services/ffmpeg-args');
const ffprobe = require('../services/ffprobe');
const run = promisify(execFile);

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'encodium-ffmpeg-'));
  let hits = 0;
  const server = http.createServer((_req, res) => { hits++; res.end('fixture'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const input = path.join(root, 'input;$(not-a-command).mp4');
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=5', '-t', '1', '-c:v', 'libx264', input], { timeout: 30000 });
    const output = path.join(root, 'output.mp4');
    const { swArgs } = buildArgs({ type: 'cpu', encoder: 'libx264', codec: 'h264', cq: 0 }, input, output, { colorMeta: {}, bitDepth: 8, isHdr: false, caps: {}, badSubIndices: [] });
    await run('ffmpeg', swArgs, { timeout: 30000 });
    assert.equal(await ffprobe.firstVideoCodec(output), 'h264');
    assert.ok(await ffprobe.duration(output) > 0);
    assert.ok(await fs.stat(input));
    const url = `http://127.0.0.1:${server.address().port}/segment.ts`;
    assert.equal(await ffprobe.fullInfo(url), null);
    const playlist = path.join(root, 'playlist.mp4');
    await fs.writeFile(playlist, `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${url}\n#EXT-X-ENDLIST\n`);
    assert.equal(await ffprobe.fullInfo(playlist), null);
    const badArgs = buildArgs({ type: 'cpu', encoder: 'libx264', codec: 'h264' }, playlist, path.join(root, 'bad.mp4'), { colorMeta: {}, bitDepth: 8, isHdr: false, caps: {}, badSubIndices: [] }).swArgs;
    await assert.rejects(run('ffmpeg', badArgs, { timeout: 10000 }), /whitelist|Invalid|Protocol/i);
    assert.equal(hits, 0);
    console.log('PASS real FFmpeg: synthetic encode/probe, shell-metacharacter filename, HTTP/HLS SSRF blocked (zero HTTP hits)');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
