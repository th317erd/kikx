'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
  pickRegistryBase,
  resolveVersionSpec,
  resolvePackage,
  verifyIntegrity,
  downloadTarball,
  isOutdated,
} from '../../../src/core/plugins/npm-registry.mjs';

// Campaign S3 slice 2 (plan 5-S3): resolve against CONFIGURED registries
// (never a hardcoded host — 10), fetch over HTTPS, verify dist.integrity
// sha512 before anything is unpacked. All registry traffic is injected
// (mocked in tests; the plan requires it).

const PUBLIC_NPM = 'https://registry.npmjs.org';

function mockFetch(routes) {
  return async (url) => {
    const hit = routes.find((r) => (r.match instanceof RegExp ? r.match.test(url) : r.match === url));
    if (!hit) return { ok: false, status: 404, headers: { get: () => null } };
    const body = Buffer.isBuffer(hit.body) ? hit.body
      : Buffer.from(typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body ?? {}));
    return {
      ok: hit.status ? hit.status < 400 : true,
      status: hit.status || 200,
      headers: { get: (k) => (k === 'content-length' ? String(body.length) : null) },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
}

test('pickRegistryBase: defaults to public npm, honours config order, rejects unsafe URLs', () => {
  assert.equal(pickRegistryBase(undefined), PUBLIC_NPM, 'default is public npm when config is unset');
  assert.equal(pickRegistryBase(''), PUBLIC_NPM);
  assert.equal(pickRegistryBase('https://mirror.example, https://second.example'), 'https://mirror.example');
  assert.equal(pickRegistryBase('nope, ftp://x, http://evil.example'), PUBLIC_NPM, 'non-https skipped');
  assert.equal(pickRegistryBase('http://127.0.0.1:4873'), 'http://127.0.0.1:4873', 'loopback http allowed (local mirrors/tests)');
  assert.equal(pickRegistryBase(['https://array.example']), 'https://array.example');
  assert.equal(pickRegistryBase('https://user:pass@host.example'), PUBLIC_NPM, 'credentials in URL rejected');
});

test('resolveVersionSpec: latest, exact, dist-tag, and ranges pick the right version', () => {
  const packument = {
    'dist-tags': { latest: '2.1.0', next: '3.0.0-rc.1' },
    versions: {
      '1.0.0': {}, '1.2.0': {}, '1.2.5': {}, '2.0.0': {}, '2.1.0': {},
      '2.2.0-beta.1': {}, '3.0.0-rc.1': {},
    },
  };
  assert.equal(resolveVersionSpec(packument, null), '2.1.0', 'no spec = latest dist-tag');
  assert.equal(resolveVersionSpec(packument, '1.2.0'), '1.2.0', 'exact wins');
  assert.equal(resolveVersionSpec(packument, 'next'), '3.0.0-rc.1', 'dist-tag resolves');
  assert.equal(resolveVersionSpec(packument, '^2.0.0'), '2.1.0', 'caret: highest stable in major, prereleases excluded');
  assert.equal(resolveVersionSpec(packument, '~1.2.0'), '1.2.5', 'tilde: highest patch');
  assert.equal(resolveVersionSpec(packument, '1.x'), '1.2.5', 'x-range');
  assert.equal(resolveVersionSpec(packument, '>=2.0.0'), '2.1.0', 'comparator');
  assert.equal(resolveVersionSpec(packument, '3.0.0-rc.1'), '3.0.0-rc.1', 'exact prerelease still allowed when pinned');
  assert.equal(resolveVersionSpec(packument, '^9.9.9'), null, 'nothing satisfying = null (route answers 404)');
  assert.equal(resolveVersionSpec(packument, 'garbage-range'), null);
});

test('resolvePackage: resolves metadata, encodes scoped names, fails closed on missing integrity', async () => {
  const packument = {
    'dist-tags': { latest: '1.4.0' },
    versions: { '1.4.0': { dist: { tarball: 'https://registry.npmjs.org/kikx-echo/-/kikx-echo-1.4.0.tgz', integrity: 'sha512-dead' } } },
  };
  let seen = null;
  const fetchImpl = mockFetch([{ match: /kikx-echo$/, body: packument }]);
  const wrapped = async (url, opts) => { seen = url; return fetchImpl(url, opts); };

  const ok = await resolvePackage('kikx-echo', null, { fetchImpl: wrapped });
  assert.equal(ok.version, '1.4.0');
  assert.equal(ok.integrity, 'sha512-dead');
  assert.equal(ok.registry, PUBLIC_NPM);
  assert.ok(seen.endsWith('/kikx-echo'), `packument fetched from registry root, saw ${seen}`);

  // Scoped names must be URL-encoded (the '/' inside the name).
  let scopedSeen = null;
  await resolvePackage('@scope/name', '1.4.0', {
    fetchImpl: async (url) => { scopedSeen = url; return mockFetch([{ match: /name$/, body: packument }])(url); },
  });
  assert.ok(scopedSeen.includes('%2f'), `scoped packument URL is encoded, saw ${scopedSeen}`);

  // No integrity = no install: the whole S4+S3 posture is signature + hash.
  const noHash = {
    'dist-tags': { latest: '1.4.0' },
    versions: { '1.4.0': { dist: { tarball: 'https://registry.npmjs.org/x.tgz' } } },
  };
  const failed = await resolvePackage('x', null, { fetchImpl: mockFetch([{ match: /\/x$/, body: noHash }]) });
  assert.equal(failed && failed.error, 'integrity-missing', 'missing dist.integrity fails closed');

  // The tarball must stay on the registry's own origin — a packument cannot
  // redirect the download into attacker space (10: enterprise posture).
  const evilOrigin = {
    'dist-tags': { latest: '1.4.0' },
    versions: { '1.4.0': { dist: { tarball: 'https://evil.example/x.tgz', integrity: 'sha512-aaaa' } } },
  };
  const mismatched = await resolvePackage('x', null, { fetchImpl: mockFetch([{ match: /\/x$/, body: evilOrigin }]) });
  assert.equal(mismatched && mismatched.error, 'tarball-origin-mismatch', 'cross-origin tarball URL fails closed');

  const missing = await resolvePackage('ghost', '9.9.9', { fetchImpl: mockFetch([]) });
  assert.equal(missing && missing.error, 'version-not-found');
});

test('verifyIntegrity: sha512 SRI match, multi-token SRI, tamper detection', async () => {
  const bytes = zlib.gzipSync(Buffer.from(JSON.stringify({ plugin: 'real' })));
  const good = 'sha512-' + (await import('node:crypto')).createHash('sha512').update(bytes).digest('base64');
  assert.equal(verifyIntegrity(bytes, good), true);
  assert.equal(verifyIntegrity(bytes, `sha256-aaaa ${good}`), true, 'any sha512 token in the SRI list may match');
  assert.equal(verifyIntegrity(bytes, 'sha512-' + 'B'.repeat(88)), false, 'tampered bytes fail');
  assert.equal(verifyIntegrity(bytes, undefined), false, 'no SRI = fail');
});

test('isOutdated: only a strictly newer latest counts — everything uncertain is false', () => {
  assert.equal(isOutdated('1.0.0', '1.1.0'), true, 'newer = chip');
  assert.equal(isOutdated('2.0.0-rc.1', '2.0.0'), true, 'prerelease to its release = chip');
  assert.equal(isOutdated('2.0.0', '2.0.0'), false, 'equal = no chip');
  assert.equal(isOutdated('1.0.0', '0.9.0'), false, 'registry behind the install = no chip');
  assert.equal(isOutdated(null, '1.1.0'), false, 'unknown installed version = no chip (plan: lookup failure = no chip)');
  assert.equal(isOutdated('weird', 'also-weird'), false, 'unparsable comparison = no chip, never a guess');
  assert.equal(isOutdated('1.0.0', null), false);
});

test('downloadTarball: fetches, verifies before use, enforces size cap', async () => {
  const bytes = zlib.gzipSync(Buffer.from('tar-bytes'));
  const sri = 'sha512-' + (await import('node:crypto')).createHash('sha512').update(bytes).digest('base64');
  const fetchImpl = mockFetch([{ match: /\.tgz$/, body: bytes }]);
  const got = await downloadTarball({ tarball: 'https://registry.npmjs.org/p/-/p-1.tgz', integrity: sri }, { fetchImpl });
  assert.ok(Buffer.isBuffer(got), 'returns verified raw bytes');

  const bad = await downloadTarball({ tarball: 'https://registry.npmjs.org/p/-/p-1.tgz', integrity: 'sha512-' + 'C'.repeat(88) }, { fetchImpl })
    .catch((e) => e);
  assert.equal(bad && bad.error, 'integrity-mismatch', 'tampered download throws before extraction');

  const huge = { error: 'too-large' };
  const capFetcher = async () => ({ ok: true, status: 200, headers: { get: (k) => (k === 'content-length' ? '999999999' : null) }, arrayBuffer: async () => new ArrayBuffer(0) });
  const capped = await downloadTarball({ tarball: 'https://r.example/x.tgz', integrity: sri }, { fetchImpl: capFetcher, maxBytes: 1024 })
    .catch((e) => e);
  assert.equal(capped && (capped.error || huge.error) && capped.error, 'too-large', 'content-length cap rejects oversized tarballs');
  assert.equal(typeof huge.error, 'string');
});
