/**
 * services/ffprobe.js — ffprobe helper functions
 *
 * Extracted from encoder.js for separation of concerns.
 * Provides probe functions for video metadata, color info,
 * bit depth, subtitles, durations, and full stream info.
 */
'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

/** Default timeout for ffprobe commands (ms) */
const PROBE_TIMEOUT = 30000;
const PROBE_TIMEOUT_SHORT = 15000;

/**
 * Run ffprobe and return the first line of the output.
 * @param {string} filePath - Path to the media file
 * @param {string|null} streamSelect - Stream selector (e.g. 'v:0')
 * @param {string} entries - Show entries parameter
 * @returns {Promise<string>} First line of output, or '' on error
 */
async function ffprobeValue(filePath, streamSelect, entries) {
  try {
    const args = ['-v', 'error'];
    if (streamSelect) args.push('-select_streams', streamSelect);
    args.push('-show_entries', entries, '-of', 'default=nw=1:nk=1', '--', filePath);
    const { stdout } = await execFileAsync('ffprobe', args, { timeout: PROBE_TIMEOUT });
    return stdout.trim().split('\n')[0] || '';
  } catch (e) {
    return '';
  }
}

/**
 * Get the video codec of the first video stream.
 */
async function firstVideoCodec(filePath) {
  return ffprobeValue(filePath, 'v:0', 'stream=codec_name');
}

/**
 * Get color metadata (transfer, primaries, space, range) for the first video stream.
 */
async function colorMeta(filePath) {
  const [transfer, primaries, space, range] = await Promise.all([
    ffprobeValue(filePath, 'v:0', 'stream=color_transfer'),
    ffprobeValue(filePath, 'v:0', 'stream=color_primaries'),
    ffprobeValue(filePath, 'v:0', 'stream=color_space'),
    ffprobeValue(filePath, 'v:0', 'stream=color_range'),
  ]);
  return { transfer, primaries, space, range };
}

/**
 * Detect bit depth of the first video stream.
 * Falls back to pixel format analysis if bits_per_raw_sample is unavailable.
 */
async function bitDepth(filePath) {
  const b = await ffprobeValue(filePath, 'v:0', 'stream=bits_per_raw_sample');
  if (b && b !== 'N/A' && b !== '0') return parseInt(b, 10);
  const pf = await ffprobeValue(filePath, 'v:0', 'stream=pix_fmt');
  if (/10|p010|p10/.test(pf)) return 10;
  if (/12|p012|p12/.test(pf)) return 12;
  return 8;
}

/**
 * Get side data types for the first video stream (used for Dolby Vision detection).
 */
async function sideDataTypes(filePath) {
  try {
    const args = ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream_side_data=side_data_type',
      '-of', 'default=nw=1:nk=1', '--', filePath];
    const { stdout } = await execFileAsync('ffprobe', args, { timeout: PROBE_TIMEOUT_SHORT });
    return stdout.trim();
  } catch (e) {
    return '';
  }
}

/**
 * Get the duration of the media file in seconds.
 */
async function duration(filePath) {
  const d = await ffprobeValue(filePath, null, 'format=duration');
  if (!d || d === 'N/A') return 0;
  return parseFloat(d) || 0;
}

/**
 * Find subtitle stream indices with unsupported/unknown codecs
 * that should be dropped during encoding.
 */
async function badSubtitleIndices(filePath) {
  try {
    const args = ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name',
      '-of', 'csv=p=0', '--', filePath];
    const { stdout } = await execFileAsync('ffprobe', args, { timeout: PROBE_TIMEOUT_SHORT });
    const bad = [];
    for (const line of stdout.trim().split('\n')) {
      if (!line) continue;
      const parts = line.split(',');
      if (parts[1] === 'subtitle') {
        const codec = (parts[2] || '').toLowerCase();
        if (!codec || codec === 'unknown' || codec === 'webvtt' || codec === 'none' || codec === 'n/a') {
          bad.push(parts[0]);
        }
      }
    }
    return bad;
  } catch (e) {
    return [];
  }
}

/**
 * Get full stream and format info as a parsed JSON object.
 */
async function fullInfo(filePath) {
  try {
    const args = ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', '--', filePath];
    const { stdout } = await execFileAsync('ffprobe', args, { timeout: PROBE_TIMEOUT });
    return JSON.parse(stdout);
  } catch (e) {
    return null;
  }
}

module.exports = {
  ffprobeValue,
  firstVideoCodec,
  colorMeta,
  bitDepth,
  sideDataTypes,
  duration,
  badSubtitleIndices,
  fullInfo,
};
