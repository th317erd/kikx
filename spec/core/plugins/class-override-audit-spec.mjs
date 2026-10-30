'use strict';

// P1 exit proof: the class-override audit is complete and its limits are stated by
// the platform, not left for an operator to infer.
//
// Two different failures were conflated before this contract:
//
//   1. An override on a key that a construction site resolves, but after the live
//      instance already exists. A restart fixes it. Reported by listRestartRequired().
//   2. An override on a key that NO construction site resolves at all. A restart does
//      not fix it, because there is nothing to pick it up. Reported by
//      listInertOverrides() -- previously not reported at all, so the inventory row
//      looked like a live behaviour change.
//
// Registration alone is therefore not a promise. These tests pin the difference.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ClassRegistry } from '../../../src/core/plugins/class-registry.mjs';
import { PluginRegistry } from '../../../src/core/plugins/plugin-registry.mjs';
import {
  CONSUMED_CLASS_KEYS,
  registerCoreClasses,
  resolveCoreClass,
} from '../../../src/core/plugins/core-classes.mjs';

test('the consumed-key list names only keys with a real construction site', () => {
  // The four core keys each resolved through resolveCoreClass() in create-server.mjs.
  // If a fifth core key is added here without a construction site, the inert
  // machinery below stops reporting a genuine defect and this list becomes a lie.
  //
  // The FrameType<Type> keys are consumed as of the buildModelMessages() registry
  // fallback: that function now resolves the plugin registry from the services
  // object core hands every provider, so a frame-type override does apply. They must
  // therefore NOT appear in listInertOverrides() any more. The proof that the
  // resolution site is real, rather than this list asserting itself, lives in
  // spec/core/plugins/frame-type-override-liveness-spec.mjs.
  assert.deepEqual(
    [ ...CONSUMED_CLASS_KEYS ].filter((key) => !key.startsWith('FrameType')).sort(),
    [ 'CommandRegistry', 'CompactionService', 'FrameRouter', 'FrameRuntime' ],
  );

  let frameTypeKeys = [ ...CONSUMED_CLASS_KEYS ].filter((key) => key.startsWith('FrameType'));
  assert.ok(frameTypeKeys.length > 0,
    'frame-type keys are consumed by name, not dropped from the classification');
  assert.ok(frameTypeKeys.includes('FrameTypeUserMessage'));
  assert.ok(frameTypeKeys.includes('FrameTypeDefault'),
    'the fallback key is consumed too, or an unknown-frame override would report inert');
});

test('boot declares the consumed keys, so inert reporting is enabled by default', () => {
  let registry = new PluginRegistry({ logger: { warn() {} } });
  assert.equal(registry.hasConsumedKeys(), false,
    'a bare registry must not claim to know what is consumed');

  registerCoreClasses(registry);

  assert.equal(registry.hasConsumedKeys(), true,
    'the shared bootstrap path is what makes the classification authoritative');
  assert.equal(registry.isKeyConsumed('FrameRouter'), true);
  assert.equal(registry.isKeyConsumed('AgentInterface'), false);
});

test('an override on a key nothing resolves is inert, not restart-required', () => {
  let registry = new PluginRegistry({ logger: { warn() {} } });
  registerCoreClasses(registry);

  let Core = registry.getClass('AgentInterface');

  class PluginAgentInterface extends Core {}
  registry.beginPluginLoad('inert-plugin');
  registry.registerClass('AgentInterface', PluginAgentInterface);
  registry.endPluginLoad();

  // The registry row now says the plugin's class. Nothing would ever construct it:
  // every consumer imports AgentInterface and `extends` it.
  assert.equal(registry.getClass('AgentInterface'), PluginAgentInterface);

  assert.deepEqual(registry.listInertOverrides(), [ 'AgentInterface' ],
    'an override with no consumer must be reported as having no effect');
  assert.deepEqual(registry.listRestartRequired(), [],
    'a restart cannot make it take effect, so it must not be reported as restart-required');
});

test('a consumed key is never reported inert, even when an override is pending', () => {
  let registry = new PluginRegistry({ logger: { warn() {} } });
  registerCoreClasses(registry);

  // Resolve first so a live instance exists, then override: this is the restart case.
  let Core = resolveCoreClass(registry, 'CommandRegistry', registry.getClass('CommandRegistry'));

  class PluginCommandRegistry extends Core {}
  registry.beginPluginLoad('pending-plugin');
  registry.registerClass('CommandRegistry', PluginCommandRegistry);
  registry.endPluginLoad();

  assert.deepEqual(registry.listRestartRequired(), [ 'CommandRegistry' ],
    'a resolved key with a newer override is stale and restart-required');
  assert.deepEqual(registry.listInertOverrides(), [],
    'a consumed key must never be described as inert -- a restart does fix it');
});

test('an unresolved consumed key override is restart-required, not inert', () => {
  // The honest middle case: the key has a construction site, but on this boot nothing
  // has resolved it yet. A restart WILL pick the override up, so the correct report is
  // restart-required (because a later resolution is the only way to apply it), never
  // inert.
  let registry = new PluginRegistry({ logger: { warn() {} } });
  registerCoreClasses(registry);

  class PluginFrameRuntime extends registry.getClass('FrameRuntime') {}
  registry.beginPluginLoad('late-plugin');
  registry.registerClass('FrameRuntime', PluginFrameRuntime);
  registry.endPluginLoad();

  assert.deepEqual(registry.listInertOverrides(), [],
    'a consumed key must not be reported inert merely because it has not been resolved yet');
});

test('a plugin override is dropped from both reports after unload', () => {
  let registry = new PluginRegistry({ logger: { warn() {} } });
  registerCoreClasses(registry);

  class PluginAgentInterface extends registry.getClass('AgentInterface') {}
  registry.beginPluginLoad('removed-plugin');
  registry.registerClass('AgentInterface', PluginAgentInterface);
  registry.endPluginLoad();
  assert.deepEqual(registry.listInertOverrides(), [ 'AgentInterface' ]);

  registry.unregisterPlugin('removed-plugin');

  assert.deepEqual(registry.listInertOverrides(), [],
    'unloading the plugin must clear the inert report, not leave a stale key behind');
});

test('core registrations alone are never reported inert', () => {
  // Every registered key starts on a core entry. Those are not overrides; if they were
  // reported the operator would see permanent noise for keys no plugin touched.
  let registry = new PluginRegistry({ logger: { warn() {} } });
  registerCoreClasses(registry);

  assert.deepEqual(registry.listInertOverrides(), []);
});

test('a bare ClassRegistry without declared consumption reports no inert keys', () => {
  // Consumption is unknown here, and an unknown must never render as a finding.
  let registry = new ClassRegistry();
  registry.registerClass('SomeKey', class SomeKey {}, { pluginName: 'core' });
  registry.registerClass('SomeKey', class OtherKey {}, { pluginName: 'plugin-x' });

  assert.equal(registry.hasConsumedKeys(), false);
  assert.equal(registry.isKeyConsumed('SomeKey'), null,
    'unknown consumption is null, distinct from false');
  assert.deepEqual(registry.listInertOverrides(), [],
    'a registry that was never told what is consumed must not guess');
});

test('setConsumedKeys accepts a Set or an array and can be cleared', () => {
  let registry = new ClassRegistry();

  registry.setConsumedKeys([ 'A', 'B' ]);
  assert.equal(registry.isKeyConsumed('A'), true);
  assert.equal(registry.isKeyConsumed('C'), false);

  registry.setConsumedKeys(new Set([ 'C' ]));
  assert.equal(registry.isKeyConsumed('A'), false);
  assert.equal(registry.isKeyConsumed('C'), true);

  registry.setConsumedKeys(null);
  assert.equal(registry.isKeyConsumed('C'), null);
});
