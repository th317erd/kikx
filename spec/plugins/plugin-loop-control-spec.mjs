'use strict';

// =============================================================================
// Loop-control extension contract (P5)
// =============================================================================
// The campaign (docs/plans/plugin-platform-campaign.md 4.6) requires named, bounded
// loop-control contributions with a fixed terminal-state vocabulary, and states the
// hard requirement directly: "The core loop remains finite and auditable. A plugin
// cannot create an unbounded hidden wake path."
//
// These tests pin that requirement from three directions:
//   1. registration refuses anything outside the fixed vocabulary;
//   2. a registered control is owned by its plugin, so unload removes it;
//   3. dispatch applies only a fixed terminal, and an unrecognised control stops the
//      loop instead of being ignored.
//
// (3) is the defect this contract was written to catch: before the change, an
// unrecognised LoopControl fell through `handleLoopControl` returning false and the
// loop continued with finalized/break untouched, so a plugin could keep a turn alive
// by returning an action nothing understood.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { PluginRegistry } from '../../src/core/plugins/plugin-registry.mjs';
import { AgentInterface } from '../../src/core/plugins/agent-interface.mjs';
import {
  CORE_LOOP_CONTROL_ACTIONS,
  LOOP_CONTROL_TERMINALS,
  createLoopState,
  handleLoopControl,
} from '../../src/core/plugins/agent-loop-state.mjs';

function makeRegistry() {
  return new PluginRegistry({ logger: { warn() {}, info() {}, error() {} } });
}

test('the terminal vocabulary is closed and contains no unbounded outcome', () => {
  assert.deepEqual([ ...LOOP_CONTROL_TERMINALS ].sort(), [
    'break',
    'finalize',
    'null-response',
    'respond',
    'route',
  ]);

  // The point of the closed set: nothing here can re-enter the loop without a bound.
  for (let forbidden of [ 'continue', 'loop', 'wake', 'defer', 'retry-forever', 'next' ])
    assert.equal(LOOP_CONTROL_TERMINALS.has(forbidden), false, `"${forbidden}" must not be a terminal`);
});

test('registerLoopControl accepts an action that declares a known terminal', () => {
  let registry = makeRegistry();
  let entry = registry.registerLoopControl('handoff-note', {
    terminal: 'finalize',
    description: 'End the turn after recording a handoff note.',
  });

  assert.equal(entry.action, 'handoff-note');
  assert.equal(entry.terminal, 'finalize');
  assert.equal(registry.getLoopControlTerminal('handoff-note'), 'finalize');
  assert.deepEqual(registry.listLoopControls().map((control) => control.action), [ 'handoff-note' ]);
});

test('registerLoopControl refuses an unknown or missing terminal', () => {
  let registry = makeRegistry();

  assert.throws(
    () => registry.registerLoopControl('sneaky', { terminal: 'continue-forever' }),
    /unknown terminal "continue-forever"/,
  );

  // A missing terminal is refused by the required-string guard before the vocabulary
  // check ever runs; both are refusals, and the message names the offending control.
  assert.throws(
    () => registry.registerLoopControl('vague', {}),
    /loop control "vague" terminal must be a non-empty string/,
  );

  // Nothing was registered by the refusals.
  assert.deepEqual(registry.listLoopControls(), []);
});

test('registerLoopControl refuses names owned by the core loop', () => {
  let registry = makeRegistry();

  for (let coreAction of CORE_LOOP_CONTROL_ACTIONS) {
    assert.throws(
      () => registry.registerLoopControl(coreAction, { terminal: 'finalize' }),
      /collides with a core loop-control action/,
      `"${coreAction}" must not be replaceable by a plugin`,
    );
  }
});

test('the respond terminal must be requested explicitly', () => {
  let registry = makeRegistry();

  assert.throws(
    () => registry.registerLoopControl('keep-going', { terminal: 'respond' }),
    /must set allowsContinuation: true/,
  );

  let entry = registry.registerLoopControl('keep-going', { terminal: 'respond', allowsContinuation: true });
  assert.equal(entry.allowsContinuation, true);
  assert.equal(entry.terminal, 'respond');
});

test('a registered loop control is plugin-owned and unload removes it', async () => {
  let registry = makeRegistry();

  registry.registerLoopControl('handoff-note', { terminal: 'finalize' }, { pluginName: 'notes-plugin' });
  assert.equal(registry.getLoopControlTerminal('handoff-note'), 'finalize');

  let owned = registry.listOwnedRegistrations('notes-plugin');
  assert.equal(owned.some((entry) => entry.kind === 'loop-control' && entry.key === 'handoff-note'), true,
    'the ledger must record the loop-control registration');

  // releasePlugin() is the unload path that replays the ownership ledger;
  // unregisterPlugin() only pops class stacks and would leave this entry behind.
  await registry.releasePlugin('notes-plugin');
  assert.equal(registry.getLoopControlTerminal('handoff-note'), null);
});

test('dispatch applies a plugin terminal through the resolver', () => {
  let registry = makeRegistry();
  registry.registerLoopControl('handoff-note', { terminal: 'finalize' }, { pluginName: 'notes-plugin' });

  let state = createLoopState();
  let handled = handleLoopControl(
    { type: 'LoopControl', action: 'handoff-note', content: { text: 'handed off' } },
    state,
    { resolveTerminal: (action) => registry.getLoopControlTerminal(action) },
  );

  assert.equal(handled, true);
  assert.equal(state.finalized, true);
  assert.equal(state.continuation, null);
  assert.equal(state.finalFrame.type, 'AgentMessage');
});

test('an unregistered action is not handled, so the caller can stop the loop', () => {
  let registry = makeRegistry();

  let state = createLoopState();
  let handled = handleLoopControl(
    { type: 'LoopControl', action: 'not-registered' },
    state,
    { resolveTerminal: (action) => registry.getLoopControlTerminal(action) },
  );

  assert.equal(handled, false);
  // The contract point: nothing was applied, so the caller must not treat this as
  // permission to continue. agent-interface.mjs sets state.break in this case.
  assert.equal(state.finalized, false);
  assert.equal(state.break, false);
});

test('the loop hard-stops on an unrecognised control instead of continuing', async () => {
  // This is the defect the contract exists for. executeAskStep feeds every provider output
  // through handleLoopControl; when that returns false the old code fell through and the
  // loop continued with finalized/break untouched, so a plugin returning an action nothing
  // understood could keep the turn alive. Drive the real loop driver, not a stub.
  let registry = makeRegistry();
  registry.registerLoopControl('handoff-note', { terminal: 'finalize' }, { pluginName: 'notes-plugin' });

  class TestAgent extends AgentInterface {
    static id = 'test-agent';
    async *ask() {
      yield { type: 'LoopControl', action: 'totally-unknown-action' };
    }
  }

  let agent = new TestAgent({ id: 'test-agent' });
  let state = createLoopState();
  let yielded = [];

  for await (let output of agent.executeAskStep({ type: 'ask' }, { pluginRegistry: registry, agent: { id: 'test-agent' } }, state))
    yielded.push(output);

  assert.equal(state.break, true, 'an unrecognised LoopControl must stop the loop');
  assert.equal(state.finalized, false, 'it must not be treated as a successful turn end');
});

// A registered control reaching the same driver applies its declared terminal.
test('the loop applies a plugin terminal end-to-end', async () => {
  let registry = makeRegistry();
  registry.registerLoopControl('handoff-note', { terminal: 'finalize' }, { pluginName: 'notes-plugin' });

  class TestAgent extends AgentInterface {
    static id = 'test-agent';
    async *ask() {
      yield { type: 'LoopControl', action: 'handoff-note', content: { text: 'handed off' } };
    }
  }

  let agent = new TestAgent({ id: 'test-agent' });
  let state = createLoopState();

  for await (let _output of agent.executeAskStep({ type: 'ask' }, { pluginRegistry: registry, agent: { id: 'test-agent' } }, state))
    ;

  assert.equal(state.finalized, true);
  assert.equal(state.break, false);
});
test('the core controls still work without a resolver', () => {
  let state = createLoopState();
  assert.equal(handleLoopControl({ type: 'LoopControl', action: 'break' }, state), true);
  assert.equal(state.break, true);
});
