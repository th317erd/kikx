'use strict';

// Guards the gate itself.
//
// The defect this spec exists to prevent: the lane globs are disjoint, so a
// single-glob `npm test` reported green while every browser spec went unrun.
// Several "full suite green" reports were quoted from that command. Fixing the
// script once is not enough — without a test, the globs can drift apart again
// and the gate silently returns to covering only part of the suite.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_LANE_NAMES,
  LANES,
  SPEC_SUFFIXES,
  resolveSelection,
  unknownLaneNames,
} from '../../scripts/test-lanes.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

// Directories that hold specs the gate is not expected to run. Each entry is a
// deliberate exclusion, asserted below to still exist, so a stale exclusion is a
// test failure rather than a quiet hole.
const UNGATED_TREES = [
  {
    prefix: 'old-app/',
    reason: 'archived pre-rewrite application, tracked for reference only',
  },
  {
    prefix: 'spec/ui/spike/',
    // The one file here carrying a spec suffix, spike-benchmark-puppeteer.mjs,
    // measures canvas-vs-HTML card paint cost and writes spike-results.json; it
    // asserts nothing and is not a gate. The lane globs correctly do not reach
    // it, so it is excluded explicitly rather than widening a lane to swallow a
    // benchmark. Delete this entry if the spike is ever promoted to a real spec.
    reason: 'throwaway canvas-vs-HTML performance spike; benchmarks, does not assert',
  },
  {
    prefix: 'node_modules/',
    reason: 'third-party packages',
  },
];

// Uses the same glob implementation the test runner itself expands patterns
// with, so a lane that would match nothing at run time also matches nothing
// here.
async function globMatches(glob) {
  let matches = [];
  for await (let file of fs.glob(glob, { cwd: REPO_ROOT }))
    matches.push(file.split(path.sep).join('/'));

  return matches;
}

async function collectSpecFiles(directory = REPO_ROOT, prefix = '') {
  let found = [];
  let entries = await fs.readdir(directory, { withFileTypes: true });
  for (let entry of entries) {
    let relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (UNGATED_TREES.some((tree) => `${relative}/`.startsWith(tree.prefix)))
      continue;

    if (entry.isDirectory()) {
      found.push(...await collectSpecFiles(path.join(directory, entry.name), relative));
      continue;
    }

    if (SPEC_SUFFIXES.some((suffix) => entry.name.endsWith(suffix)))
      found.push(relative);
  }

  return found;
}

test('every spec file in the gated tree is covered by at least one lane', async () => {
  let files = await collectSpecFiles();
  assert.ok(files.length > 0, 'expected to find spec files');

  let covered = new Set();
  let laneHits = new Map();
  for (let lane of LANES) {
    let hits = new Set();
    for (let glob of lane.globs) {
      for (let file of await globMatches(glob)) {
        hits.add(file);
        covered.add(file);
      }
    }

    laneHits.set(lane.name, hits);
  }

  // A lane whose globs match nothing is the silent failure mode: the runner
  // prints PASS for a lane that executed no specs at all.
  for (let [ name, hits ] of laneHits)
    assert.ok(hits.size > 0, `lane ${name} matched no spec files; its PASS would mean nothing`);

  let uncovered = files.filter((file) => !covered.has(file));
  assert.deepEqual(uncovered, [], `spec files not covered by any lane: ${uncovered.join(', ')}`);
});

// An exclusion that has rotted into pointing at nothing is worse than no
// exclusion: it hides the fact that the directory it was guarding is gone. Only
// node_modules is skipped, because an uninstalled checkout legitimately lacks it.
test('each ungated tree still exists, so the exclusion is not stale', async () => {
  for (let tree of UNGATED_TREES) {
    if (tree.prefix === 'node_modules/')
      continue;

    let stats = await fs.stat(path.join(REPO_ROOT, tree.prefix)).catch(() => null);
    assert.ok(stats?.isDirectory(), `ungated tree ${tree.prefix} is gone (${tree.reason}); drop the exclusion`);
  }
});

// Guards against the opposite mistake: excluding a directory that also holds
// specs a lane genuinely covers, which would silently drop real tests.
test('no ungated tree overlaps a lane glob', async () => {
  for (let tree of UNGATED_TREES) {
    if (tree.prefix === 'node_modules/')
      continue;

    for (let lane of LANES) {
      for (let glob of lane.globs) {
        let hit = (await globMatches(glob)).filter((file) => file.startsWith(tree.prefix));
        assert.deepEqual(
          hit,
          [],
          `ungated tree ${tree.prefix} is also matched by lane ${lane.name} (${glob}); the exclusion would hide real specs`,
        );
      }
    }
  }
});

test('the default gate includes the browser lane, not just the unit globs', () => {
  let defaults = LANES.filter((lane) => DEFAULT_LANE_NAMES.includes(lane.name));

  assert.ok(defaults.some((lane) => lane.name === 'unit'), 'default gate must include the unit lane');
  assert.ok(
    defaults.some((lane) => lane.globs.some((glob) => glob.includes('playwright'))),
    'default gate must include the Playwright browser lane',
  );
});

test('the unit glob cannot see the browser specs, which is the original defect', async () => {
  let unitLane = LANES.find((lane) => lane.name === 'unit');
  let playwrightLane = LANES.find((lane) => lane.name === 'ui:playwright');
  assert.ok(unitLane && playwrightLane);

  let playwrightFiles = [];
  for (let glob of playwrightLane.globs)
    playwrightFiles.push(...await globMatches(glob));

  assert.ok(playwrightFiles.length > 0, 'expected Playwright specs to exist');

  let swallowed = [];
  for (let glob of unitLane.globs) {
    let unitFiles = new Set(await globMatches(glob));
    swallowed.push(...playwrightFiles.filter((file) => unitFiles.has(file)));
  }

  assert.deepEqual(
    swallowed,
    [],
    'the unit glob now matches Playwright specs; revisit whether the separate browser lane is still needed',
  );
});

test('every lane has a unique name, globs, and a timeout', () => {
  let names = LANES.map((lane) => lane.name);
  assert.equal(new Set(names).size, names.length, 'lane names must be unique');
  for (let lane of LANES) {
    assert.ok(lane.globs.length > 0, `lane ${lane.name} has no globs`);
    assert.ok(lane.testTimeout, `lane ${lane.name} has no per-test timeout`);
    assert.ok(typeof lane.hermetic === 'boolean', `lane ${lane.name} must declare hermetic`);
  }
});

test('selection defaults are a subset of the declared lanes', () => {
  let names = new Set(LANES.map((lane) => lane.name));
  for (let name of DEFAULT_LANE_NAMES)
    assert.ok(names.has(name), `default lane ${name} is not declared`);
});

test('lane selection parses flags and rejects unknown lanes', () => {
  assert.deepEqual([ ...resolveSelection([]) ].sort(), [ ...DEFAULT_LANE_NAMES ].sort());
  assert.deepEqual([ ...resolveSelection([ '--all' ]) ].sort(), LANES.map((lane) => lane.name).sort());
  assert.deepEqual([ ...resolveSelection([ 'unit' ]) ], [ 'unit' ]);

  assert.deepEqual(unknownLaneNames(new Set([ 'unit' ])), []);
  assert.deepEqual(unknownLaneNames(new Set([ 'unit', 'nope' ])), [ 'nope' ]);
});

// The default-lane constants above live in test-lanes.mjs, which the runner also
// reads — but `package.json` is the surface a human actually types. Passing an
// explicit lane name to the runner makes resolveSelection return exactly that
// set, so DEFAULT_LANE_NAMES is never consulted. A `test` script of
// "... run-test-lanes.mjs unit" therefore reintroduces the original defect: every
// test stays green while `npm test` covers only half the suite. That is not
// hypothetical — it was written that way once, and the suite did not notice.
test('the npm test script does not name an explicit lane, which would defeat the default set', async () => {
  let packageJson = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  let testScript = packageJson.scripts?.test;
  assert.equal(typeof testScript, 'string', 'package.json must define a test script');

  assert.match(
    testScript,
    /run-test-lanes\.mjs/,
    'the test script must route through run-test-lanes.mjs, or the lane table is bypassed',
  );

  // Everything after the runner path: a bare trailing flag like --all is fine,
  // but a lane name positionally selects that lane alone.
  let afterRunner = testScript.slice(testScript.indexOf('run-test-lanes.mjs') + 'run-test-lanes.mjs'.length);
  let laneNames = LANES.map((lane) => lane.name);

  let explicit = afterRunner
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => laneNames.includes(token));

  assert.deepEqual(
    explicit,
    [],
    `test script passes explicit lane(s) ${explicit.join(', ')}; that overrides DEFAULT_LANE_NAMES and silently narrows the gate`,
  );
});

// The fast loop must stay fast AND stay a genuine lane selection, so the habit of
// running it does not quietly become the only thing anyone runs.
test('a test:unit fast loop exists and selects only the unit lane', async () => {
  let packageJson = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  let unitScript = packageJson.scripts?.['test:unit'];
  assert.equal(typeof unitScript, 'string', 'package.json must define a test:unit script');
  assert.match(unitScript, /run-test-lanes\.mjs\s+unit\b/, 'test:unit must select the unit lane');
});
