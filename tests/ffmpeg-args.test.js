'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildArgs } = require('../services/ffmpeg-args');

function probe(overrides = {}) {
  return {
    colorMeta: { transfer: 'bt709', primaries: 'bt709', space: 'bt709', range: 'tv' },
    bitDepth: 8,
    isHdr: false,
    caps: { tune: true, spatial_aq: true, aq_strength: true, rc: true, cq: true, qp: true, profile: true },
    badSubIndices: [],
    ...overrides,
  };
}

function optionValue(args, option) {
  const index = args.indexOf(option);
  return index === -1 ? undefined : args[index + 1];
}

test('AMD VA-API uploads 8-bit CPU frames to the selected render node', () => {
  const preset = { type: 'vaapi_group', encoder: 'av1_vaapi', codec: 'av1', cq: 30 };
  const result = buildArgs(
    preset, '/input.mkv', '/output.mkv',
    probe({ vaapiDevice: '/dev/dri/renderD129' })
  );

  assert.equal(result.hwArgs, null);
  assert.equal(optionValue(result.swArgs, '-vaapi_device'), '/dev/dri/renderD129');
  assert.equal(optionValue(result.swArgs, '-vf'), 'format=nv12,hwupload');
  assert.equal(result.swArgs.includes('-pix_fmt'), false);
  assert.ok(result.swArgs.indexOf('-vaapi_device') < result.swArgs.indexOf('-i'));
});

test('AMD VA-API runs CPU filters before upload and preserves 10-bit surfaces', () => {
  const preset = { type: 'vaapi', renderDevice: '/dev/dri/renderD128', encoder: 'hevc_vaapi', codec: 'h265' };
  const result = buildArgs(
    preset, '/input.mkv', '/output.mkv',
    probe({ bitDepth: 10, vaapiDevice: '/dev/dri/renderD128' }),
    { downscale: '720' }
  );

  assert.equal(optionValue(result.swArgs, '-vf'), 'scale=-2:720,format=p010le,hwupload');
  assert.equal(optionValue(result.swArgs, '-profile:v'), 'main10');
  assert.equal(result.swArgs.includes('-pix_fmt'), false);
});

test('AMD AV1 VA-API infers its profile from P010 instead of using HEVC main10', () => {
  const preset = { type: 'vaapi', renderDevice: '/dev/dri/renderD128', encoder: 'av1_vaapi', codec: 'av1' };
  const result = buildArgs(
    preset, '/input.mkv', '/output.mkv',
    probe({ bitDepth: 10, vaapiDevice: '/dev/dri/renderD128' })
  );

  assert.equal(optionValue(result.swArgs, '-vf'), 'format=p010le,hwupload');
  assert.equal(result.swArgs.includes('-profile:v'), false);
});

test('NVIDIA NVENC keeps zero-filter decode frames in CUDA memory', () => {
  const preset = { type: 'nvidia_group', encoder: 'av1_nvenc', codec: 'av1', cq: 30 };
  const result = buildArgs(preset, '/input.mkv', '/output.mkv', probe());

  assert.ok(result.hwArgs);
  assert.equal(optionValue(result.hwArgs, '-hwaccel'), 'cuda');
  assert.equal(optionValue(result.hwArgs, '-hwaccel_device'), '0');
  assert.equal(optionValue(result.hwArgs, '-hwaccel_output_format'), 'cuda');
  assert.equal(result.hwArgs.includes('-pix_fmt'), false);
  assert.equal(result.swArgs.includes('-vaapi_device'), false);
  assert.equal(optionValue(result.swArgs, '-pix_fmt'), 'yuv420p');
});

test('NVIDIA NVENC with CPU filters downloads frames before filtering', () => {
  const preset = { type: 'nvidia', gpuIndex: 1, encoder: 'hevc_nvenc', codec: 'h265' };
  const result = buildArgs(
    preset, '/input.mkv', '/output.mp4', probe(), { downscale: '1080' }
  );

  assert.ok(result.hwArgs);
  assert.equal(result.hwArgs.includes('-hwaccel_output_format'), false);
  assert.equal(optionValue(result.hwArgs, '-vf'), 'scale=-2:1080');
  assert.equal(optionValue(result.hwArgs, '-pix_fmt'), 'yuv420p');
  assert.equal(result.hwArgs.includes('hwupload'), false);
});

test('CPU encoders remain independent from VA-API and CUDA arguments', () => {
  const preset = { type: 'cpu', encoder: 'libsvtav1', codec: 'av1' };
  const result = buildArgs(preset, '/input.mkv', '/output.mkv', probe());

  assert.equal(result.hwArgs, null);
  assert.equal(result.swArgs.includes('-vaapi_device'), false);
  assert.equal(result.swArgs.includes('-hwaccel'), false);
  assert.equal(optionValue(result.swArgs, '-pix_fmt'), 'yuv420p');
});
