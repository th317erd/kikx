'use strict';

import { describe, it }   from 'node:test';
import assert              from 'node:assert/strict';

import {
  FrameTypeBase,
  FrameTypeDefault,
  FrameTypeUserMessage,
  FrameTypeMessage,
  FrameTypeToolCall,
  FrameTypeToolResult,
  FrameTypeToolError,
  FrameTypeToolActivity,
  FrameTypePermissionRequest,
  FrameTypePermissionDenied,
  FrameTypeCommandResult,
  FrameTypeSessionLink,
  FrameTypeHookBlocked,
  FrameTypePendingAction,
  FrameTypeSystemError,
  FrameTypeParticipantJoined,
  FrameTypeParticipantLeft,
  FrameTypeError,
  FrameTypeReflection,
  FrameTypeCompaction,
  FrameTypeStop,
  FRAME_TYPE_CLASSES,
} from '../../../src/shared/frame-types/index.mjs';

// =============================================================================
// FRAME_TYPE_CLASSES map
// =============================================================================

describe('FRAME_TYPE_CLASSES', () => {
  it('should contain all 19 frame type classes', () => {
    assert.equal(Object.keys(FRAME_TYPE_CLASSES).length, 19);
  });

  it('should map type strings to correct classes', () => {
    assert.equal(FRAME_TYPE_CLASSES.UserMessage, FrameTypeUserMessage);
    assert.equal(FRAME_TYPE_CLASSES.Message, FrameTypeMessage);
    assert.equal(FRAME_TYPE_CLASSES.ToolCall, FrameTypeToolCall);
    assert.equal(FRAME_TYPE_CLASSES.ToolResult, FrameTypeToolResult);
    assert.equal(FRAME_TYPE_CLASSES.ToolError, FrameTypeToolError);
    assert.equal(FRAME_TYPE_CLASSES.ToolActivity, FrameTypeToolActivity);
    assert.equal(FRAME_TYPE_CLASSES.PermissionRequest, FrameTypePermissionRequest);
    assert.equal(FRAME_TYPE_CLASSES.PermissionDenied, FrameTypePermissionDenied);
    assert.equal(FRAME_TYPE_CLASSES.CommandResult, FrameTypeCommandResult);
    assert.equal(FRAME_TYPE_CLASSES.SessionLink, FrameTypeSessionLink);
    assert.equal(FRAME_TYPE_CLASSES.HookBlocked, FrameTypeHookBlocked);
    assert.equal(FRAME_TYPE_CLASSES.PendingAction, FrameTypePendingAction);
    assert.equal(FRAME_TYPE_CLASSES.SystemError, FrameTypeSystemError);
    assert.equal(FRAME_TYPE_CLASSES.ParticipantJoined, FrameTypeParticipantJoined);
    assert.equal(FRAME_TYPE_CLASSES.ParticipantLeft, FrameTypeParticipantLeft);
    assert.equal(FRAME_TYPE_CLASSES.Error, FrameTypeError);
    assert.equal(FRAME_TYPE_CLASSES.Reflection, FrameTypeReflection);
    assert.equal(FRAME_TYPE_CLASSES.Compaction, FrameTypeCompaction);
    assert.equal(FRAME_TYPE_CLASSES.Stop, FrameTypeStop);
  });

  it('all classes should extend FrameTypeBase', () => {
    for (let [typeName, TypeClass] of Object.entries(FRAME_TYPE_CLASSES)) {
      let instance = new TypeClass({ id: 'test', type: typeName });
      assert.ok(instance instanceof FrameTypeBase, `${typeName} should extend FrameTypeBase`);
    }
  });
});

// =============================================================================
// FrameTypeDefault
// =============================================================================

describe('FrameTypeDefault', () => {
  it('isRenderable() returns true', () => {
    let instance = new FrameTypeDefault({ type: 'UnknownType' });
    assert.equal(instance.isRenderable(), true);
  });

  it('createElement() returns a div with unsupported message', () => {
    let createdElements = [];
    let mockDocument    = {
      createElement: (tag) => {
        let element = { tagName: tag, className: '', textContent: '' };
        createdElements.push(element);
        return element;
      },
    };

    let instance = new FrameTypeDefault({ type: 'UnknownType' });
    let element  = instance.createElement({ document: mockDocument });

    assert.ok(element);
    assert.equal(element.className, 'frame-type-unsupported');
    assert.equal(element.textContent, 'This frame type is not supported in this version.');
  });

  it('createElement() returns null without document helper', () => {
    let instance = new FrameTypeDefault({ type: 'UnknownType' });
    assert.equal(instance.createElement(null), null);
    assert.equal(instance.createElement({}), null);
  });

  it('extends FrameTypeBase', () => {
    let instance = new FrameTypeDefault({ type: 'UnknownType' });
    assert.ok(instance instanceof FrameTypeBase);
  });
});

// =============================================================================
// FrameTypeUserMessage
// =============================================================================

describe('FrameTypeUserMessage', () => {
  let frame = { id: 'f1', type: 'UserMessage', content: { text: 'hello world', html: '<p>hello world</p>' }, authorType: 'user' };

  it('getContentForIndexing() returns text', () => {
    let instance = new FrameTypeUserMessage(frame);
    assert.deepEqual(instance.getContentForIndexing(), [{ content_text: 'hello world' }]);
  });

  it('getContentForIndexing() falls back to html', () => {
    let instance = new FrameTypeUserMessage({ content: { html: '<b>hi</b>' } });
    assert.deepEqual(instance.getContentForIndexing(), [{ content_text: '<b>hi</b>' }]);
  });

  it('getContentForIndexing() returns empty for missing content', () => {
    let instance = new FrameTypeUserMessage({ content: {} });
    assert.deepEqual(instance.getContentForIndexing(), []);
  });

  it('toAgentMessage() returns user role with html preferred', () => {
    let instance = new FrameTypeUserMessage(frame);
    assert.deepEqual(instance.toAgentMessage(), { role: 'user', content: '<p>hello world</p>' });
  });

  it('toAgentMessage() falls back to text', () => {
    let instance = new FrameTypeUserMessage({ content: { text: 'plain' } });
    assert.deepEqual(instance.toAgentMessage(), { role: 'user', content: 'plain' });
  });

  it('toAgentMessage() returns empty string for missing content', () => {
    let instance = new FrameTypeUserMessage({ content: {} });
    assert.deepEqual(instance.toAgentMessage(), { role: 'user', content: '' });
  });

  it('toMessage() returns text', () => {
    let instance = new FrameTypeUserMessage(frame);
    assert.equal(instance.toMessage(), 'hello world');
  });

  it('toMessage() falls back to html', () => {
    let instance = new FrameTypeUserMessage({ content: { html: '<b>hi</b>' } });
    assert.equal(instance.toMessage(), '<b>hi</b>');
  });

  it('toMessage() returns empty string for missing content', () => {
    let instance = new FrameTypeUserMessage({ content: {} });
    assert.equal(instance.toMessage(), '');
  });

  it('isRenderable() returns true', () => {
    assert.equal(new FrameTypeUserMessage(frame).isRenderable(), true);
  });

  it('isIncludedInAgentContext() returns true', () => {
    assert.equal(new FrameTypeUserMessage(frame).isIncludedInAgentContext(), true);
  });

  it('getAlignment() returns user', () => {
    assert.equal(new FrameTypeUserMessage(frame).getAlignment(), 'user');
  });

  it('getAuthorDisplayName() returns You', () => {
    assert.equal(new FrameTypeUserMessage(frame).getAuthorDisplayName(), 'You');
  });

  it('showReplyButton() returns false', () => {
    assert.equal(new FrameTypeUserMessage(frame).showReplyButton(), false);
  });

  it('getContentLength() returns length of html when available', () => {
    let instance = new FrameTypeUserMessage(frame);
    assert.equal(instance.getContentLength(), '<p>hello world</p>'.length);
  });

  it('getContentLength() returns length of text when no html', () => {
    let instance = new FrameTypeUserMessage({ content: { text: 'abc' } });
    assert.equal(instance.getContentLength(), 3);
  });

  it('getContentLength() returns 0 for empty content', () => {
    let instance = new FrameTypeUserMessage({ content: {} });
    assert.equal(instance.getContentLength(), 0);
  });
});

// =============================================================================
// FrameTypeMessage
// =============================================================================

describe('FrameTypeMessage', () => {
  let agentFrame = {
    id:         'f2',
    type:       'Message',
    content:    { text: 'I can help', html: '<p>I can help</p>' },
    authorType: 'agent',
    authorID:   'agent-001',
  };

  it('getContentForIndexing() returns text', () => {
    let instance = new FrameTypeMessage(agentFrame);
    assert.deepEqual(instance.getContentForIndexing(), [{ content_text: 'I can help' }]);
  });

  it('getContentForIndexing() returns empty for missing text/html', () => {
    let instance = new FrameTypeMessage({ content: {} });
    assert.deepEqual(instance.getContentForIndexing(), []);
  });

  it('toAgentMessage() — single agent (no forAgentID) returns assistant role', () => {
    let instance = new FrameTypeMessage(agentFrame);
    let result   = instance.toAgentMessage({});
    assert.deepEqual(result, {
      role:    'assistant',
      content: [{ type: 'text', text: '<p>I can help</p>' }],
    });
  });

  it('toAgentMessage() — same agent returns assistant role', () => {
    let instance = new FrameTypeMessage(agentFrame);
    let result   = instance.toAgentMessage({ forAgentID: 'agent-001' });
    assert.deepEqual(result, {
      role:    'assistant',
      content: [{ type: 'text', text: '<p>I can help</p>' }],
    });
  });

  it('toAgentMessage() — different agent wraps in XML', () => {
    let instance = new FrameTypeMessage(agentFrame);
    let result   = instance.toAgentMessage({ forAgentID: 'agent-002' });
    assert.deepEqual(result, {
      role:    'user',
      content: '<agent-message from="agent-001"><p>I can help</p></agent-message>',
    });
  });

  it('toAgentMessage() — no authorID returns assistant role', () => {
    let instance = new FrameTypeMessage({ content: { html: 'hi' }, authorType: 'agent' });
    let result   = instance.toAgentMessage({ forAgentID: 'agent-002' });
    assert.deepEqual(result, {
      role:    'assistant',
      content: [{ type: 'text', text: 'hi' }],
    });
  });

  it('toMessage() returns text', () => {
    assert.equal(new FrameTypeMessage(agentFrame).toMessage(), 'I can help');
  });

  it('isRenderable() returns true', () => {
    assert.equal(new FrameTypeMessage(agentFrame).isRenderable(), true);
  });

  it('isIncludedInAgentContext() returns true', () => {
    assert.equal(new FrameTypeMessage(agentFrame).isIncludedInAgentContext(), true);
  });

  it('getAlignment() returns agent for agent authorType', () => {
    assert.equal(new FrameTypeMessage(agentFrame).getAlignment(), 'agent');
  });

  it('getAlignment() returns user for user authorType', () => {
    let instance = new FrameTypeMessage({ ...agentFrame, authorType: 'user' });
    assert.equal(instance.getAlignment(), 'user');
  });

  it('getAuthorDisplayName() returns You for user authorType', () => {
    let instance = new FrameTypeMessage({ ...agentFrame, authorType: 'user' });
    assert.equal(instance.getAuthorDisplayName(), 'You');
  });

  it('getAuthorDisplayName() returns agent name from context', () => {
    let context  = { agents: { 'agent-001': { name: 'Claude' } } };
    let instance = new FrameTypeMessage(agentFrame);
    assert.equal(instance.getAuthorDisplayName(context), 'Claude');
  });

  it('getAuthorDisplayName() returns Agent when no context', () => {
    let instance = new FrameTypeMessage(agentFrame);
    assert.equal(instance.getAuthorDisplayName(), 'Agent');
  });

  it('getAuthorDisplayName() returns Agent when agent not in context', () => {
    let instance = new FrameTypeMessage(agentFrame);
    assert.equal(instance.getAuthorDisplayName({ agents: {} }), 'Agent');
  });

  it('getAuthorDisplayName() works with Map-based agents', () => {
    let agentsMap = new Map([['agent-001', { name: 'MapClaude' }]]);
    let instance  = new FrameTypeMessage(agentFrame);
    assert.equal(instance.getAuthorDisplayName({ agents: agentsMap }), 'MapClaude');
  });

  it('showReplyButton() returns true', () => {
    assert.equal(new FrameTypeMessage(agentFrame).showReplyButton(), true);
  });

  it('getContentLength() returns length of html', () => {
    assert.equal(new FrameTypeMessage(agentFrame).getContentLength(), '<p>I can help</p>'.length);
  });
});

// =============================================================================
// FrameTypeToolCall
// =============================================================================

describe('FrameTypeToolCall', () => {
  let frame = {
    id:      'f3',
    type:    'ToolCall',
    content: {
      toolName:  'readFile',
      toolUseID: 'tu-001',
      arguments: { path: '/tmp/test.txt' },
    },
    authorType: 'agent',
  };

  it('getContentForIndexing() returns tool name and args', () => {
    let instance = new FrameTypeToolCall(frame);
    let result   = instance.getContentForIndexing();
    assert.deepEqual(result, [{ content_text: 'readFile: {"path":"/tmp/test.txt"}' }]);
  });

  it('getContentForIndexing() handles missing args', () => {
    let instance = new FrameTypeToolCall({ content: { toolName: 'test' } });
    assert.deepEqual(instance.getContentForIndexing(), [{ content_text: 'test: {}' }]);
  });

  it('toAgentMessage() returns tool_use when toolResultMap has match', () => {
    let toolResultMap = new Map([['tu-001', true]]);
    let instance      = new FrameTypeToolCall(frame);
    let result        = instance.toAgentMessage({ toolResultMap });

    assert.deepEqual(result, {
      role:    'assistant',
      content: [{
        type:  'tool_use',
        id:    'tu-001',
        name:  'readFile',
        input: { path: '/tmp/test.txt' },
      }],
    });
  });

  it('toAgentMessage() returns null when no toolResultMap', () => {
    let instance = new FrameTypeToolCall(frame);
    assert.equal(instance.toAgentMessage({}), null);
    assert.equal(instance.toAgentMessage(), null);
  });

  it('toAgentMessage() returns null for orphaned tool call (no matching result)', () => {
    let toolResultMap = new Map([['tu-999', true]]);
    let instance      = new FrameTypeToolCall(frame);
    assert.equal(instance.toAgentMessage({ toolResultMap }), null);
  });

  it('toAgentMessage() returns null when toolUseID is missing', () => {
    let instance      = new FrameTypeToolCall({ content: { toolName: 'test' } });
    let toolResultMap = new Map();
    assert.equal(instance.toAgentMessage({ toolResultMap }), null);
  });

  it('toMessage() returns formatted tool call', () => {
    let instance = new FrameTypeToolCall(frame);
    assert.equal(instance.toMessage(), '[tool-call: readFile]');
  });

  it('isRenderable() returns false', () => {
    assert.equal(new FrameTypeToolCall(frame).isRenderable(), false);
  });

  it('isIncludedInAgentContext() returns true', () => {
    assert.equal(new FrameTypeToolCall(frame).isIncludedInAgentContext(), true);
  });

  it('getAlignment() returns agent', () => {
    assert.equal(new FrameTypeToolCall(frame).getAlignment(), 'agent');
  });

  it('getToolUseID() returns toolUseID', () => {
    assert.equal(new FrameTypeToolCall(frame).getToolUseID(), 'tu-001');
  });

  it('getToolUseID() handles toolUseId (lowercase d)', () => {
    let instance = new FrameTypeToolCall({ content: { toolUseId: 'tu-alt' } });
    assert.equal(instance.getToolUseID(), 'tu-alt');
  });

  it('getToolUseID() returns null when missing', () => {
    let instance = new FrameTypeToolCall({ content: {} });
    assert.equal(instance.getToolUseID(), null);
  });
});

// =============================================================================
// FrameTypeToolResult
// =============================================================================

describe('FrameTypeToolResult', () => {
  let frame = {
    id:      'f4',
    type:    'ToolResult',
    content: {
      toolUseID: 'tu-001',
      result:    'file contents here',
      output:    'file contents here',
    },
  };

  it('getContentForIndexing() returns string result directly', () => {
    let instance = new FrameTypeToolResult(frame);
    assert.deepEqual(instance.getContentForIndexing(), [{ content_text: 'file contents here' }]);
  });

  it('getContentForIndexing() JSON stringifies non-string result', () => {
    let instance = new FrameTypeToolResult({ content: { result: { key: 'val' } } });
    assert.deepEqual(instance.getContentForIndexing(), [{ content_text: '{"key":"val"}' }]);
  });

  it('getContentForIndexing() returns empty for null result', () => {
    let instance = new FrameTypeToolResult({ content: { result: null } });
    assert.deepEqual(instance.getContentForIndexing(), []);
  });

  it('getContentForIndexing() returns empty for undefined result', () => {
    let instance = new FrameTypeToolResult({ content: {} });
    assert.deepEqual(instance.getContentForIndexing(), []);
  });

  it('toAgentMessage() returns tool_result and tracks in emittedToolResults', () => {
    let emittedToolResults = new Set();
    let instance           = new FrameTypeToolResult(frame);
    let result             = instance.toAgentMessage({ emittedToolResults });

    assert.deepEqual(result, {
      role:    'user',
      content: [{
        type:        'tool_result',
        tool_use_id: 'tu-001',
        content:     'file contents here',
      }],
    });
    assert.ok(emittedToolResults.has('tu-001'));
  });

  it('toAgentMessage() deduplicates — returns null for already emitted', () => {
    let emittedToolResults = new Set(['tu-001']);
    let instance           = new FrameTypeToolResult(frame);
    assert.equal(instance.toAgentMessage({ emittedToolResults }), null);
  });

  it('toAgentMessage() returns null for missing toolUseID', () => {
    let instance = new FrameTypeToolResult({ content: { output: 'test' } });
    assert.equal(instance.toAgentMessage({ emittedToolResults: new Set() }), null);
  });

  it('toAgentMessage() works without emittedToolResults set', () => {
    let instance = new FrameTypeToolResult(frame);
    let result   = instance.toAgentMessage({});
    // No emittedToolResults provided — still returns the result, just can't track
    assert.deepEqual(result, {
      role:    'user',
      content: [{
        type:        'tool_result',
        tool_use_id: 'tu-001',
        content:     'file contents here',
      }],
    });
  });

  it('toAgentMessage() handles null options', () => {
    let instance = new FrameTypeToolResult(frame);
    let result   = instance.toAgentMessage();
    assert.deepEqual(result, {
      role:    'user',
      content: [{
        type:        'tool_result',
        tool_use_id: 'tu-001',
        content:     'file contents here',
      }],
    });
  });

  it('toMessage() returns string output', () => {
    let instance = new FrameTypeToolResult(frame);
    assert.equal(instance.toMessage(), 'file contents here');
  });

  it('toMessage() JSON stringifies non-string output', () => {
    let instance = new FrameTypeToolResult({ content: { output: { data: 1 } } });
    assert.equal(instance.toMessage(), '{"data":1}');
  });

  it('toMessage() returns empty for null output', () => {
    let instance = new FrameTypeToolResult({ content: {} });
    assert.equal(instance.toMessage(), '');
  });

  it('isRenderable() returns false', () => {
    assert.equal(new FrameTypeToolResult(frame).isRenderable(), false);
  });

  it('isIncludedInAgentContext() returns true', () => {
    assert.equal(new FrameTypeToolResult(frame).isIncludedInAgentContext(), true);
  });

  it('getToolUseID() returns toolUseID', () => {
    assert.equal(new FrameTypeToolResult(frame).getToolUseID(), 'tu-001');
  });

  it('getToolUseID() handles toolUseId (lowercase d)', () => {
    let instance = new FrameTypeToolResult({ content: { toolUseId: 'tu-alt' } });
    assert.equal(instance.getToolUseID(), 'tu-alt');
  });

  it('getContentLength() returns length of string output', () => {
    let instance = new FrameTypeToolResult(frame);
    assert.equal(instance.getContentLength(), 'file contents here'.length);
  });

  it('getContentLength() returns stringified length for object output', () => {
    let instance = new FrameTypeToolResult({ content: { output: { a: 1 } } });
    assert.equal(instance.getContentLength(), '{"a":1}'.length);
  });

  it('getContentLength() returns 0 for null output', () => {
    let instance = new FrameTypeToolResult({ content: {} });
    assert.equal(instance.getContentLength(), 0);
  });
});

// =============================================================================
// FrameTypeToolError
// =============================================================================

describe('FrameTypeToolError', () => {
  let frame = { id: 'f5', type: 'ToolError', content: { message: 'Tool failed', error: 'err', text: 'txt' } };

  it('getContentForIndexing() returns message first', () => {
    assert.deepEqual(new FrameTypeToolError(frame).getContentForIndexing(), [{ content_text: 'Tool failed' }]);
  });

  it('getContentForIndexing() falls back to error', () => {
    let instance = new FrameTypeToolError({ content: { error: 'err msg' } });
    assert.deepEqual(instance.getContentForIndexing(), [{ content_text: 'err msg' }]);
  });

  it('getContentForIndexing() falls back to text', () => {
    let instance = new FrameTypeToolError({ content: { text: 'txt msg' } });
    assert.deepEqual(instance.getContentForIndexing(), [{ content_text: 'txt msg' }]);
  });

  it('getContentForIndexing() returns empty for missing content', () => {
    assert.deepEqual(new FrameTypeToolError({ content: {} }).getContentForIndexing(), []);
  });

  it('isRenderable() returns false', () => {
    assert.equal(new FrameTypeToolError(frame).isRenderable(), false);
  });

  it('isIncludedInAgentContext() returns false', () => {
    assert.equal(new FrameTypeToolError(frame).isIncludedInAgentContext(), false);
  });

  it('toMessage() returns message', () => {
    assert.equal(new FrameTypeToolError(frame).toMessage(), 'Tool failed');
  });

  it('toMessage() returns empty for missing content', () => {
    assert.equal(new FrameTypeToolError({ content: {} }).toMessage(), '');
  });
});

// =============================================================================
// FrameTypeToolActivity
// =============================================================================

describe('FrameTypeToolActivity', () => {
  let frame = { id: 'f6', type: 'ToolActivity', content: { html: '<div>Reading file...</div>' } };

  it('getContentForIndexing() returns html', () => {
    assert.deepEqual(new FrameTypeToolActivity(frame).getContentForIndexing(), [{ content_html: '<div>Reading file...</div>' }]);
  });

  it('getContentForIndexing() returns empty for missing html', () => {
    assert.deepEqual(new FrameTypeToolActivity({ content: {} }).getContentForIndexing(), []);
  });

  it('isRenderable() returns true', () => {
    assert.equal(new FrameTypeToolActivity(frame).isRenderable(), true);
  });

  it('isIncludedInAgentContext() returns false', () => {
    assert.equal(new FrameTypeToolActivity(frame).isIncludedInAgentContext(), false);
  });

  it('getAlignment() returns agent', () => {
    assert.equal(new FrameTypeToolActivity(frame).getAlignment(), 'agent');
  });

  it('toMessage() returns html', () => {
    assert.equal(new FrameTypeToolActivity(frame).toMessage(), '<div>Reading file...</div>');
  });

  it('toMessage() returns empty for missing html', () => {
    assert.equal(new FrameTypeToolActivity({ content: {} }).toMessage(), '');
  });

  it('createElement() returns null (Phase 4 stub)', () => {
    assert.equal(new FrameTypeToolActivity(frame).createElement({}), null);
  });
});

// =============================================================================
// FrameTypePermissionRequest
// =============================================================================

describe('FrameTypePermissionRequest', () => {
  let frame = { id: 'f7', type: 'PermissionRequest', content: { toolName: 'executeCommand' } };

  it('isRenderable() returns true', () => {
    assert.equal(new FrameTypePermissionRequest(frame).isRenderable(), true);
  });

  it('isIncludedInAgentContext() returns false', () => {
    assert.equal(new FrameTypePermissionRequest(frame).isIncludedInAgentContext(), false);
  });

  it('getAlignment() returns system', () => {
    assert.equal(new FrameTypePermissionRequest(frame).getAlignment(), 'system');
  });

  it('getAuthorDisplayName() returns System', () => {
    assert.equal(new FrameTypePermissionRequest(frame).getAuthorDisplayName(), 'System');
  });

  it('toMessage() returns permission request string', () => {
    assert.equal(new FrameTypePermissionRequest(frame).toMessage(), 'Permission requested for "executeCommand"');
  });

  it('toMessage() handles missing toolName', () => {
    let instance = new FrameTypePermissionRequest({ content: {} });
    assert.equal(instance.toMessage(), 'Permission requested for ""');
  });
});

// =============================================================================
// FrameTypePermissionDenied
// =============================================================================

describe('FrameTypePermissionDenied', () => {
  let frame = { id: 'f8', type: 'PermissionDenied', content: { message: 'User denied', reason: 'security' } };

  it('getContentForIndexing() returns message first', () => {
    assert.deepEqual(new FrameTypePermissionDenied(frame).getContentForIndexing(), [{ content_text: 'User denied' }]);
  });

  it('getContentForIndexing() falls back to reason', () => {
    let instance = new FrameTypePermissionDenied({ content: { reason: 'not allowed' } });
    assert.deepEqual(instance.getContentForIndexing(), [{ content_text: 'not allowed' }]);
  });

  it('getContentForIndexing() returns empty for missing content', () => {
    assert.deepEqual(new FrameTypePermissionDenied({ content: {} }).getContentForIndexing(), []);
  });

  it('isRenderable() returns false', () => {
    assert.equal(new FrameTypePermissionDenied(frame).isRenderable(), false);
  });

  it('isIncludedInAgentContext() returns false', () => {
    assert.equal(new FrameTypePermissionDenied(frame).isIncludedInAgentContext(), false);
  });

  it('toMessage() returns message', () => {
    assert.equal(new FrameTypePermissionDenied(frame).toMessage(), 'User denied');
  });

  it('toMessage() falls back to reason', () => {
    assert.equal(new FrameTypePermissionDenied({ content: { reason: 'nope' } }).toMessage(), 'nope');
  });

  it('toMessage() returns empty for missing content', () => {
    assert.equal(new FrameTypePermissionDenied({ content: {} }).toMessage(), '');
  });
});

// =============================================================================
// FrameTypeCommandResult
// =============================================================================

describe('FrameTypeCommandResult', () => {
  let frame = { id: 'f9', type: 'CommandResult', content: { html: '<pre>output</pre>', text: 'output' } };

  it('isRenderable() returns true', () => {
    assert.equal(new FrameTypeCommandResult(frame).isRenderable(), true);
  });

  it('isIncludedInAgentContext() returns false', () => {
    assert.equal(new FrameTypeCommandResult(frame).isIncludedInAgentContext(), false);
  });

  it('getAlignment() returns system', () => {
    assert.equal(new FrameTypeCommandResult(frame).getAlignment(), 'system');
  });

  it('getAuthorDisplayName() returns System', () => {
    assert.equal(new FrameTypeCommandResult(frame).getAuthorDisplayName(), 'System');
  });

  it('toMessage() returns html first', () => {
    assert.equal(new FrameTypeCommandResult(frame).toMessage(), '<pre>output</pre>');
  });

  it('toMessage() falls back to text', () => {
    assert.equal(new FrameTypeCommandResult({ content: { text: 'txt' } }).toMessage(), 'txt');
  });

  it('toMessage() returns empty for missing content', () => {
    assert.equal(new FrameTypeCommandResult({ content: {} }).toMessage(), '');
  });
});

// =============================================================================
// FrameTypeSessionLink
// =============================================================================

describe('FrameTypeSessionLink', () => {
  let frame = { id: 'f10', type: 'SessionLink', content: { title: 'Previous Chat', targetSessionID: 'sess-123' } };

  it('isRenderable() returns true', () => {
    assert.equal(new FrameTypeSessionLink(frame).isRenderable(), true);
  });

  it('isIncludedInAgentContext() returns false', () => {
    assert.equal(new FrameTypeSessionLink(frame).isIncludedInAgentContext(), false);
  });

  it('getAlignment() returns system', () => {
    assert.equal(new FrameTypeSessionLink(frame).getAlignment(), 'system');
  });

  it('getAuthorDisplayName() returns System', () => {
    assert.equal(new FrameTypeSessionLink(frame).getAuthorDisplayName(), 'System');
  });

  it('toMessage() returns title', () => {
    assert.equal(new FrameTypeSessionLink(frame).toMessage(), 'Session link: Previous Chat');
  });

  it('toMessage() falls back to targetSessionID', () => {
    let instance = new FrameTypeSessionLink({ content: { targetSessionID: 'sess-456' } });
    assert.equal(instance.toMessage(), 'Session link: sess-456');
  });

  it('toMessage() returns empty trailing for missing content', () => {
    assert.equal(new FrameTypeSessionLink({ content: {} }).toMessage(), 'Session link: ');
  });
});

// =============================================================================
// FrameTypeHookBlocked
// =============================================================================

describe('FrameTypeHookBlocked', () => {
  let frame = { id: 'f11', type: 'HookBlocked', content: { text: 'Hook blocked it', message: 'blocked msg' } };

  it('getContentForIndexing() returns text first', () => {
    assert.deepEqual(new FrameTypeHookBlocked(frame).getContentForIndexing(), [{ content_text: 'Hook blocked it' }]);
  });

  it('getContentForIndexing() falls back to message', () => {
    let instance = new FrameTypeHookBlocked({ content: { message: 'blocked' } });
    assert.deepEqual(instance.getContentForIndexing(), [{ content_text: 'blocked' }]);
  });

  it('getContentForIndexing() returns empty for missing content', () => {
    assert.deepEqual(new FrameTypeHookBlocked({ content: {} }).getContentForIndexing(), []);
  });

  it('isRenderable() returns false', () => {
    assert.equal(new FrameTypeHookBlocked(frame).isRenderable(), false);
  });

  it('isIncludedInAgentContext() returns false', () => {
    assert.equal(new FrameTypeHookBlocked(frame).isIncludedInAgentContext(), false);
  });

  it('toMessage() returns text first', () => {
    assert.equal(new FrameTypeHookBlocked(frame).toMessage(), 'Hook blocked it');
  });

  it('toMessage() returns empty for missing content', () => {
    assert.equal(new FrameTypeHookBlocked({ content: {} }).toMessage(), '');
  });
});

// =============================================================================
// FrameTypePendingAction
// =============================================================================

describe('FrameTypePendingAction', () => {
  let frame = {
    id:      'f12',
    type:    'PendingAction',
    content: {
      toolName:  'executeCommand',
      toolUseID: 'tu-002',
      arguments: { command: 'ls -la', _parsedCommands: ['ls', '-la'] },
    },
  };

  it('isRenderable() returns false', () => {
    assert.equal(new FrameTypePendingAction(frame).isRenderable(), false);
  });

  it('isIncludedInAgentContext() returns true', () => {
    assert.equal(new FrameTypePendingAction(frame).isIncludedInAgentContext(), true);
  });

  it('toAgentMessage() returns tool_use when approved (in toolResultMap)', () => {
    let toolResultMap = new Map([['tu-002', true]]);
    let instance      = new FrameTypePendingAction(frame);
    let result        = instance.toAgentMessage({ toolResultMap });

    assert.deepEqual(result, {
      role:    'assistant',
      content: [{
        type:  'tool_use',
        id:    'tu-002',
        name:  'executeCommand',
        input: { command: 'ls -la' }, // _parsedCommands stripped
      }],
    });
  });

  it('toAgentMessage() strips _parsedCommands from arguments', () => {
    let toolResultMap = new Map([['tu-002', true]]);
    let instance      = new FrameTypePendingAction(frame);
    let result        = instance.toAgentMessage({ toolResultMap });

    assert.equal(result.content[0].input._parsedCommands, undefined);
    assert.equal(result.content[0].input.command, 'ls -la');
  });

  it('toAgentMessage() returns null when not approved (not in toolResultMap)', () => {
    let toolResultMap = new Map();
    let instance      = new FrameTypePendingAction(frame);
    assert.equal(instance.toAgentMessage({ toolResultMap }), null);
  });

  it('toAgentMessage() returns null without toolResultMap', () => {
    let instance = new FrameTypePendingAction(frame);
    assert.equal(instance.toAgentMessage({}), null);
    assert.equal(instance.toAgentMessage(), null);
  });

  it('toAgentMessage() handles arguments without _parsedCommands', () => {
    let cleanFrame    = { content: { toolName: 'test', toolUseID: 'tu-003', arguments: { key: 'val' } } };
    let toolResultMap = new Map([['tu-003', true]]);
    let instance      = new FrameTypePendingAction(cleanFrame);
    let result        = instance.toAgentMessage({ toolResultMap });

    assert.deepEqual(result.content[0].input, { key: 'val' });
  });

  it('getToolUseID() returns toolUseID', () => {
    assert.equal(new FrameTypePendingAction(frame).getToolUseID(), 'tu-002');
  });

  it('getToolUseID() handles toolUseId (lowercase d)', () => {
    let instance = new FrameTypePendingAction({ content: { toolUseId: 'tu-alt' } });
    assert.equal(instance.getToolUseID(), 'tu-alt');
  });

  it('getToolUseID() returns null when missing', () => {
    assert.equal(new FrameTypePendingAction({ content: {} }).getToolUseID(), null);
  });

  it('toMessage() returns formatted pending action', () => {
    assert.equal(new FrameTypePendingAction(frame).toMessage(), '[pending: executeCommand]');
  });
});

// =============================================================================
// FrameTypeSystemError
// =============================================================================

describe('FrameTypeSystemError', () => {
  let frame = { id: 'f13', type: 'SystemError', content: { message: 'System crashed', text: 'fallback' } };

  it('isRenderable() returns false', () => {
    assert.equal(new FrameTypeSystemError(frame).isRenderable(), false);
  });

  it('isIncludedInAgentContext() returns false', () => {
    assert.equal(new FrameTypeSystemError(frame).isIncludedInAgentContext(), false);
  });

  it('toMessage() returns message', () => {
    assert.equal(new FrameTypeSystemError(frame).toMessage(), 'System crashed');
  });

  it('toMessage() falls back to text', () => {
    assert.equal(new FrameTypeSystemError({ content: { text: 'txt' } }).toMessage(), 'txt');
  });

  it('toMessage() returns empty for missing content', () => {
    assert.equal(new FrameTypeSystemError({ content: {} }).toMessage(), '');
  });
});

// =============================================================================
// FrameTypeParticipantJoined
// =============================================================================

describe('FrameTypeParticipantJoined', () => {
  let frame = { id: 'f14', type: 'ParticipantJoined', content: { participantName: 'Alice' } };

  it('isRenderable() returns false', () => {
    assert.equal(new FrameTypeParticipantJoined(frame).isRenderable(), false);
  });

  it('isIncludedInAgentContext() returns false', () => {
    assert.equal(new FrameTypeParticipantJoined(frame).isIncludedInAgentContext(), false);
  });

  it('toMessage() returns participant name', () => {
    assert.equal(new FrameTypeParticipantJoined(frame).toMessage(), 'Alice joined');
  });

  it('toMessage() returns Someone when name missing', () => {
    assert.equal(new FrameTypeParticipantJoined({ content: {} }).toMessage(), 'Someone joined');
  });
});

// =============================================================================
// FrameTypeParticipantLeft
// =============================================================================

describe('FrameTypeParticipantLeft', () => {
  let frame = { id: 'f15', type: 'ParticipantLeft', content: { participantName: 'Bob' } };

  it('isRenderable() returns false', () => {
    assert.equal(new FrameTypeParticipantLeft(frame).isRenderable(), false);
  });

  it('isIncludedInAgentContext() returns false', () => {
    assert.equal(new FrameTypeParticipantLeft(frame).isIncludedInAgentContext(), false);
  });

  it('toMessage() returns participant name', () => {
    assert.equal(new FrameTypeParticipantLeft(frame).toMessage(), 'Bob left');
  });

  it('toMessage() returns Someone when name missing', () => {
    assert.equal(new FrameTypeParticipantLeft({ content: {} }).toMessage(), 'Someone left');
  });
});

// =============================================================================
// FrameTypeError
// =============================================================================

describe('FrameTypeError', () => {
  let frame = { id: 'f16', type: 'Error', content: { message: 'Something broke', error: 'err', text: 'txt' } };

  it('getContentForIndexing() returns message first', () => {
    assert.deepEqual(new FrameTypeError(frame).getContentForIndexing(), [{ content_text: 'Something broke' }]);
  });

  it('getContentForIndexing() falls back to error', () => {
    assert.deepEqual(new FrameTypeError({ content: { error: 'e' } }).getContentForIndexing(), [{ content_text: 'e' }]);
  });

  it('getContentForIndexing() falls back to text', () => {
    assert.deepEqual(new FrameTypeError({ content: { text: 't' } }).getContentForIndexing(), [{ content_text: 't' }]);
  });

  it('getContentForIndexing() returns empty for missing content', () => {
    assert.deepEqual(new FrameTypeError({ content: {} }).getContentForIndexing(), []);
  });

  it('isRenderable() returns true', () => {
    assert.equal(new FrameTypeError(frame).isRenderable(), true);
  });

  it('isIncludedInAgentContext() returns false', () => {
    assert.equal(new FrameTypeError(frame).isIncludedInAgentContext(), false);
  });

  it('getAlignment() returns system', () => {
    assert.equal(new FrameTypeError(frame).getAlignment(), 'system');
  });

  it('toMessage() returns message', () => {
    assert.equal(new FrameTypeError(frame).toMessage(), 'Something broke');
  });

  it('toMessage() returns empty for missing content', () => {
    assert.equal(new FrameTypeError({ content: {} }).toMessage(), '');
  });
});

// =============================================================================
// FrameTypeReflection
// =============================================================================

describe('FrameTypeReflection', () => {
  let frame = { id: 'f17', type: 'Reflection', content: { text: 'I should approach this differently' } };

  it('getContentForIndexing() returns text', () => {
    assert.deepEqual(new FrameTypeReflection(frame).getContentForIndexing(), [{ content_text: 'I should approach this differently' }]);
  });

  it('getContentForIndexing() returns empty for missing text', () => {
    assert.deepEqual(new FrameTypeReflection({ content: {} }).getContentForIndexing(), []);
  });

  it('isRenderable() returns true', () => {
    assert.equal(new FrameTypeReflection(frame).isRenderable(), true);
  });

  it('isIncludedInAgentContext() returns false', () => {
    assert.equal(new FrameTypeReflection(frame).isIncludedInAgentContext(), false);
  });

  it('getAlignment() returns agent', () => {
    assert.equal(new FrameTypeReflection(frame).getAlignment(), 'agent');
  });

  it('toMessage() returns text', () => {
    assert.equal(new FrameTypeReflection(frame).toMessage(), 'I should approach this differently');
  });

  it('toMessage() returns empty for missing text', () => {
    assert.equal(new FrameTypeReflection({ content: {} }).toMessage(), '');
  });
});

// =============================================================================
// FrameTypeCompaction
// =============================================================================

describe('FrameTypeCompaction', () => {
  let frame = { id: 'f18', type: 'Compaction', content: { summary: 'Previous conversation discussed X' } };

  it('isRenderable() returns true', () => {
    assert.equal(new FrameTypeCompaction(frame).isRenderable(), true);
  });

  it('isIncludedInAgentContext() returns false', () => {
    assert.equal(new FrameTypeCompaction(frame).isIncludedInAgentContext(), false);
  });

  it('getAlignment() returns system', () => {
    assert.equal(new FrameTypeCompaction(frame).getAlignment(), 'system');
  });

  it('toMessage() returns summary', () => {
    assert.equal(new FrameTypeCompaction(frame).toMessage(), 'Previous conversation discussed X');
  });

  it('toMessage() returns empty for missing summary', () => {
    assert.equal(new FrameTypeCompaction({ content: {} }).toMessage(), '');
  });
});

// =============================================================================
// FrameTypeStop
// =============================================================================

describe('FrameTypeStop', () => {
  let frame = { id: 'f19', type: 'Stop', content: { text: 'User stopped', message: 'Stopped by user' } };

  it('getContentForIndexing() returns text first', () => {
    assert.deepEqual(new FrameTypeStop(frame).getContentForIndexing(), [{ content_text: 'User stopped' }]);
  });

  it('getContentForIndexing() falls back to message', () => {
    assert.deepEqual(new FrameTypeStop({ content: { message: 'stopped' } }).getContentForIndexing(), [{ content_text: 'stopped' }]);
  });

  it('getContentForIndexing() returns empty for missing content', () => {
    assert.deepEqual(new FrameTypeStop({ content: {} }).getContentForIndexing(), []);
  });

  it('isRenderable() returns false', () => {
    assert.equal(new FrameTypeStop(frame).isRenderable(), false);
  });

  it('isIncludedInAgentContext() returns false', () => {
    assert.equal(new FrameTypeStop(frame).isIncludedInAgentContext(), false);
  });

  it('toMessage() returns text first', () => {
    assert.equal(new FrameTypeStop(frame).toMessage(), 'User stopped');
  });

  it('toMessage() falls back to message', () => {
    assert.equal(new FrameTypeStop({ content: { message: 'msg' } }).toMessage(), 'msg');
  });

  it('toMessage() returns default when no content', () => {
    assert.equal(new FrameTypeStop({ content: {} }).toMessage(), 'Interaction stopped');
  });
});
