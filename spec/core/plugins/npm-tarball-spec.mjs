'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { extractTarball } from '../../../src/core/plugins/npm-tar.mjs';

// Campaign S3 slice 2 (plan 5-S3): "extract with tarbomb/path-traversal
// guards". Dependency-free ustar/pax reader; every hostile shape must throw
// a guarded error instead of writing outside the landing directory.

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

function buildTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data || '', 'utf8');
    blocks.push(buildHeader({ name: entry.name, size: data.length, type: entry.type || '0', mode: entry.mode ?? 0o644, prefix: entry.prefix || '', linkname: entry.linkname || '' }));
    if (data.length) {
      const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
      data.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks: end of archive
  return Buffer.concat(blocks);
}

function tmpDest(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikx-tar-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('extracts an npm-shaped tarball, stripping the package/ root', (t) => {
  const dest = tmpDest(t);
  const tar = buildTar([
    { name: 'package/', type: '5' },
    { name: 'package/plugin.json', data: '{"name":"echo"}' },
    { name: 'package/lib/deep.mjs', data: 'export {}' },
  ]);
  const out = extractTarball(zlib.gzipSync(tar), dest);
  assert.equal(out.files, 2, 'two files landed (root dir entry is structure, not content)');
  assert.equal(fs.readFileSync(path.join(dest, 'plugin.json'), 'utf8'), '{"name":"echo"}');
  assert.ok(fs.existsSync(path.join(dest, 'lib', 'deep.mjs')), 'nested paths land under dest');
});

test('rejects path traversal: entry escaping the landing directory', (t) => {
  const dest = tmpDest(t);
  for (const evil of ['package/../../../evil.mjs', 'package/a/../../b', '../outside']) {
    const tar = buildTar([{ name: evil, data: 'x' }]);
    assert.throws(() => extractTarball(zlib.gzipSync(tar), dest), (e) => e && e.error === 'path-traversal', `must reject ${evil}`);
  }
  assert.ok(!fs.existsSync(path.join(dest, '..', 'evil.mjs')), 'nothing written outside dest');
});

test('rejects absolute paths and hostile entry types', (t) => {
  const dest = tmpDest(t);
  assert.throws(
    () => extractTarball(zlib.gzipSync(buildTar([{ name: '/etc/passwd', data: 'x' }])), dest),
    (e) => e.error === 'absolute-path',
  );
  assert.throws(
    () => extractTarball(zlib.gzipSync(buildTar([{ name: 'package/link', type: '2', linkname: '../../..', data: '' }])), dest),
    (e) => e.error === 'unsupported-entry',
    'symlinks are never materialised — a plugin tarball does not need them',
  );
  assert.throws(
    () => extractTarball(zlib.gzipSync(buildTar([{ name: 'package/hard', type: '1', linkname: '/etc/shadow', data: '' }])), dest),
    (e) => e.error === 'unsupported-entry',
  );
});

test('resolves long names via ustar prefix', (t) => {
  const dest = tmpDest(t);
  const deep = 'a'.repeat(60) + '/' + 'b'.repeat(60);
  const tar = buildTar([{ name: 'b'.repeat(60), prefix: 'package/' + deep.slice(0, 85), data: 'ok' }]);
  // header name is the LAST path component; prefix carries the rest.
  const prefix = 'package/' + 'a'.repeat(60);
  const name = 'b'.repeat(60);
  const rebuilt = buildTar([{ name, prefix, data: 'ok' }]);
  const out = extractTarball(zlib.gzipSync(rebuilt), dest);
  assert.equal(out.files, 1);
  assert.ok(fs.existsSync(path.join(dest, 'a'.repeat(60), 'b'.repeat(60))), 'prefix/name concatenates under dest');
  assert.ok(tar.length > 0);
});

test('gunzip output cap stops a decompression bomb before it writes', (t) => {
  const dest = tmpDest(t);
  const bomb = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024, 0));
  assert.ok(bomb.length < 200 * 1024, 'the bomb compresses tiny');
  assert.throws(
    () => extractTarball(bomb, dest, { maxOutputBytes: 1024 * 1024 }),
    (e) => e.error === 'output-too-large',
  );
});

test('bounds entry count', (t) => {
  const dest = tmpDest(t);
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `package/f${i}`, data: 'x' }));
  assert.throws(
    () => extractTarball(zlib.gzipSync(buildTar(many)), dest, { maxEntries: 10 }),
    (e) => e.error === 'too-many-entries',
  );
});

test('a corrupted/truncated archive fails closed', (t) => {
  const dest = tmpDest(t);
  const tar = buildTar([{ name: 'package/ok.txt', data: 'hi' }]);
  tar[200] ^= 0xff; // flip a byte inside the header (post-checksum region)
  assert.throws(() => extractTarball(zlib.gzipSync(tar), dest), (e) => typeof e.error === 'string');
  assert.throws(() => extractTarball(Buffer.from('not gzip at all'), dest), (e) => e.error === 'decompress-failed');
});
