/**
 * services/ffmpeg-args.js — Build ffmpeg command-line arguments
 *
 * Extracted from encoder.js. Constructs the ffmpeg argument arrays
 * for both software and hardware decode paths.
 */
'use strict';

/**
 * Resolve output container extension from user choice and codec.
 * @param {string} container - 'mkv' | 'mp4' | 'auto'
 * @param {boolean} isAv1 - Whether the target codec is AV1
 * @returns {{ isMkv: boolean, ext: string, format: string }}
 */
function resolveContainer(container, isAv1) {
  let isMkv;
  if (container === 'mkv') isMkv = true;
  else if (container === 'mp4') isMkv = false;
  else isMkv = isAv1; // auto
  return {
    isMkv,
    ext: isMkv ? '.mkv' : '.mp4',
    format: isMkv ? 'matroska' : 'mp4',
  };
}

/**
 * Resolve MIME type for a video file extension.
 * @param {string} ext - File extension (with dot), e.g. '.mkv'
 * @returns {string} MIME type
 */
function mimeForExt(ext) {
  const lower = (ext || '').toLowerCase();
  if (lower === '.mkv') return 'video/x-matroska';
  if (lower === '.webm') return 'video/webm';
  return 'video/mp4';
}

/**
 * Build ffmpeg arguments for an encoding job.
 *
 * @param {object} preset - Encoding preset object
 * @param {string} inFile - Input file path
 * @param {string} outFile - Output file path (may be adjusted)
 * @param {object} probeInfo - Probed media info { colorMeta, bitDepth, isHdr, caps, badSubIndices }
 * @param {object} [encodeOpts={}] - User encode options { container, downscale, tonemap }
 * @returns {{ swArgs: string[], hwArgs: string[]|null, container: string, pixFmt: string, isHdr: boolean, actualOutFile: string }}
 */
function buildArgs(preset, inFile, outFile, probeInfo, encodeOpts = {}) {
  const { colorMeta, bitDepth, isHdr, caps: encCaps, badSubIndices } = probeInfo;

  const isAv1 = preset.codec === 'av1';

  // Container selection
  const { isMkv, format: container } = resolveContainer(encodeOpts.container || 'auto', isAv1);

  // Adjust output extension if needed
  const wantExt = isMkv ? '.mkv' : '.mp4';
  if (!outFile.endsWith(wantExt)) {
    outFile = outFile.replace(/\.(mkv|mp4|webm|avi|mov|ts)$/i, wantExt);
  }

  // Tonemapping: if requested and video is HDR, force SDR output
  const doTonemap = !!(encodeOpts.tonemap && isHdr);
  const pixFmt = (!doTonemap && (bitDepth >= 10 || isHdr)) ? 'p010le' : 'yuv420p';

  // Downscale resolution
  const downscale = encodeOpts.downscale ? parseInt(encodeOpts.downscale, 10) : 0;

  const tail = [];
  const vfFilters = [];

  // Build video filters
  if (doTonemap) {
    vfFilters.push(
      'zscale=t=linear:npl=100',
      'format=gbrpf32le',
      'zscale=p=bt709',
      'tonemap=tonemap=hable:desat=0',
      'zscale=t=bt709:m=bt709:r=tv',
      'format=yuv420p'
    );
  }
  if (downscale > 0) {
    vfFilters.push(`scale=-2:${downscale}`);
  }

  // Map streams — MKV only supports video/audio/subtitles
  if (isMkv) {
    tail.push('-map', '0:v', '-map', '0:a?', '-map', '0:s?');
  } else {
    tail.push('-map', '0');
  }
  for (const idx of badSubIndices) {
    tail.push('-map', `-0:${idx}`);
  }
  tail.push('-map_metadata', '0', '-map_chapters', '0');

  if (vfFilters.length) {
    tail.push('-vf', vfFilters.join(','));
  }

  // Video encoder
  tail.push('-c:v:0', preset.encoder);

  // Preset (NVENC p1-p7)
  const nvencPreset = preset.nvencPreset || 'p6';
  if (preset.type === 'nvidia' || preset.type === 'nvidia_group') {
    tail.push('-preset', nvencPreset);
  }
  // VA-API doesn't use -preset

  // 10-bit profile when needed
  if (pixFmt === 'p010le' && encCaps.profile) {
    tail.push('-profile:v', 'main10');
  }

  // Tune (only for NVENC)
  if (encCaps.tune && (preset.type === 'nvidia' || preset.type === 'nvidia_group')) {
    tail.push('-tune', preset.nvencTune || 'hq');
  }

  // Rate control
  const cq = preset.cq || (isAv1 ? 30 : 23);
  if (preset.type === 'nvidia' || preset.type === 'nvidia_group') {
    if (isAv1) {
      if (encCaps.rc && encCaps.qp) {
        tail.push('-rc', 'constqp', '-qp', String(cq));
      } else if (encCaps.rc && encCaps.cq) {
        tail.push('-rc', 'vbr', '-cq', String(cq));
      }
    } else {
      if (encCaps.rc && encCaps.cq) {
        tail.push('-rc', 'vbr_hq', '-cq', String(cq));
      } else if (encCaps.rc && encCaps.qp) {
        tail.push('-rc', 'constqp', '-qp', String(cq));
      }
    }
  } else if (preset.type === 'vaapi' || preset.type === 'vaapi_group') {
    tail.push('-rc_mode', 'CQP', '-global_quality', String(cq));
  } else if (preset.type === 'qsv') {
    tail.push('-global_quality', String(cq), '-preset', 'medium');
  } else {
    if (preset.encoder === 'libx265') tail.push('-crf', String(cq), '-preset', 'medium');
    else if (preset.encoder === 'libsvtav1') tail.push('-crf', String(cq), '-preset', '6');
    else if (preset.encoder === 'libaom-av1') tail.push('-crf', String(cq), '-cpu-used', '4');
  }

  // Pixel format
  tail.push('-pix_fmt', pixFmt);

  // Preserve color signaling (skip if tonemapping)
  if (!doTonemap) {
    const { transfer, primaries, space, range } = colorMeta;
    if (primaries && primaries !== 'unknown' && primaries !== 'N/A') tail.push('-color_primaries', primaries);
    if (transfer && transfer !== 'unknown' && transfer !== 'N/A') tail.push('-color_trc', transfer);
    if (space && space !== 'unknown' && space !== 'N/A') tail.push('-colorspace', space);
    if (range && range !== 'unknown' && range !== 'N/A') tail.push('-color_range', range);
  }

  // Spatial AQ (NVENC quality improvement)
  if (encCaps.spatial_aq) tail.push('-spatial_aq', '1');
  if (encCaps.aq_strength) tail.push('-aq-strength', '8');

  // Timestamp preservation
  tail.push('-fps_mode', 'passthrough');

  // Audio/Subs: copy
  tail.push('-c:a', 'copy', '-c:s', 'copy');
  if (!isMkv) tail.push('-c:d', 'copy', '-c:t', 'copy');

  // Container-specific
  if (!isMkv) tail.push('-movflags', '+faststart');
  tail.push('-f', container, outFile);

  // Common head for all commands
  const commonHead = ['-hide_banner', '-nostdin', '-y', '-probesize', '50M', '-analyzeduration', '50M'];

  const swArgs = [...commonHead, '-i', inFile, '-progress', 'pipe:1', ...tail];

  let hwArgs = null;
  if (preset.type === 'nvidia' || preset.type === 'nvidia_group') {
    hwArgs = [...commonHead,
      '-hwaccel', 'cuda', '-hwaccel_device', '0',
      '-i', inFile, '-progress', 'pipe:1', ...tail];
  }

  return { swArgs, hwArgs, container, pixFmt, isHdr, actualOutFile: outFile };
}

module.exports = {
  buildArgs,
  resolveContainer,
  mimeForExt,
};
