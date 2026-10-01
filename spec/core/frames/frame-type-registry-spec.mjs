'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { ClassRegistry } from '../../../src/core/plugins/class-registry.mjs';
import { registerFrameTypeClasses } from '../../../src/core/plugins/core-classes.mjs';
import {
  FrameTypeUserMessage,
  createTypedFrame,
  frameTypeClass,
} from '../../../src/core/frames/frame-types/index.mjs';
import { frameToModelTurn } from '../../../src/core/plugins/agent-model-context.mjs';

class OverrideUserMessage extends FrameTypeUserMessage {
  buildAgentTurn(text) {
    return { role: 'user', content: `OVERRIDE:${text}` };
  }
}

test('a plugin can override a frame type class through the registry', () => {
  let registry = new ClassRegistry();
  registerFrameTypeClasses(registry);
  registry.registerClass('FrameTypeUserMessage', OverrideUserMessage, { pluginName: 'test-plugin' });

  assert.equal(frameTypeClass('UserMessage', registry), OverrideUserMessage);

  let typed = createTypedFrame(
    { id: 'f1', type: 'UserMessage', content: { text: 'hi' } },
    { registry },
  );
  assert.ok(typed instanceof OverrideUserMessage);
  assert.deepEqual(typed.toAgentMessage(), { role: 'user', content: 'OVERRIDE:hi' });
});

test('unregistering the plugin restores the core frame type class', () => {
  let registry = new ClassRegistry();
  registerFrameTypeClasses(registry);
  registry.registerClass('FrameTypeUserMessage', OverrideUserMessage, { pluginName: 'test-plugin' });

  registry.unregisterPlugin('test-plugin');
  assert.equal(frameTypeClass('UserMessage', registry), FrameTypeUserMessage);
  assert.deepEqual(
    createTypedFrame({ type: 'UserMessage', content: { text: 'hi' } }, { registry }).toAgentMessage(),
    { role: 'user', content: 'hi' },
  );
});

test('a plugin can add a brand-new frame type and the factory resolves it', () => {
  let registry = new ClassRegistry();
  registerFrameTypeClasses(registry);

  class FrameTypeCustomNotice extends FrameTypeUserMessage {
    buildAgentTurn(text) {
      return { role: 'user', content: `[notice] ${text}` };
    }
  }

  registry.registerClass('FrameTypeCustomNotice', FrameTypeCustomNotice, { pluginName: 'test-plugin' });
  assert.equal(frameTypeClass('CustomNotice', registry), FrameTypeCustomNotice);

  let typed = createTypedFrame({ type: 'CustomNotice', content: { text: 'n' } }, { registry });
  assert.deepEqual(typed.toAgentMessage(), { role: 'user', content: '[notice] n' });
});

test('frameToModelTurn delegates to an overridden frame type via options.registry', () => {
  let registry = new ClassRegistry();
  registerFrameTypeClasses(registry);
  registry.registerClass('FrameTypeUserMessage', OverrideUserMessage, { pluginName: 'test-plugin' });

  let overridden = frameToModelTurn(
    { id: 'f1', type: 'UserMessage', content: { text: 'hi' } },
    { registry },
  );
  assert.deepEqual(overridden, { role: 'user', content: 'OVERRIDE:hi' });

  // Without the registry, core behavior is preserved exactly.
  let core = frameToModelTurn({ id: 'f1', type: 'UserMessage', content: { text: 'hi' } });
  assert.deepEqual(core, { role: 'user', content: 'hi' });
});

test('frameTypeClass falls back to core and default when unregistered', () => {
  let registry = new ClassRegistry();
  assert.equal(frameTypeClass('UserMessage', registry), FrameTypeUserMessage);
  assert.equal(frameTypeClass('TotallyUnknown', registry).name, 'FrameTypeDefault');
  assert.equal(frameTypeClass('UserMessage').name, 'FrameTypeUserMessage');
});
