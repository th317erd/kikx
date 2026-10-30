#!/usr/bin/env node
'use strict';

// Runs every test lane and reports each one, so a green number can never again
// describe only part of the suite.
//
// Usage:
//   node scripts/run-test-lanes.mjs               # unit + playwright
//   node scripts/run-test-lanes.mjs --all         # also stagehand + puppeteer
//   node scripts/run-test-lanes.mjs unit          # one named lane
//
// Exit code is 0 only if every lane that ran passed.
//
// Two defects this file exists to make impossible:
//
//  1. A single-glob gate. The lane globs are disjoint, so `npm test` naming only
//     the unit glob reported green while every browser spec went unrun. That is
//     why `npm test` must not pass a lane argument.
//
//  2. A green lane that ran nothing. Ten of the twelve Playwright specs call
//     `t.skip('requires Chrome')`. Without a machine lacking Chrome, that lane
//     exits 0 having executed zero assertions, and a bare exit code reads as a
//     pass. So the child's own reporter output is parsed and a lane that matched
//     files but executed no tests is reported as EMPTY and fails the gate.

import { spawn } from 'node:child_process';

import { LANES, resolveSelection, unknownLaneNames } from './test-lanes.mjs';

// Node's spec reporter prints e.g. "ℹ tests 17" / "ℹ skipped 2". Anything read
// from this must come from the child's reporter, not from spec console output.
function parseCount(output, label) {
  let matches = [ ...output.matchAll(new RegExp(`^\\u2139 ${label} (\\d+)$`, 'gm')) ];
  if (matches.length === 0)
    return null;

  // A lane runs one child, so one reporter block is expected; take the last in
  // case a spec emits a lookalike line earlier.
  return Number(matches.at(-1)[1]);
}

function runLane(lane) {
  return new Promise((resolve) => {
    let startedAt = Date.now();
    let chunks = [];

    // Piped rather than inherited so the reporter summary can be parsed. Output
    // is still streamed live, so a long lane never looks frozen.
    let child = spawn(process.execPath, [
      '--test',
      `--test-timeout=${lane.testTimeout}`,
      ...lane.globs,
    ], { stdio: [ 'ignore', 'pipe', 'pipe' ] });

    let stream = (data, target) => {
      chunks.push(data.toString());
      target.write(data);
    };
    child.stdout.on('data', (data) => stream(data, process.stdout));
    child.stderr.on('data', (data) => stream(data, process.stderr));

    let timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, lane.timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ name: lane.name, ok: false, exitCode: null, error: error.message, durationMs: Date.now() - startedAt });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);

      let output = chunks.join('');
      let tests = parseCount(output, 'tests');
      let skipped = parseCount(output, 'skipped') ?? 0;
      let failed = parseCount(output, 'fail') ?? 0;

      // "tests" counts skipped tests too. A lane whose every spec skipped itself
      // executed nothing, and an exit code of 0 says only that nothing failed.
      let executed = tests === null ? null : tests - skipped - failed;

      resolve({
        name: lane.name,
        ok: code === 0 && !signal,
        exitCode: code,
        signal,
        tests,
        skipped,
        failed,
        executed,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

let selection = resolveSelection(process.argv.slice(2));
let unknown = unknownLaneNames(selection);
if (unknown.length > 0) {
  console.error(`Unknown lane(s): ${unknown.join(', ')}`);
  console.error(`Known lanes: ${LANES.map((lane) => lane.name).join(', ')}`);
  process.exit(2);
}

let selected = LANES.filter((lane) => selection.has(lane.name));
let notRun = LANES.filter((lane) => !selection.has(lane.name));

let results = [];
for (let lane of selected) {
  console.log(`\n=== lane: ${lane.name} (${lane.globs.join(' ')}) ===`);
  let result = await runLane(lane);
  results.push(result);
  let counted = result.tests === null
    ? 'no reporter summary'
    : `${result.executed} executed / ${result.tests} registered / ${result.skipped} skipped`;
  console.log(`=== lane: ${lane.name} -> ${result.ok ? 'PASS' : 'FAIL'} (exit ${result.exitCode}${result.signal ? `, signal ${result.signal}` : ''}, ${result.durationMs} ms, ${counted}) ===`);
}

console.log('\n=== test lanes summary ===');
for (let result of results) {
  let counted = result.tests === null
    ? 'executed=?'
    : `executed=${result.executed} skipped=${result.skipped}`;
  console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.name}  exit=${result.exitCode}  ${result.durationMs} ms  ${counted}`);
}

// An unrun lane is reported loudly. Silence is what let the UI lanes rot
// unnoticed for a full cycle; an explicit NOT RUN line cannot be mistaken for a
// pass, and a summary that lists only PASS lines is a claim about what ran.
for (let lane of notRun) {
  let why = lane.hermetic
    ? `not selected — run: node scripts/run-test-lanes.mjs ${lane.name}`
    : `not selected — needs live services/credentials; run: node scripts/run-test-lanes.mjs ${lane.name}`;
  console.log(`  NOT RUN  ${lane.name}  ${why}`);
}

let failed = results.filter((result) => !result.ok);

// Every spec skipped is not a pass. Reported separately from FAIL so the reason
// is unambiguous: the lane matched files, ran none of them, and would otherwise
// have contributed a reassuring green line to the gate.
let empty = results.filter((result) => result.ok && result.executed === 0);

for (let result of empty) {
  console.log(`  EMPTY  ${result.name}  matched its globs but executed no tests (${result.skipped} skipped)`);
  console.log(`         every spec in this lane skipped itself; usually the browser binary is missing.`);
  console.log(`         Not counted as a pass. Set KIKX_STAGEHAND_CHROME_PATH or install Chrome.`);
}

if (failed.length > 0 || empty.length > 0) {
  if (failed.length > 0)
    console.log(`\nLANES_FAILED=${failed.length}`);
  if (empty.length > 0)
    console.log(`LANES_EMPTY=${empty.length}`);
  console.log('LANES_EXIT=1');
  process.exit(1);
}

console.log(`\nLANES_RAN=${results.length}`);
console.log('LANES_EXIT=0');
process.exit(0);
