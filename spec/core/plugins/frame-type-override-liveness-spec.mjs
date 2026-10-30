'use strict';

// P1 follow-up exit proof: a frame-type override reaches production.
//
// The campaign doc recorded this as an INERT override: `createTypedFrame()` only
// consults the registry when its caller passes one, and every production provider
// calls `this.constructor.buildModelMessages(params)` with no options, so
// `options.registry` was structurally always undefined and the static
// FRAME_TYPE_CLASSES map always won. A plugin could register a frame-type
// override, see it in the inventory, and change no message.
//
// These tests pin the two halves that together make the override live:
//
//   1. buildModelMessages() resolves the plugin registry from the services object
//      core hands every provider, so a provider that passes no options still gets
//      the override applied.
//   2. because it is now genuinely resolved, the FrameType<Type> keys are reported
//      as consumed instead of inert. Reporting them inert would be a false
//      "did not apply" after the fix.
//
// Every assertion here is about the message text the model would receive, not
// about a registry row. That distinction is the whole point: the defect was never
// that the registry forgot the override, it was that the override changed nothing.

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildModelMessages } from '../../../src/core/plugins/agent-model-context.mjs';
import {
  CONSUMED_CLASS_KEYS,
  registerCoreClasses,
} from '../../../src/core/plugins/core-classes.mjs';
import { PluginRegistry } from '../../../src/core/plugins/plugin-registry.mjs';
import { FrameTypeUserMessage } from '../../../src/core/frames/frame-types/frame-type-user-message.mjs';

const MARKER = '[overridden-by-plugin]';

class OverrideUserMessage extends FrameTypeUserMessage {
  buildAgentTurn(_text) {
    // Deliberately not calling super: the assertion is that THIS class produced the
    // turn, so the content must be recognisably not the base rendering.
    return { role: 'user', content: MARKER };
  }
}

function historyFrame() {
  return {
    id: 'frame-history',
    type: 'UserMessage',
    authorType: 'user',
    authorID: 'user-1',
    content: { text: 'the original user text' },
  };
}

// A production-shaped params object: the provider received these from core. Note
// `services` is present -- both providers read `params.services` for other
// settings -- which is what the fallback resolves against.
function providerParams(services) {
  return {
    frames: [ historyFrame() ],
    frame: null,
    agent: { id: 'agent-1' },
    services,
  };
}

function registryWithPluginOverride() {
  let registry = new PluginRegistry({ logger: { warn() {} } });
  registerCoreClasses(registry);
  registry.beginPluginLoad('override-plugin');
  registry.registerClass('FrameTypeUserMessage', OverrideUserMessage);
  registry.endPluginLoad();
  return registry;
}

test('an override applies when a provider passes no options but services carry the registry', () => {
  let registry = registryWithPluginOverride();

  // Exactly the production call shape: one argument, no options. `services.context`
  // is how core hands providers the container (create-server passes `{ context }`).
  let messages = buildModelMessages(providerParams({
    context: { has: (name) => name === 'pluginRegistry', require: () => registry },
  }));

  let userTurns = messages.filter((message) => message.role === 'user');
  assert.ok(userTurns.length > 0, 'the history frame must still produce a user turn');
  assert.equal(userTurns[ 0 ].content, MARKER,
    'the plugin frame-type override must produce the turn, not the static core map');
});

test('a registry reachable directly on services also applies', () => {
  let registry = registryWithPluginOverride();
  let messages = buildModelMessages(providerParams({ pluginRegistry: registry }));
  let userTurns = messages.filter((message) => message.role === 'user');
  assert.equal(userTurns[ 0 ].content, MARKER);
});

test('with no registry anywhere, core rendering is preserved exactly', () => {
  // The fallback must never change behaviour for a boot without a registry, and it
  // must never throw when `services` is absent or empty.
  for (let services of [ undefined, {}, { context: {} } ]) {
    let messages = buildModelMessages(providerParams(services));
    let userTurns = messages.filter((message) => message.role === 'user');
    assert.ok(userTurns.length > 0);
    assert.equal(userTurns[ 0 ].content, 'the original user text',
      'without a registry the static core rendering is unchanged');
  }
});

test('an explicit options.registry still wins over the services fallback', () => {
  let registry = registryWithPluginOverride();

  class ExplicitOverride extends FrameTypeUserMessage {
    buildAgentTurn() {
      return { role: 'user', content: '[explicit]' };
    }
  }

  let explicit = new PluginRegistry({ logger: { warn() {} } });
  registerCoreClasses(explicit);
  explicit.beginPluginLoad('explicit-plugin');
  explicit.registerClass('FrameTypeUserMessage', ExplicitOverride);
  explicit.endPluginLoad();

  let messages = buildModelMessages(
    providerParams({ pluginRegistry: registry }),
    { registry: explicit },
  );

  assert.equal(messages.filter((message) => message.role === 'user')[ 0 ].content, '[explicit]',
    'the caller-supplied registry is not silently replaced by the fallback');
});

test('after the fix the frame-type keys are consumed, so the override is not reported inert', () => {
  let registry = registryWithPluginOverride();

  // If these keys were still classified inert, an operator would be told the
  // override changed nothing -- untrue after the fallback above.
  assert.equal(registry.isKeyConsumed('FrameTypeUserMessage'), true);
  assert.equal(registry.isKeyConsumed('FrameTypeDefault'), true);
  assert.deepEqual(registry.listInertOverrides(), []);
  assert.ok(CONSUMED_CLASS_KEYS.includes('FrameTypeUserMessage'));
});
