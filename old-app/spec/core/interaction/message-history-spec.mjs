'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isFirstMessage, injectPrimer, buildMessages } from '../../../src/core/interaction/message-history.mjs';

// =============================================================================
// Phase C5 — Message History Utilities Tests
// =============================================================================

describe('Message History Utilities (C5)', () => {

  // ---------------------------------------------------------------------------
  // isFirstMessage
  // ---------------------------------------------------------------------------

  describe('isFirstMessage', () => {
    it('should return true for empty frames', () => {
      assert.equal(isFirstMessage([]), true);
    });

    it('should return true for single user-message', () => {
      let frames = [{ type: 'UserMessage', deleted: false, hidden: false }];
      assert.equal(isFirstMessage(frames), true);
    });

    it('should return false after assistant message exists', () => {
      let frames = [
        { type: 'UserMessage', deleted: false, hidden: false },
        { type: 'Message', deleted: false, hidden: false },
      ];
      assert.equal(isFirstMessage(frames), false);
    });

    it('should return false when multiple user messages exist', () => {
      let frames = [
        { type: 'UserMessage', deleted: false, hidden: false },
        { type: 'UserMessage', deleted: false, hidden: false },
      ];
      assert.equal(isFirstMessage(frames), false);
    });

    it('should ignore deleted frames', () => {
      let frames = [
        { type: 'UserMessage', deleted: true, hidden: false },
        { type: 'UserMessage', deleted: false, hidden: false },
      ];
      assert.equal(isFirstMessage(frames), true);
    });

    it('should ignore hidden frames', () => {
      let frames = [
        { type: 'UserMessage', deleted: false, hidden: true },
        { type: 'UserMessage', deleted: false, hidden: false },
      ];
      assert.equal(isFirstMessage(frames), true);
    });
  });

  // ---------------------------------------------------------------------------
  // injectPrimer
  // ---------------------------------------------------------------------------

  describe('injectPrimer', () => {
    it('should create primer-only message for empty array', () => {
      let result = injectPrimer([], 'PRIMER');
      assert.deepEqual(result, [{ role: 'user', content: 'PRIMER' }]);
    });

    it('should create primer-only message for null/undefined', () => {
      let result = injectPrimer(null, 'PRIMER');
      assert.deepEqual(result, [{ role: 'user', content: 'PRIMER' }]);
    });

    it('should prepend primer to first user message', () => {
      let messages = [{ role: 'user', content: 'hello' }];
      let result   = injectPrimer(messages, 'PRIMER');
      assert.equal(result[0].content, 'PRIMER\n\nhello');
    });

    it('should skip non-user messages and inject into first user', () => {
      let messages = [
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'hello' },
      ];
      let result = injectPrimer(messages, 'PRIMER');
      assert.equal(result[0].content, 'hi');      // assistant untouched
      assert.equal(result[1].content, 'PRIMER\n\nhello');
    });

    it('should not mutate original array', () => {
      let messages = [{ role: 'user', content: 'hello' }];
      injectPrimer(messages, 'PRIMER');
      assert.equal(messages[0].content, 'hello');
    });

    it('should handle user message with empty content', () => {
      let messages = [{ role: 'user', content: '' }];
      let result   = injectPrimer(messages, 'PRIMER');
      assert.equal(result[0].content, 'PRIMER\n\n');
    });

    it('should handle user message with null content', () => {
      let messages = [{ role: 'user', content: null }];
      let result   = injectPrimer(messages, 'PRIMER');
      assert.equal(result[0].content, 'PRIMER\n\n');
    });
  });

  // ---------------------------------------------------------------------------
  // buildMessages
  // ---------------------------------------------------------------------------

  describe('buildMessages', () => {
    it('should return empty array for empty frames', () => {
      assert.deepEqual(buildMessages([]), []);
    });

    it('should convert user-message frames to user role', () => {
      let frames = [
        { id: 'f1', type: 'UserMessage', content: { text: 'hello' }, deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames);
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].role, 'user');
      assert.equal(msgs[0].content, 'hello');
    });

    it('should convert message frames to assistant role', () => {
      let frames = [
        { id: 'f1', type: 'Message', content: { html: '<p>hi</p>' }, deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames);
      assert.equal(msgs[0].role, 'assistant');
      assert.equal(msgs[0].content, '<p>hi</p>');
    });

    it('should exclude deleted frames', () => {
      let frames = [
        { id: 'f1', type: 'UserMessage', content: { text: 'hello' }, deleted: true, hidden: false },
      ];
      assert.deepEqual(buildMessages(frames), []);
    });

    it('should exclude hidden frames', () => {
      let frames = [
        { id: 'f1', type: 'UserMessage', content: { text: 'hello' }, deleted: false, hidden: true },
      ];
      assert.deepEqual(buildMessages(frames), []);
    });

    it('should exclude system frame types that are not agent-visible', () => {
      let excludedTypes = [
        'PermissionRequest', 'PermissionDenied', 'HookBlocked',
        'ToolError', 'Reflection', 'ToolActivity', 'Stop',
      ];

      for (let type of excludedTypes) {
        let frames = [{ id: 'f1', type, content: {}, deleted: false, hidden: false }];
        let msgs   = buildMessages(frames);
        assert.equal(msgs.length, 0, `${type} should be excluded`);
      }
    });

    it('should include Error frames as user-role system messages', () => {
      let frames = [{ id: 'f1', type: 'Error', content: { message: 'Something broke' }, deleted: false, hidden: false }];
      let msgs   = buildMessages(frames);
      assert.equal(msgs.length, 1, 'Error frames should be included');
      assert.equal(msgs[0].role, 'user');
      assert.ok(msgs[0].content.includes('[System Error:'));
    });

    it('should include CommandResult frames as user-role system messages', () => {
      let frames = [{ id: 'f1', type: 'CommandResult', content: { html: 'result output' }, deleted: false, hidden: false }];
      let msgs   = buildMessages(frames);
      assert.equal(msgs.length, 1, 'CommandResult frames should be included');
      assert.equal(msgs[0].role, 'user');
      assert.ok(msgs[0].content.includes('[System:'));
    });

    it('should include tool-call frames', () => {
      let frames = [
        { id: 'f1', type: 'ToolCall', content: { toolName: 'test', arguments: {} }, deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames);
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].type, 'ToolCall');
    });

    it('should include tool-result frames', () => {
      let frames = [
        { id: 'f1', type: 'ToolResult', content: { output: 'ok' }, deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames);
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].type, 'ToolResult');
    });

    it('should include resolved pending-action frames as tool-calls', () => {
      let frames = [
        { id: 'f1', type: 'PendingAction', content: { toolName: 'test', toolUseID: 'tu_1' }, deleted: false, hidden: false },
        { id: 'f2', type: 'ToolResult', content: { output: 'ok', toolUseID: 'tu_1' }, deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames);
      assert.equal(msgs.length, 2);
      assert.equal(msgs[0].type, 'ToolCall');
    });

    it('should exclude unresolved pending-action frames', () => {
      let frames = [
        { id: 'f1', type: 'PendingAction', content: { toolName: 'test', toolUseID: 'tu_1' }, deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames);
      assert.equal(msgs.length, 0);
    });

    // Multi-agent attribution
    it('should wrap other agents messages as user role with XML tag', () => {
      let frames = [
        { id: 'f1', type: 'Message', content: { html: 'hello' }, authorID: 'agent-B', deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames, 'agent-A');
      assert.equal(msgs[0].role, 'user');
      assert.ok(msgs[0].content.includes('<agent-message'));
      assert.ok(msgs[0].content.includes('source="agent-B"'));
    });

    it('should keep own messages as assistant role in multi-agent', () => {
      let frames = [
        { id: 'f1', type: 'Message', content: { html: 'hello' }, authorID: 'agent-A', deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames, 'agent-A');
      assert.equal(msgs[0].role, 'assistant');
    });

    it('should handle frames with missing content gracefully', () => {
      let frames = [
        { id: 'f1', type: 'UserMessage', content: null, deleted: false, hidden: false },
        { id: 'f2', type: 'Message', content: null, deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames);
      assert.equal(msgs.length, 2);
      assert.equal(msgs[0].content, '');
      assert.equal(msgs[1].content, '');
    });

    // Markdown-converted user messages (content.html instead of content.text)
    it('should use content.html for user-message frames when available', () => {
      let frames = [
        { id: 'f1', type: 'UserMessage', content: { html: '<p>hello</p>' }, deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames);
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].role, 'user');
      assert.equal(msgs[0].content, '<p>hello</p>');
    });

    it('should prefer content.html over content.text for user-message frames', () => {
      let frames = [
        { id: 'f1', type: 'UserMessage', content: { html: '<p>converted</p>', text: 'original' }, deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames);
      assert.equal(msgs[0].content, '<p>converted</p>');
    });

    it('should fall back to content.text when content.html is absent for user-message', () => {
      let frames = [
        { id: 'f1', type: 'UserMessage', content: { text: 'plain text' }, deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames);
      assert.equal(msgs[0].content, 'plain text');
    });

    it('should handle user-message with empty html string', () => {
      let frames = [
        { id: 'f1', type: 'UserMessage', content: { html: '', text: 'fallback' }, deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames);
      // Empty html is falsy, should fall back to text
      assert.equal(msgs[0].content, 'fallback');
    });

    // -------------------------------------------------------------------------
    // Permission replay: user message between pending-action and tool-result
    // -------------------------------------------------------------------------

    it('should keep tool-result adjacent to pending-action even when user message intervenes', () => {
      // Simulates: user sends a message while a permission is pending,
      // then the permission is approved, creating a tool-result AFTER the user message.
      let frames = [
        { id: 'f1', type: 'UserMessage', content: { text: 'run date' }, deleted: false, hidden: false },
        { id: 'f2', type: 'Message', content: { html: 'Running date command.' }, deleted: false, hidden: false },
        { id: 'f3', type: 'PendingAction', content: { toolName: 'shell:execute', arguments: { command: 'date' }, toolUseID: 'tu_1' }, deleted: false, hidden: false },
        { id: 'f4', type: 'PermissionRequest', content: { toolName: 'shell:execute' }, deleted: false, hidden: false },
        { id: 'f5', type: 'UserMessage', content: { text: 'also search the web' }, deleted: false, hidden: false },
        { id: 'f6', type: 'ToolResult', content: { output: 'Sat Mar 14', toolUseID: 'tu_1' }, deleted: false, hidden: false },
      ];

      let msgs = buildMessages(frames);

      // Expected order: user-msg, assistant-msg, tool-call(tu_1), tool-result(tu_1), user-msg
      assert.equal(msgs.length, 5);
      assert.equal(msgs[0].role, 'user');
      assert.equal(msgs[0].content, 'run date');
      assert.equal(msgs[1].role, 'assistant');
      assert.equal(msgs[2].type, 'ToolCall');
      assert.equal(msgs[2].content.toolUseID, 'tu_1');
      assert.equal(msgs[3].type, 'ToolResult');
      assert.equal(msgs[3].content.toolUseID, 'tu_1');
      assert.equal(msgs[4].role, 'user');
      assert.equal(msgs[4].content, 'also search the web');
    });

    it('should strip _parsedCommands from pending-action arguments', () => {
      let frames = [
        { id: 'f1', type: 'PendingAction', content: {
          toolName: 'shell:execute',
          arguments: { command: 'ls', _parsedCommands: [{ command: 'ls', status: 'approved' }] },
          toolUseID: 'tu_1',
        }, deleted: false, hidden: false },
        { id: 'f2', type: 'ToolResult', content: { output: 'file1\nfile2', toolUseID: 'tu_1' }, deleted: false, hidden: false },
      ];

      let msgs = buildMessages(frames);
      assert.equal(msgs[0].type, 'ToolCall');
      assert.equal(msgs[0].content.arguments.command, 'ls');
      assert.equal(msgs[0].content.arguments._parsedCommands, undefined);
    });

    it('should not duplicate tool-result when pending-action pulls it forward', () => {
      let frames = [
        { id: 'f1', type: 'PendingAction', content: { toolName: 'test', toolUseID: 'tu_1' }, deleted: false, hidden: false },
        { id: 'f2', type: 'UserMessage', content: { text: 'extra' }, deleted: false, hidden: false },
        { id: 'f3', type: 'ToolResult', content: { output: 'ok', toolUseID: 'tu_1' }, deleted: false, hidden: false },
      ];

      let msgs = buildMessages(frames);
      let toolResults = msgs.filter((m) => m.type === 'ToolResult');
      assert.equal(toolResults.length, 1, 'should have exactly one tool-result');
    });

    it('should only skip deleted/hidden tool-results from resolvedToolIds', () => {
      // A deleted tool-result should NOT cause its pending-action to be included
      let frames = [
        { id: 'f1', type: 'PendingAction', content: { toolName: 'test', toolUseID: 'tu_1' }, deleted: false, hidden: false },
        { id: 'f2', type: 'ToolResult', content: { output: 'ok', toolUseID: 'tu_1' }, deleted: true, hidden: false },
      ];

      let msgs = buildMessages(frames);
      assert.equal(msgs.length, 0, 'pending-action without visible tool-result should be excluded');
    });

    it('should handle multiple pending-actions with interleaved user messages', () => {
      let frames = [
        { id: 'f1', type: 'PendingAction', content: { toolName: 'a', toolUseID: 'tu_1' }, deleted: false, hidden: false },
        { id: 'f2', type: 'UserMessage', content: { text: 'msg1' }, deleted: false, hidden: false },
        { id: 'f3', type: 'ToolResult', content: { output: 'r1', toolUseID: 'tu_1' }, deleted: false, hidden: false },
        { id: 'f4', type: 'Message', content: { html: 'resp' }, deleted: false, hidden: false },
        { id: 'f5', type: 'PendingAction', content: { toolName: 'b', toolUseID: 'tu_2' }, deleted: false, hidden: false },
        { id: 'f6', type: 'UserMessage', content: { text: 'msg2' }, deleted: false, hidden: false },
        { id: 'f7', type: 'ToolResult', content: { output: 'r2', toolUseID: 'tu_2' }, deleted: false, hidden: false },
      ];

      let msgs = buildMessages(frames);

      // Expected: tool-call(1), tool-result(1), user-msg1, assistant, tool-call(2), tool-result(2), user-msg2
      assert.equal(msgs.length, 7);
      assert.equal(msgs[0].type, 'ToolCall');
      assert.equal(msgs[0].content.toolUseID, 'tu_1');
      assert.equal(msgs[1].type, 'ToolResult');
      assert.equal(msgs[1].content.toolUseID, 'tu_1');
      assert.equal(msgs[2].role, 'user');
      assert.equal(msgs[2].content, 'msg1');
      assert.equal(msgs[3].role, 'assistant');
      assert.equal(msgs[4].type, 'ToolCall');
      assert.equal(msgs[4].content.toolUseID, 'tu_2');
      assert.equal(msgs[5].type, 'ToolResult');
      assert.equal(msgs[5].content.toolUseID, 'tu_2');
      assert.equal(msgs[6].role, 'user');
      assert.equal(msgs[6].content, 'msg2');
    });
  });
});
