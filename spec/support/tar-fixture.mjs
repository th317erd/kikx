'use strict';

import zlib from 'node:zlib';

// Shared tar fixtures for specs that need real npm-shaped tarballs:
// npm-tarball-spec (extractor guards) and plugin-install-npm-spec (the
// install route end-to-end). The builder writes valid ustar headers —
// checksum included — so only the guards under test ever trip.

function writeOctal(buf, offset, length, value) {
  buf.write(String(value.toString(8)).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
}

function buildHeader({ name, size, type = '0', mode = 0o644, prefix = '', linkname = '' }) {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 100, 'utf8');
  writeOctal(h, 100, 8, mode);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, 0);
  h.write('        ', 148, 8, 'ascii'); // checksum placeholder = spaces
  h.write(type, 156, 1, 'ascii');
  h.write(linkname.slice(0, 100), 157, 100, 'utf8');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  if (prefix) h.write(prefix.slice(0, 155), 345, 155, 'utf8');
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

// entries: {name, data?, type?, mode?, prefix?, linkname?} — type '5' = dir,
// '2' = symlink, '0' = file. Ends with the two zero blocks every reader
// requires.
export function buildTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data || '', 'utf8');
    blocks.push(buildHeader({
      name: entry.name,
      size: data.length,
      type: entry.type || '0',
      mode: entry.mode ?? 0o644,
      prefix: entry.prefix || '',
      linkname: entry.linkname || '',
    }));
    if (data.length) {
      const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
      data.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export function gzipTar(entries) {
  return zlib.gzipSync(buildTar(entries));
}
