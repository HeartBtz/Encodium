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
  const {
    colorMeta, bitDepth, isHdr, caps: encCaps,
    badSubIndices, subtitleStreams = [],
    validSecondaryVideoIndices = [], badVideoIndices = [],
    vaapiDevice,
  } = probeInfo;

  const isAv1 = preset.codec === 'av1';
  const isNvidia = preset.type === 'nvidia' || preset.type === 'nvidia_group';
  const isVaapi = preset.type === 'vaapi' || preset.type === 'vaapi_group';

  // Container selection
  const { isMkv, format: container } = resolveContainer(encodeOpts.container || 'auto', isAv1);

  // Adjust output extension if needed
  const wantExt = isMkv ? '.mkv' : '.mp4';
  if (!outFile.endsWith(wantExt)) {
    outFile = outFile.replace(/\.(mkv|mp4|webm|avi|mov|ts)$/i, wantExt);
  }

  // Tonemapping: if requested and video is HDR, force SDR output
  const doTonemap = !!(encodeOpts.tonemap && isHdr);

  // Pixel format selection — must match what the encoder actually supports.
  // h264_nvenc does NOT support 10-bit (yuv420p10/p010) on consumer cards;
  // forcing p010le there causes "no NVENC capable devices found for 10 bit".
  // libx264 only natively supports 8-bit unless built with --bit-depth=10.
  const wants10Bit = !doTonemap && (bitDepth >= 10 || isHdr);
  const encoderSupports10Bit = !['h264_nvenc', 'libx264'].includes(preset.encoder);
  const pixFmt = (wants10Bit && encoderSupports10Bit)
    ? (preset.encoder === 'libx265' ? 'yuv420p10le' : 'p010le')
    : 'yuv420p';

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

  // VA-API encoders accept hardware surfaces, not regular CPU frames. Keep
  // tonemapping/downscaling on the CPU, then convert to a supported surface
  // format and upload it to the VA display selected by the scheduler.
  if (isVaapi) {
    const surfaceFormat = pixFmt === 'p010le' ? 'p010le' : 'nv12';
    vfFilters.push(`format=${surfaceFormat}`, 'hwupload');
  }

  // Subtitle codecs that can never be muxed regardless of container.
  // "none" means ffprobe could not identify the codec at all — ffmpeg will
  // refuse to copy or transcode it and the whole job fails with code 218.
  const alwaysDropSubs = new Set(['none', 'unknown', '']);

  // MP4-specific incompatible codecs (image-based or unsupported muxer).
  const mp4IncompatibleSubs = new Set([
    'hdmv_pgs_subtitle', 'pgs', 'dvd_subtitle', 'dvb_subtitle',
    'xsub', 'webvtt',
  ]);

  const dropSubIdx = new Set(badSubIndices.map(i => String(i)));
  for (const s of subtitleStreams) {
    // Always drop streams with unknown/none codec — they crash the muxer.
    if (alwaysDropSubs.has(s.codec)) {
      dropSubIdx.add(String(s.idx));
    } else if (!isMkv && mp4IncompatibleSubs.has(s.codec)) {
      // MP4: also drop image-based subs and webvtt (not supported by mp4 muxer).
      dropSubIdx.add(String(s.idx));
    }
  }

  // Map all streams, then exclude bad subtitle and bad video streams via negative -map.
  // Bad video streams (e.g. mjpeg JPEG LS with no dimensions) crash the muxer with
  // "dimensions not set" — they MUST be explicitly excluded.
  tail.push('-map', '0:v', '-map', '0:a?', '-map', '0:s?');
  if (!isMkv) {
    // MP4 cannot carry attachments (fonts, cover art as data stream, etc.)
    // '-map 0:s?' already handles subs; we just need to skip data/attachment streams.
  }
  for (const idx of dropSubIdx) {
    tail.push('-map', `-0:${idx}`);
  }
  // Exclude video streams with missing/invalid dimensions — these always crash ffmpeg.
  for (const idx of badVideoIndices) {
    tail.push('-map', `-0:${idx}`);
  }
  tail.push('-map_metadata', '0', '-map_chapters', '0');

  if (vfFilters.length) {
    tail.push('-vf', vfFilters.join(','));
  }

  // Copy any secondary video streams (e.g. cover art) explicitly.
  // We only copy streams that have valid dimensions and a known pixel format
  // (validSecondaryVideoIndices). Streams with pix_fmt='none' or missing size
  // are excluded by the negative -map above and must NOT get a -c:v:N copy flag.
  // The output stream index starts at 1 (primary video = 0).
  for (let i = 0; i < validSecondaryVideoIndices.length; i++) {
    tail.push(`-c:v:${i + 1}`, 'copy');
  }

  // Video encoder for primary stream
  tail.push('-c:v:0', preset.encoder);

  // Preset (NVENC p1-p7) — stream-specific to avoid contaminating secondary streams.
  // Validate against the known NVENC preset names (p1-p7 = perf→quality;
  // legacy "default", "fast", "medium", "slow", "hp", "hq", "ll", "llhq",
  // "llhp", "lossless", "losslesshp" still accepted by older ffmpeg). If the
  // user provides garbage we fall back to p6 (high quality).
  const VALID_NVENC_PRESETS = new Set([
    'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7',
    'default', 'fast', 'medium', 'slow', 'hp', 'hq',
    'll', 'llhq', 'llhp', 'lossless', 'losslesshp',
  ]);
  let nvencPreset = preset.nvencPreset || 'p6';
  if (!VALID_NVENC_PRESETS.has(nvencPreset)) nvencPreset = 'p6';
  if (isNvidia) {
    tail.push('-preset:v:0', nvencPreset);
  }
  // VA-API doesn't use -preset

  // HEVC calls its 10-bit profile "main10". AV1 uses main/high/
  // professional profiles instead and infers the profile from P010 input.
  const is10BitPix = pixFmt === 'p010le' || pixFmt === 'yuv420p10le';
  if (is10BitPix && preset.codec === 'h265' && encCaps.profile) {
    tail.push('-profile:v:0', 'main10');
  }

  // Tune (only for NVENC) — stream-specific. Validate similarly.
  const VALID_NVENC_TUNES = new Set(['hq', 'll', 'ull', 'lossless']);
  if (encCaps.tune && isNvidia) {
    let nvencTune = preset.nvencTune || 'hq';
    if (!VALID_NVENC_TUNES.has(nvencTune)) nvencTune = 'hq';
    tail.push('-tune:v:0', nvencTune);
  }

  // Rate control
  const cq = preset.cq ?? (isAv1 ? 30 : 23);
  if (isNvidia) {
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
  } else if (isVaapi) {
    tail.push('-rc_mode', 'CQP', '-global_quality', String(cq));
  } else if (preset.type === 'qsv') {
    tail.push('-global_quality', String(cq), '-preset:v:0', 'medium');
  } else {
    if (['libx264', 'libx265'].includes(preset.encoder)) tail.push('-crf', String(cq), '-preset:v:0', 'medium');
    else if (preset.encoder === 'libsvtav1') tail.push('-crf', String(cq), '-preset:v:0', '6');
    else if (preset.encoder === 'libaom-av1') tail.push('-crf', String(cq), '-cpu-used', '4');
  }

  // For VA-API the filter graph outputs hardware frames whose pixel format is
  // "vaapi". Passing a CPU format here makes ffmpeg insert an impossible
  // auto_scale conversion between CPU and hardware frames.
  if (!isVaapi) tail.push('-pix_fmt', pixFmt);

  // Preserve color signaling (skip if tonemapping)
  if (!doTonemap) {
    const { transfer, primaries, space, range } = colorMeta;
    if (primaries && primaries !== 'unknown' && primaries !== 'N/A') tail.push('-color_primaries', primaries);
    if (transfer && transfer !== 'unknown' && transfer !== 'N/A') tail.push('-color_trc', transfer);
    if (space && space !== 'unknown' && space !== 'N/A') tail.push('-colorspace', space);
    if (range && range !== 'unknown' && range !== 'N/A') tail.push('-color_range', range);
  }

  // Spatial AQ (NVENC quality improvement)
  if (isNvidia && encCaps.spatial_aq) tail.push('-spatial_aq', '1');
  if (isNvidia && encCaps.aq_strength) tail.push('-aq-strength', '8');

  // Timestamp preservation
  tail.push('-fps_mode', 'passthrough');

  // Audio: always copy. Subtitles: copy as-is for MKV; for MP4, transcode
  // to mov_text (the only subtitle codec MP4 supports). If the source
  // subtitle is incompatible (WebVTT, PGS image-based, etc.), ffmpeg
  // would still fail — those need to be in badSubIndices upstream.
  tail.push('-c:a', 'copy');
  if (isMkv) {
    tail.push('-c:s', 'copy');
  } else {
    tail.push('-c:s', 'mov_text');
  }
  // Note: -c:d / -c:t (data/attachments) are intentionally NOT set for MP4
  // because we don't map those streams (MP4 doesn't support font attachments).

  // Container-specific
  if (!isMkv) tail.push('-movflags', '+faststart');
  tail.push('-f', container, outFile);

  // Common head for all commands (20M probe is plenty — default is 5M)
  const commonHead = ['-hide_banner', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-probesize', '20M', '-analyzeduration', '20M'];

  const inputHead = isVaapi
    ? [...commonHead, '-vaapi_device', vaapiDevice || preset.renderDevice || '/dev/dri/renderD128']
    : commonHead;
  const swArgs = [...inputHead, '-i', inFile, '-progress', 'pipe:1', ...tail];

  let hwArgs = null;
  if (isNvidia) {
    const hwHead = [...commonHead, '-hwaccel', 'cuda', '-hwaccel_device', '0'];
    let hwTail = tail;

    // When no CPU-based video filters are needed, keep decoded frames in GPU
    // VRAM via -hwaccel_output_format cuda.  Without this flag ffmpeg copies
    // every decoded frame back to system RAM — with 2 workers on a 8 GB
    // machine this triggers the OOM killer (SIGKILL).
    // -pix_fmt is stripped because NVENC auto-detects the pixel format from
    // CUDA frames; a CPU pixel format would force an unnecessary round-trip.
    if (vfFilters.length === 0) {
      hwHead.push('-hwaccel_output_format', 'cuda');
      const pixIdx = tail.indexOf('-pix_fmt');
      if (pixIdx !== -1) {
        hwTail = [...tail];
        hwTail.splice(pixIdx, 2); // remove '-pix_fmt' and its value
      }
    }

    hwArgs = [...hwHead, '-i', inFile, '-progress', 'pipe:1', ...hwTail];
  }

  return { swArgs, hwArgs, container, pixFmt, isHdr, actualOutFile: outFile };
}

module.exports = {
  buildArgs,
  resolveContainer,
  mimeForExt,
};
