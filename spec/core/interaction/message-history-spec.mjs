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
      let frames = [{ type: 'user-message', deleted: false, hidden: false }];
      assert.equal(isFirstMessage(frames), true);
    });

    it('should return false after assistant message exists', () => {
      let frames = [
        { type: 'user-message', deleted: false, hidden: false },
        { type: 'message', deleted: false, hidden: false },
      ];
      assert.equal(isFirstMessage(frames), false);
    });

    it('should return false when multiple user messages exist', () => {
      let frames = [
        { type: 'user-message', deleted: false, hidden: false },
        { type: 'user-message', deleted: false, hidden: false },
      ];
      assert.equal(isFirstMessage(frames), false);
    });

    it('should ignore deleted frames', () => {
      let frames = [
        { type: 'user-message', deleted: true, hidden: false },
        { type: 'user-message', deleted: false, hidden: false },
      ];
      assert.equal(isFirstMessage(frames), true);
    });

    it('should ignore hidden frames', () => {
      let frames = [
        { type: 'user-message', deleted: false, hidden: true },
        { type: 'user-message', deleted: false, hidden: false },
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
        { id: 'f1', type: 'user-message', content: { text: 'hello' }, deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames);
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].role, 'user');
      assert.equal(msgs[0].content, 'hello');
    });

    it('should convert message frames to assistant role', () => {
      let frames = [
        { id: 'f1', type: 'message', content: { html: '<p>hi</p>' }, deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames);
      assert.equal(msgs[0].role, 'assistant');
      assert.equal(msgs[0].content, '<p>hi</p>');
    });

    it('should exclude deleted frames', () => {
      let frames = [
        { id: 'f1', type: 'user-message', content: { text: 'hello' }, deleted: true, hidden: false },
      ];
      assert.deepEqual(buildMessages(frames), []);
    });

    it('should exclude hidden frames', () => {
      let frames = [
        { id: 'f1', type: 'user-message', content: { text: 'hello' }, deleted: false, hidden: true },
      ];
      assert.deepEqual(buildMessages(frames), []);
    });

    it('should exclude system frame types', () => {
      let excludedTypes = [
        'permission-request', 'permission-denied', 'hook-blocked',
        'tool-error', 'error', 'reflection', 'command-result', 'stop',
      ];

      for (let type of excludedTypes) {
        let frames = [{ id: 'f1', type, content: {}, deleted: false, hidden: false }];
        let msgs   = buildMessages(frames);
        assert.equal(msgs.length, 0, `${type} should be excluded`);
      }
    });

    it('should include tool-call frames', () => {
      let frames = [
        { id: 'f1', type: 'tool-call', content: { toolName: 'test', arguments: {} }, deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames);
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].type, 'tool-call');
    });

    it('should include tool-result frames', () => {
      let frames = [
        { id: 'f1', type: 'tool-result', content: { output: 'ok' }, deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames);
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].type, 'tool-result');
    });

    it('should include resolved pending-action frames as tool-calls', () => {
      let frames = [
        { id: 'f1', type: 'pending-action', content: { toolName: 'test', toolUseID: 'tu_1' }, deleted: false, hidden: false },
        { id: 'f2', type: 'tool-result', content: { output: 'ok', toolUseID: 'tu_1' }, deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames);
      assert.equal(msgs.length, 2);
      assert.equal(msgs[0].type, 'tool-call');
    });

    it('should exclude unresolved pending-action frames', () => {
      let frames = [
        { id: 'f1', type: 'pending-action', content: { toolName: 'test', toolUseID: 'tu_1' }, deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames);
      assert.equal(msgs.length, 0);
    });

    // Multi-agent attribution
    it('should wrap other agents messages as user role with XML tag', () => {
      let frames = [
        { id: 'f1', type: 'message', content: { html: 'hello' }, authorID: 'agent-B', deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames, 'agent-A');
      assert.equal(msgs[0].role, 'user');
      assert.ok(msgs[0].content.includes('<agent-message'));
      assert.ok(msgs[0].content.includes('source="agent-B"'));
    });

    it('should keep own messages as assistant role in multi-agent', () => {
      let frames = [
        { id: 'f1', type: 'message', content: { html: 'hello' }, authorID: 'agent-A', deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames, 'agent-A');
      assert.equal(msgs[0].role, 'assistant');
    });

    it('should handle frames with missing content gracefully', () => {
      let frames = [
        { id: 'f1', type: 'user-message', content: null, deleted: false, hidden: false },
        { id: 'f2', type: 'message', content: null, deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames);
      assert.equal(msgs.length, 2);
      assert.equal(msgs[0].content, '');
      assert.equal(msgs[1].content, '');
    });

    // Markdown-converted user messages (content.html instead of content.text)
    it('should use content.html for user-message frames when available', () => {
      let frames = [
        { id: 'f1', type: 'user-message', content: { html: '<p>hello</p>' }, deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames);
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].role, 'user');
      assert.equal(msgs[0].content, '<p>hello</p>');
    });

    it('should prefer content.html over content.text for user-message frames', () => {
      let frames = [
        { id: 'f1', type: 'user-message', content: { html: '<p>converted</p>', text: 'original' }, deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames);
      assert.equal(msgs[0].content, '<p>converted</p>');
    });

    it('should fall back to content.text when content.html is absent for user-message', () => {
      let frames = [
        { id: 'f1', type: 'user-message', content: { text: 'plain text' }, deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames);
      assert.equal(msgs[0].content, 'plain text');
    });

    it('should handle user-message with empty html string', () => {
      let frames = [
        { id: 'f1', type: 'user-message', content: { html: '', text: 'fallback' }, deleted: false, hidden: false },
      ];
      let msgs = buildMessages(frames);
      // Empty html is falsy, should fall back to text
      assert.equal(msgs[0].content, 'fallback');
    });
  });
});
