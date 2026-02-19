/**
 * services/gpu-detect.js — Hardware encoder detection
 *
 * Probes the system for GPUs (NVIDIA, AMD/Intel VA-API, Intel QSV)
 * and CPU encoders compatible with H.265/HEVC and AV1.
 */
'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execFile);

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 60_000;

async function run(cmd, args, timeout = 8000) {
  try { const { stdout } = await exec(cmd, args, { timeout }); return stdout; }
  catch { return ''; }
}

async function detectNvidia() {
  const out = await run('nvidia-smi', ['--query-gpu=index,name,memory.total,driver_version', '--format=csv,noheader,nounits']);
  if (!out.trim()) return [];
  return out.trim().split('\n').map(line => {
    const [index, name, vram, driver] = line.split(',').map(s => s.trim());
    return { index: Number(index), name, vram: `${vram} MiB`, driver };
  });
}

async function detectVaapi() {
  const devices = [];
  for (const dev of ['/dev/dri/renderD128', '/dev/dri/renderD129', '/dev/dri/renderD130']) {
    const out = await run('vainfo', ['--display', 'drm', '--device', dev]);
    if (!out) continue;
    const driverMatch = out.match(/Driver version:\s*(.+)/i);
    devices.push({
      device: dev,
      driver: driverMatch ? driverMatch[1].trim() : 'unknown',
      vendor: out.toLowerCase().includes('amd') || out.toLowerCase().includes('radeon') ? 'AMD'
            : out.toLowerCase().includes('intel') ? 'Intel' : 'unknown',
    });
  }
  return devices;
}

async function detectFfmpegEncoders() {
  const out = await run('ffmpeg', ['-encoders', '-hide_banner']);
  const wanted = new Set([
    'hevc_nvenc', 'av1_nvenc', 'hevc_vaapi', 'av1_vaapi',
    'hevc_qsv', 'av1_qsv', 'hevc_amf', 'av1_amf',
    'libx265', 'libsvtav1', 'libaom-av1',
  ]);
  const found = new Set();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*V\S+\s+(\S+)/);
    if (m && wanted.has(m[1])) found.add(m[1]);
  }
  return found;
}

async function detectAll(force = false) {
  if (!force && _cache && Date.now() - _cacheTs < CACHE_TTL) return _cache;

  const [nvidia, vaapi, encoderSet] = await Promise.all([
    detectNvidia(), detectVaapi(), detectFfmpegEncoders(),
  ]);

  const encoders = [...encoderSet];
  const presets = [];

  // Multi-GPU group presets
  if (nvidia.length > 1) {
    if (encoderSet.has('hevc_nvenc')) presets.push({ id: 'nvidia_h265', label: `H.265 NVENC — Auto (${nvidia.length} GPUs)`, encoder: 'hevc_nvenc', codec: 'h265', type: 'nvidia_group', gpuCount: nvidia.length, device: `${nvidia.length} GPUs` });
    if (encoderSet.has('av1_nvenc'))  presets.push({ id: 'nvidia_av1',  label: `AV1 NVENC — Auto (${nvidia.length} GPUs)`,  encoder: 'av1_nvenc',  codec: 'av1',  type: 'nvidia_group', gpuCount: nvidia.length, device: `${nvidia.length} GPUs` });
  }
  if (vaapi.length > 1) {
    if (encoderSet.has('hevc_vaapi')) presets.push({ id: 'vaapi_h265', label: `H.265 VA-API — Auto (${vaapi.length} devices)`, encoder: 'hevc_vaapi', codec: 'h265', type: 'vaapi_group', deviceCount: vaapi.length, device: `${vaapi.length} VA-API` });
    if (encoderSet.has('av1_vaapi'))  presets.push({ id: 'vaapi_av1',  label: `AV1 VA-API — Auto (${vaapi.length} devices)`,  encoder: 'av1_vaapi',  codec: 'av1',  type: 'vaapi_group', deviceCount: vaapi.length, device: `${vaapi.length} VA-API` });
  }

  // Per-GPU NVIDIA presets
  for (const gpu of nvidia) {
    if (encoderSet.has('hevc_nvenc')) presets.push({ id: `nvenc_h265_gpu${gpu.index}`, label: `H.265 NVENC — ${gpu.name}`, encoder: 'hevc_nvenc', codec: 'h265', type: 'nvidia', gpuIndex: gpu.index, device: `GPU ${gpu.index}` });
    if (encoderSet.has('av1_nvenc'))  presets.push({ id: `nvenc_av1_gpu${gpu.index}`,  label: `AV1 NVENC — ${gpu.name}`,  encoder: 'av1_nvenc',  codec: 'av1',  type: 'nvidia', gpuIndex: gpu.index, device: `GPU ${gpu.index}` });
  }

  // VA-API presets
  for (const dev of vaapi) {
    if (encoderSet.has('hevc_vaapi')) presets.push({ id: `vaapi_h265_${dev.device.replace(/\//g, '_')}`, label: `H.265 VA-API — ${dev.vendor} (${dev.device})`, encoder: 'hevc_vaapi', codec: 'h265', type: 'vaapi', renderDevice: dev.device, device: `${dev.vendor} ${dev.device}` });
    if (encoderSet.has('av1_vaapi'))  presets.push({ id: `vaapi_av1_${dev.device.replace(/\//g, '_')}`,  label: `AV1 VA-API — ${dev.vendor} (${dev.device})`,  encoder: 'av1_vaapi',  codec: 'av1',  type: 'vaapi', renderDevice: dev.device, device: `${dev.vendor} ${dev.device}` });
  }

  // Intel QSV
  if (encoderSet.has('hevc_qsv')) presets.push({ id: 'qsv_h265', label: 'H.265 Intel QSV', encoder: 'hevc_qsv', codec: 'h265', type: 'qsv' });
  if (encoderSet.has('av1_qsv'))  presets.push({ id: 'qsv_av1',  label: 'AV1 Intel QSV',   encoder: 'av1_qsv',  codec: 'av1',  type: 'qsv' });

  // CPU fallbacks
  if (encoderSet.has('libx265'))   presets.push({ id: 'cpu_h265', label: 'H.265 CPU (libx265)', encoder: 'libx265',   codec: 'h265', type: 'cpu' });
  if (encoderSet.has('libsvtav1')) presets.push({ id: 'cpu_av1',  label: 'AV1 CPU (SVT-AV1)',   encoder: 'libsvtav1', codec: 'av1',  type: 'cpu' });
  if (encoderSet.has('libaom-av1') && !encoderSet.has('libsvtav1')) {
    presets.push({ id: 'cpu_av1_aom', label: 'AV1 CPU (libaom — slow)', encoder: 'libaom-av1', codec: 'av1', type: 'cpu' });
  }

  _cache = { nvidia, vaapi, encoders, presets };
  _cacheTs = Date.now();
  console.log(`[hw] ${nvidia.length} NVIDIA, ${vaapi.length} VA-API, ${encoders.length} encoders, ${presets.length} presets`);
  return _cache;
}

module.exports = { detectAll, detectNvidia, detectVaapi, detectFfmpegEncoders };
