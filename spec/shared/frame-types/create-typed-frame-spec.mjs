'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTypedFrame }       from '../../../src/shared/frame-types/create-typed-frame.mjs';
import { FrameTypeUserMessage }   from '../../../src/shared/frame-types/frame-type-user-message.mjs';
import { FrameTypeMessage }       from '../../../src/shared/frame-types/frame-type-message.mjs';
import { FrameTypeToolCall }      from '../../../src/shared/frame-types/frame-type-tool-call.mjs';
import { FrameTypeDefault }       from '../../../src/shared/frame-types/frame-type-default.mjs';
import { FrameTypeBase }          from '../../../src/shared/frame-types/frame-type-base.mjs';

// =============================================================================
// createTypedFrame Factory Tests
// =============================================================================

describe('createTypedFrame', () => {

  // ---------------------------------------------------------------------------
  // Basic type resolution
  // ---------------------------------------------------------------------------

  it('should return FrameTypeUserMessage for type UserMessage', () => {
    let typed = createTypedFrame({ id: 'f1', type: 'UserMessage', content: { text: 'hi' } });
    assert.ok(typed instanceof FrameTypeUserMessage);
    assert.equal(typed.id, 'f1');
  });

  it('should return FrameTypeMessage for type Message', () => {
    let typed = createTypedFrame({ id: 'f2', type: 'Message', content: { text: 'hello' } });
    assert.ok(typed instanceof FrameTypeMessage);
  });

  it('should return FrameTypeToolCall for type ToolCall', () => {
    let typed = createTypedFrame({ id: 'f3', type: 'ToolCall', content: { toolName: 'test' } });
    assert.ok(typed instanceof FrameTypeToolCall);
  });

  it('should return FrameTypeDefault for unknown type', () => {
    let typed = createTypedFrame({ id: 'f4', type: 'UnknownFutureType', content: {} });
    assert.ok(typed instanceof FrameTypeDefault);
  });

  it('should return FrameTypeDefault for null frameData', () => {
    let typed = createTypedFrame(null);
    assert.ok(typed instanceof FrameTypeDefault);
  });

  it('should return FrameTypeDefault for missing type', () => {
    let typed = createTypedFrame({ id: 'f5', content: {} });
    assert.ok(typed instanceof FrameTypeDefault);
  });

  it('should return FrameTypeDefault for undefined frameData', () => {
    let typed = createTypedFrame(undefined);
    assert.ok(typed instanceof FrameTypeDefault);
  });

  // ---------------------------------------------------------------------------
  // All 19 types resolve
  // ---------------------------------------------------------------------------

  let typeNames = [
    'UserMessage', 'Message', 'ToolCall', 'ToolResult', 'ToolError',
    'ToolActivity', 'PermissionRequest', 'PermissionDenied', 'CommandResult',
    'SessionLink', 'HookBlocked', 'PendingAction', 'SystemError',
    'ParticipantJoined', 'ParticipantLeft', 'Error', 'Reflection',
    'Compaction', 'Stop',
  ];

  for (let typeName of typeNames) {
    it(`should resolve type ${typeName} to a non-default class`, () => {
      let typed = createTypedFrame({ id: 'f', type: typeName, content: {} });
      assert.ok(!(typed instanceof FrameTypeDefault), `${typeName} should not be FrameTypeDefault`);
      assert.ok(typed instanceof FrameTypeBase);
      assert.equal(typed.type, typeName);
    });
  }

  // ---------------------------------------------------------------------------
  // Registry override
  // ---------------------------------------------------------------------------

  it('should use registry class when available', () => {
    class CustomUserMessage extends FrameTypeBase {
      get custom() { return true; }
    }

    let registry = {
      hasClass: (key) => key === 'FrameTypeUserMessage',
      getClass: (key) => key === 'FrameTypeUserMessage' ? CustomUserMessage : null,
    };

    let typed = createTypedFrame(
      { id: 'f', type: 'UserMessage', content: {} },
      { registry },
    );

    assert.ok(typed instanceof CustomUserMessage);
    assert.equal(typed.custom, true);
  });

  it('should fall back to static map when registry does not have the class', () => {
    let registry = {
      hasClass: () => false,
      getClass: () => null,
    };

    let typed = createTypedFrame(
      { id: 'f', type: 'Message', content: {} },
      { registry },
    );

    assert.ok(typed instanceof FrameTypeMessage);
  });

  it('should work without registry in context', () => {
    let typed = createTypedFrame({ id: 'f', type: 'ToolCall', content: {} }, {});
    assert.ok(typed instanceof FrameTypeToolCall);
  });

  it('should work with null context', () => {
    let typed = createTypedFrame({ id: 'f', type: 'ToolCall', content: {} }, null);
    assert.ok(typed instanceof FrameTypeToolCall);
  });

  // ---------------------------------------------------------------------------
  // Context passed through
  // ---------------------------------------------------------------------------

  it('should pass context to the created instance', () => {
    let ctx   = { registry: null, someData: 42 };
    let typed = createTypedFrame({ id: 'f', type: 'UserMessage', content: {} }, ctx);
    assert.equal(typed._context, ctx);
  });
});
