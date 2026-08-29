'use strict';

const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;

function parseByteRange(header, fileSize, maxChunkSize = DEFAULT_CHUNK_SIZE) {
  if (!header) return null;
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) throw new RangeError('Invalid file size');

  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (!match[1] && !match[2])) throw new RangeError('Invalid byte range');

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) throw new RangeError('Invalid suffix range');
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else {
    start = Number(match[1]);
    if (!Number.isSafeInteger(start) || start < 0 || start >= fileSize) throw new RangeError('Range start out of bounds');
    if (match[2]) {
      end = Number(match[2]);
      if (!Number.isSafeInteger(end) || end < start) throw new RangeError('Invalid range end');
      end = Math.min(end, fileSize - 1);
    } else {
      end = Math.min(start + maxChunkSize - 1, fileSize - 1);
    }
  }

  return { start, end, length: end - start + 1 };
}

module.exports = { DEFAULT_CHUNK_SIZE, parseByteRange };
