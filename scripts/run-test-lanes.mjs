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
import { readFileSync } from 'node:fs';

import { LANES, resolveSelection, unknownLaneNames } from './test-lanes.mjs';
import { sweepOnce } from './kikx-tmp-sweep.mjs';

// One age-gated sweep of stale test-scratch dirs per invocation (14k+
// accumulated — specs mkdtemp without teardown). See kikx-tmp-sweep.mjs for
// the name+age gates; a concurrent run's fresh dirs are never touched.
try {
  sweepOnce();
} catch (_error) {
  // A sweep failure must never block the lanes.
}

// Non-hermetic lanes (stagehand) inherit the dev environment — plugin
// signature mode, DB creds — the way every scripts/ entry point does via
// env-loader. Measured triage 2026-11-14: without KIKX_PLUGIN_SIGNATURE_MODE
// the loader refused every plugin (no-configured-key), starving the
// plugin-provided components tool-frame tests wait on.
//
// CRITICAL: this must be PER-SPAWN env, never process.loadEnvFile in the
// parent — loadEnvFile pollutes process.env for every later lane in the same
// run, and the unit lane is hermetic BY CONTRACT (measured: 18 unit failures
// on teams/auth routes that assume an ambient-clean environment). Explicit
// ambient vars still win ({ ...process.env, ...dev }).
function readDevEnv(path) {
  try {
    const parsed = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match)
        continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
        value = value.slice(1, -1);
      parsed[match[1]] = value;
    }
    return parsed;
  } catch (_error) {
    return {};
  }
}

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
      // Optional per-lane cap: Node defaults to one file per CPU, which
      // thrashes lanes whose tests each launch a browser AND call a shared
      // cloud model endpoint (measured: stagehand 6/28 at default, waits
      // blowing at 10s under 28-way contention against ONE Ollama relay).
      ...(lane.concurrency ? [ `--test-concurrency=${lane.concurrency}` ] : []),
      ...lane.globs,
    ], {
      stdio: [ 'ignore', 'pipe', 'pipe' ],
      // Hermetic lanes inherit exactly the ambient env; stagehand AND
      // playwright additionally receive the parsed dev file (per spawn, parent
      // untouched). Playwright loads repo fixture plugins whose signatures
      // verify against KIKX_PLUGIN_SIGNATURE_MODE from .env.dev — without it
      // every fixture plugin is refused (no-configured-key) and plugin specs
      // hang waiting for descriptors that never arrive (measured 2026-11-14).
      ...(lane.hermetic === false || lane.name === 'ui:playwright'
        ? { env: { ...process.env, ...readDevEnv(process.env.KIKX_ENV_FILE || '.env.dev') } }
        : {}),
    });

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
    : `not selected — needs live services (Chrome + the Ollama relay; lanes are keyless since 2026-11-14); run: node scripts/run-test-lanes.mjs ${lane.name}`;
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
