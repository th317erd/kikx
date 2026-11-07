'use strict';

// Campaign S3 slice 2 (plan 5-S3): "extract with tarbomb/path-traversal
// guards". A dependency-free ustar/pax reader (Kikx ships no tar package and
// never shells out to npm). Guards, in order: gzip output cap (decompression
// bombs die before any write), header checksum + ustar magic, entry-count
// and total-bytes bounds, absolute/traversal rejection on EVERY name
// (including pax/GNU-longname overrides), no symlink/hardlink materialising
// ever, and a resolved-path containment check as belt-and-braces.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BLOCK = 512;
const DEFAULTS = {
  maxOutputBytes: 64 * 1024 * 1024,
  maxEntries: 4000,
  maxTotalBytes: 64 * 1024 * 1024,
};

function fail(error) {
  const e = new Error(`[npm-tar] ${error}`);
  e.error = error;
  throw e;
}

function gunzip(bytes, maxOutputBytes) {
  try {
    return zlib.gunzipSync(bytes, { maxOutputLength: maxOutputBytes });
  } catch (e) {
    if (e && e.code === 'ERR_BUFFER_TOO_LARGE') fail('output-too-large');
    fail('decompress-failed');
  }
}

function readStr(buf, off, len) {
  const slice = buf.subarray(off, off + len);
  const end = slice.indexOf(0);
  return slice.toString('utf8', 0, end === -1 ? slice.length : end);
}

function readOctal(buf, off, len) {
  const s = readStr(buf, off, len).trim().replace(/[^0-7]/g, '');
  if (!s) return 0;
  const n = parseInt(s, 8);
  if (!Number.isSafeInteger(n) || n < 0) fail('corrupt-header');
  return n;
}

function checksumOk(h) {
  const stored = parseInt(readStr(h, 148, 8).trim(), 8);
  if (!Number.isFinite(stored)) return false;
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += (i >= 148 && i < 156) ? 0x20 : h[i];
  return sum === stored;
}

// pax extended records: "<len> key=value\n"; only `path` matters here.
function paxPath(data) {
  let off = 0;
  let result = null;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp === -1) break;
    const len = parseInt(data.toString('ascii', off, sp), 10);
    if (!Number.isFinite(len) || len <= 0 || off + len > data.length) break;
    const record = data.toString('utf8', sp + 1, off + len);
    const eq = record.indexOf('=');
    if (eq !== -1 && record.slice(0, eq) === 'path') result = record.slice(eq + 1).replace(/\n$/, '');
    off += len;
  }
  return result;
}

// Hostile-name guards, then npm's package/ root strip. Any traversal
// segment (even a self-cancelling one) is rejected outright: registry
// tarballs never legitimately contain one, so "clever" paths stay hostile.
function safeRel(fullName) {
  if (typeof fullName !== 'string' || !fullName) return '';
  if (fullName.includes('\\')) fail('path-traversal');
  if (fullName.startsWith('/') || /^[A-Za-z]:/.test(fullName)) fail('absolute-path');
  const out = [];
  for (const part of fullName.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') fail('path-traversal');
    out.push(part);
  }
  if (out[0] === 'package') out.shift();
  return out.join('/');
}

export function extractTarball(gzipBytes, destDir, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const bytes = Buffer.isBuffer(gzipBytes) ? gzipBytes : Buffer.from(gzipBytes);
  const buf = gunzip(bytes, opts.maxOutputBytes);
  fs.mkdirSync(destDir, { recursive: true });
  const destRoot = path.resolve(destDir);
  let offset = 0;
  let entries = 0;
  let files = 0;
  let totalBytes = 0;
  let pendingName = null; // pax 'x'/GNU 'L' override applying to the next entry

  while (offset + BLOCK <= buf.length) {
    const h = buf.subarray(offset, offset + BLOCK);
    if (h.every((b) => b === 0)) break; // end-of-archive marker
    if (!checksumOk(h)) fail('corrupt-header');
    if (!readStr(h, 257, 6).startsWith('ustar')) fail('corrupt-header');
    entries += 1;
    if (entries > opts.maxEntries) fail('too-many-entries');

    const size = readOctal(h, 124, 12);
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    const name = readStr(h, 0, 100);
    const prefix = readStr(h, 345, 155);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) fail('truncated-entry');
    const data = buf.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x' || type === 'g') { const p = paxPath(data); if (p) pendingName = p; continue; }
    if (type === 'L') { pendingName = data.toString('utf8').replace(/\0+$/, ''); continue; }

    const fullName = pendingName ?? (prefix ? `${prefix}/${name}` : name);
    pendingName = null;

    // Links and special files are never materialised — a registry plugin
    // tarball does not need them, and every one is an escape vector.
    if (['1', '2', '3', '4', '6', '7'].includes(type)) fail('unsupported-entry');

    const rel = safeRel(fullName);
    if (type === '5') {
      if (rel) fs.mkdirSync(path.join(destRoot, rel), { recursive: true });
      continue;
    }
    if (!rel) continue;

    totalBytes += size;
    if (totalBytes > opts.maxTotalBytes) fail('total-too-large');
    const target = path.resolve(destRoot, rel);
    if (target !== destRoot && !target.startsWith(destRoot + path.sep)) fail('path-traversal');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const mode = (readOctal(h, 100, 8) & 0o111) ? 0o755 : 0o644;
    fs.writeFileSync(target, data, { mode });
    files += 1;
  }
  return { files, bytes: totalBytes };
}
