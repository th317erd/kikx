'use strict';

// Lane wrapper for the live-boot exit proof (campaign §6 P0) — the one check
// a green unit suite cannot substitute: real createServer(), real Postgres,
// real auth, real router, a real HTTP socket, a plugin loaded from disk.
//
// Why a wrapper instead of running the proof file directly:
//   - the unit lane is hermetic BY CONTRACT, so under `npm test` this spec
//     runs the proof, the proof exits 2 (no database URL), and the spec
//     SKIPS — the contract holds and the intent stays visible;
//   - the `proof:live-boot` lane is hermetic:false and receives the parsed
//     .env.dev (per-spawn), so there the same spec runs the proof FOR REAL
//     and gates on its exit 0.
//
// The proof itself keeps its standalone contract (still runnable by hand —
// see its header). Exit codes: 0 pass, 1 assertion failure, 2 env missing.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PROOF = fileURLToPath(new URL('./live-boot-exit-proof.mjs', import.meta.url));

test('live-boot proof: real database, real socket, real plugin from disk', { timeout: 240000 }, async (t) => {
  const output = [];
  const child = spawn(process.execPath, [ PROOF ], {
    env: process.env,
    stdio: [ 'ignore', 'pipe', 'pipe' ],
  });
  child.stdout.on('data', (data) => output.push(data.toString()));
  child.stderr.on('data', (data) => output.push(data.toString()));
  const code = await new Promise((resolve) => {
    child.on('close', resolve);
  });

  const text = output.join('');
  if (code === 2) {
    t.skip(`no live database URL in this environment (proof exit 2): ${text.split('\n').slice(0, 3).join(' | ')}`);
    return;
  }
  assert.equal(code, 0, `live-boot proof failed (exit ${code}):\n${text.slice(-3000)}`);
  assert.ok(text.length > 0, 'the proof must say what it verified');
});
