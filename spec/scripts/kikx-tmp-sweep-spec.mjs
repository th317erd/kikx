'use strict';

// Stale test-scratch sweeper (maintenance, 2026-11-14): dozens of specs
// mkdtemp into /tmp with NO teardown — 14,400+ orphaned kikx-* fixture dirs
// accumulated across runs/sessions. Fixing every spec individually is churn
// the leak will outgrow; instead the lane runner sweeps ONCE per invocation,
// age-gated so a concurrent run's fresh dirs (any host, any bot) are never
// touched. Matching mirrors mkdtemp's shape: ^kikx-.+-[A-Za-z0-9]{6}$.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { sweepStaleKikxScratch } = await import('../../scripts/kikx-tmp-sweep.mjs');

function makeRoot() {
  return mkdtempSync(path.join(tmpdir(), 'sweep-spec-'));
}

test('sweep removes ONLY stale kikx-mkdtemp-shaped dirs (age + name gated)', () => {
  const root = makeRoot();
  try {
    const old = path.join(root, 'kikx-plugin-loader-Ab12xY');
    const young = path.join(root, 'kikx-plugin-loader-Zz98qq');
    const oldForeign = path.join(root, 'kikx-arms-854e');      // fixed name, 4-char tail: not mkdtemp shape
    const oldOther = path.join(root, 'other-tool-Qw12Er');      // not kikx-*
    for (const dir of [ old, young, oldForeign, oldOther ]) {
      mkdirSync(dir);
      writeFileSync(path.join(dir, 'x'), 'x');
    }
    const stale = Date.now() / 1000 - 7 * 3600;                 // 7h old = beyond the 6h gate
    for (const dir of [ old, oldForeign, oldOther ])
      utimesSync(dir, stale, stale);

    const removed = sweepStaleKikxScratch({ root, now: Date.now() / 1000 });

    assert.equal(removed.includes(path.basename(old)), true,
      'a stale mkdtemp-shaped kikx dir is swept');
    assert.equal(pathExists(young), true,
      'a FRESH dir survives — concurrent runs (any host/bot) are never touched');
    assert.equal(pathExists(oldForeign), true,
      'a fixed-name kikx dir that is not mkdtemp-shaped survives');
    assert.equal(pathExists(oldOther), true,
      'foreign prefixes are never touched');
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
});

test('sweep on the real tmpdir never throws and never matches non-scratch', () => {
  const probe = path.join(tmpdir(), 'kikx-sweep-probe-not-mkdtemp');
  mkdirSync(probe, { recursive: true });
  const stale = Date.now() / 1000 - 7 * 3600;
  utimesSync(probe, stale, stale);
  const removed = sweepStaleKikxScratch({ now: Date.now() / 1000 });
  assert.equal(pathExists(probe), true, 'our fixed-name probe is not mkdtemp-shaped, it survives the real sweep');
  rmSync(probe, { recursive: true, force: true });
  assert.ok(Array.isArray(removed), 'returns the list it removed (or [])');
});

function pathExists(target) {
  try {
    statSync(target);
    return true;
  } catch (_error) {
    return false;
  }
}
