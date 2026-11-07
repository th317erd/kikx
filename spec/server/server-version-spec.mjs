'use strict';

// =============================================================================
// Instance version identity (owner task, 2026-11-07)
// =============================================================================
// "I just want to be able to see which Kikx instances are on which Kikx
// versions" — many instances, many checkouts. The resolver answers with ONE
// string per boot:
//
//   KIKX_VERSION env (instance identity set by the operator)  wins,
//   else the checkout's git short hash (+dirty when the tree is not clean),
//   else 'unknown' (no git, e.g. a container).
//
// Memoized: /health is a probe and must not shell out per request. The exec
// seam is injectable so the rules are testable without a git binary, and no
// raw process.env appears (the no-process-env gate: ambient reads go through
// snapshotEnvironment, as every src/ module outside core/config must).

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveKikxVersion, resetKikxVersionForTests } from '../../src/server/version.mjs';

test('KIKX_VERSION env wins — operator-set instance identity beats git', () => {
  resetKikxVersionForTests();
  const version = resolveKikxVersion({
    env: { KIKX_VERSION: 'inst-7' },
    exec: () => { throw new Error('git must not be consulted when env decides'); },
  });
  assert.equal(version, 'inst-7');
  resetKikxVersionForTests();
});

test('git fallback: short hash, +dirty when the tree is dirty', () => {
  resetKikxVersionForTests();
  const calls = [];
  const clean = resolveKikxVersion({
    env: {},
    exec: (cmd, args) => {
      calls.push([ cmd, ...args ].join(' '));
      if (args.includes('rev-parse')) return 'abc12345';
      if (args.includes('status')) return '';
      throw new Error(`unexpected: ${cmd} ${args}`);
    },
  });
  assert.equal(clean, 'abc12345');
  assert.ok(calls.some((c) => c.includes('rev-parse')), 'the hash came from git');

  resetKikxVersionForTests();
  const dirty = resolveKikxVersion({
    env: {},
    exec: (_cmd, args) => (args.includes('rev-parse') ? 'abc12345' : ' M src/x.css'),
  });
  assert.equal(dirty, 'abc12345+dirty', 'a dirty checkout is visibly not a clean release');
  resetKikxVersionForTests();
});

test('no env and no git degrades to the literal unknown — never a throw', () => {
  resetKikxVersionForTests();
  const version = resolveKikxVersion({
    env: {},
    exec: () => { throw new Error('ENOENT: git'); },
  });
  assert.equal(version, 'unknown');
  resetKikxVersionForTests();
});

test('memoized: repeated probes do not re-exec (health stays cheap)', () => {
  resetKikxVersionForTests();
  let execs = 0;
  const options = {
    env: { KIKX_VERSION: 'memo-test' },
    exec: () => { execs++; return 'x'; },
  };
  resolveKikxVersion(options);
  resolveKikxVersion(options);
  resolveKikxVersion(options);
  assert.equal(execs, 0, 'env resolution is memoized without touching exec at all');
  resetKikxVersionForTests();
});

test('the health route reports the version (source gate)', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../src/server/routes/infra-routes.mjs', import.meta.url), 'utf8');
  assert.match(source, /version:[^;\n]*resolveKikxVersion\(\)/,
    'GET /health must carry the instance version — that is the fleet-facing surface');
  assert.match(source, /resolveKikxVersion/, 'and must import the resolver');
});
