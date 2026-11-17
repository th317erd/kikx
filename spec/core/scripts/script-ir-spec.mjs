'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateScriptIR } from '../../../src/core/scripts/script-ir.mjs';

// P5(a) start gate: deterministic structural validation of compiled IR
// (plan §12.2(5), §7 P5). The model compiles; this proves shape — never
// semantics — and rejects before script-set stores anything.

const V6_SHAPE = {
  version: 1,
  events: {
    endTurn: { say: 'Agentic Script execution is not complete — ask with question-create, then continue.' },
  },
  phases: [
    {
      id: '1_set_vision',
      branch: [
        { when: 'Vision is detailed enough', then: [ { goto: '2_plan_mission' } ] },
        { when: 'Vision is empty or thin', then: [ { say: 'Fold in user thoughts.' }, { goto: '2_plan_mission' } ] },
      ],
    },
    {
      id: '2_plan_mission',
      branch: [
        { when: 'mission and plan todos seeded', then: [ { goto: '1_set_vision' } ] },
      ],
    },
  ],
};

function cloneIR() {
  return JSON.parse(JSON.stringify(V6_SHAPE));
}

test('accepts a well-formed coordinator_v6-shaped IR', () => {
  const result = validateScriptIR(cloneIR());
  assert.equal(result.ok, true, `expected ok, got errors: ${JSON.stringify(result.errors)}`);
  assert.deepEqual(result.labels.sort(), [ '1_set_vision', '2_plan_mission' ]);
});

test('rejects a goto to an unknown phase label', () => {
  const ir = cloneIR();
  ir.phases[0].branch[0].then = [ { goto: '9_does_not_exist' } ];
  const result = validateScriptIR(ir);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => /unknown label/i.test(e) && /9_does_not_exist/.test(e)),
    `errors: ${JSON.stringify(result.errors)}`,
  );
});

test('rejects an empty directive list in a branch arm', () => {
  const ir = cloneIR();
  ir.phases[1].branch[0].then = [];
  const result = validateScriptIR(ir);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /empty/i.test(e)), `errors: ${JSON.stringify(result.errors)}`);
});

test('rejects a phase with no branch and no handlers', () => {
  const ir = cloneIR();
  ir.phases[1].branch = [];
  const result = validateScriptIR(ir);
  assert.equal(result.ok, false);
});

test('rejects IR whose serialized size exceeds the script cap', () => {
  const ir = cloneIR();
  ir.phases[0].branch[1].then.unshift({ say: 'x'.repeat(20 * 1024) });
  const result = validateScriptIR(ir);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /size|cap/i.test(e)), `errors: ${JSON.stringify(result.errors)}`);
});

test('rejects non-object IR and unknown versions', () => {
  assert.equal(validateScriptIR(null).ok, false);
  assert.equal(validateScriptIR({ ...cloneIR(), version: 99 }).ok, false);
});
