'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getBehaviorScript,
  isBehaviorScriptID,
  listBehaviorScripts,
} from '../../../src/core/scripts/script-registry.mjs';
import { AGIS_EXECUTOR_PREAMBLE } from '../../../src/core/scripts/executor-preamble.mjs';
import {
  MAX_BEHAVIOR_SCRIPT_LENGTH,
  normalizeBehaviorScript,
} from '../../../src/core/agents/script-limits.mjs';

const FIXED_TERMINATOR = '>>>Check next todo list item; if none, end turn.<<<';

test('registry serves the coordinator-loop template', () => {
  let template = getBehaviorScript('coordinator-loop');
  assert.ok(template, 'coordinator-loop must be registered');
  assert.equal(template.id, 'coordinator-loop');
  assert.equal(template.name, 'Coordinator loop');
  assert.ok(template.script.includes('SCRIPT coordinator_loop'));
  assert.ok(isBehaviorScriptID('coordinator-loop'));
});

test('unknown template IDs resolve to null', () => {
  assert.equal(getBehaviorScript('nope'), null);
  assert.equal(getBehaviorScript(undefined), null);
  assert.equal(isBehaviorScriptID('nope'), false);
});

test('registry ships the four library templates', () => {
  let ids = listBehaviorScripts().map((entry) => entry.id).sort();
  assert.deepEqual(ids, [ 'coordinator-loop', 'design', 'engineer', 'qa' ]);
  for (let id of ids) {
    let template = getBehaviorScript(id);
    assert.ok(template.script.includes(`SCRIPT ${id === 'coordinator-loop' ? 'coordinator_loop' : id === 'design' ? 'design_loop' : id === 'engineer' ? 'engineer_loop' : 'qa_loop'}`));
  }
});

test('listBehaviorScripts returns id/name/description entries', () => {
  let list = listBehaviorScripts();
  assert.ok(list.length >= 1);
  for (let entry of list) {
    assert.equal(typeof entry.id, 'string');
    assert.equal(typeof entry.name, 'string');
    assert.equal(typeof entry.description, 'string');
    assert.equal('script' in entry, false, 'list must not inline full scripts');
  }
});

test('every registered script ends with the fixed terminator before END', () => {
  for (let entry of listBehaviorScripts()) {
    let template = getBehaviorScript(entry.id);
    let lines = template.script
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    assert.equal(lines[lines.length - 1], 'END', `${entry.id} must end with END`);
    assert.equal(
      lines[lines.length - 2],
      FIXED_TERMINATOR,
      `${entry.id} must carry the fixed terminator as its last instruction`,
    );
  }
});

test('coordinator-loop is a continuous loop with named exits', () => {
  let { script } = getBehaviorScript('coordinator-loop');
  assert.ok(script.includes('loop until'));
  assert.ok(script.includes('continue-turn'));
  assert.ok(script.includes('delayMs'));
  assert.ok(script.includes('surface the question in your progress update'));
  assert.ok(script.includes('never anything upstream'));
});

test('executor preamble teaches the language and the script rules', () => {
  assert.ok(AGIS_EXECUTOR_PREAMBLE.includes('AGIS EXECUTOR PREAMBLE'));
  assert.ok(AGIS_EXECUTOR_PREAMBLE.includes('loop until'));
  assert.ok(AGIS_EXECUTOR_PREAMBLE.includes('checkpoint'));
  assert.ok(AGIS_EXECUTOR_PREAMBLE.includes(FIXED_TERMINATOR));
  assert.ok(AGIS_EXECUTOR_PREAMBLE.includes('Mutation authority'));
  assert.ok(AGIS_EXECUTOR_PREAMBLE.includes('identity wins'));
});

test('normalizeBehaviorScript accepts text, clears on null, enforces the cap', () => {
  assert.equal(normalizeBehaviorScript(null), '');
  assert.equal(normalizeBehaviorScript(undefined), '');
  assert.equal(normalizeBehaviorScript('SCRIPT x\nEND'), 'SCRIPT x\nEND');
  assert.equal(normalizeBehaviorScript('x'.repeat(MAX_BEHAVIOR_SCRIPT_LENGTH)).length, MAX_BEHAVIOR_SCRIPT_LENGTH);
  assert.throws(() => normalizeBehaviorScript(42), /must be a string/);
  assert.throws(
    () => normalizeBehaviorScript('x'.repeat(MAX_BEHAVIOR_SCRIPT_LENGTH + 1)),
    new RegExp(`${MAX_BEHAVIOR_SCRIPT_LENGTH} characters or fewer`),
  );
});
