'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { truncateContent, truncateConversation } from '../../../src/core/interaction/context-truncation.mjs';
import { buildMessages } from '../../../src/core/interaction/message-history.mjs';

// =============================================================================
// Context Truncation Tests
// =============================================================================

describe('Context Truncation', () => {

  // ---------------------------------------------------------------------------
  // truncateContent — per-message truncation
  // ---------------------------------------------------------------------------

  describe('truncateContent', () => {

    it('should pass short content through unchanged', () => {
      let messages = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
      ];
      let result = truncateContent(messages);
      assert.deepEqual(result, messages);
    });

    it('should truncate long tool-result string with marker', () => {
      let longOutput = 'x'.repeat(10000);
      let messages   = [
        { type: 'tool-result', content: { output: longOutput, toolUseId: 'tu_1' } },
      ];
      let result = truncateContent(messages);
      assert.ok(result[0].content.output.length < longOutput.length);
      assert.ok(result[0].content.output.includes('[...content truncated'));
      assert.ok(result[0].content.output.includes('10000 characters'));
    });

    it('should truncate long tool-result object (JSON) with marker', () => {
      let largeObject = { data: 'y'.repeat(10000) };
      let messages    = [
        { type: 'tool-result', content: { output: largeObject, toolUseId: 'tu_1' } },
      ];
      let result         = truncateContent(messages);
      let expectedLength = JSON.stringify(largeObject).length;
      assert.ok(result[0].content.output.includes('[...content truncated'));
      assert.ok(result[0].content.output.includes(`${expectedLength} characters`));
    });

    it('should truncate long user message with marker', () => {
      let longText = 'a'.repeat(10000);
      let messages = [{ role: 'user', content: longText }];
      let result   = truncateContent(messages);
      assert.ok(result[0].content.length < longText.length);
      assert.ok(result[0].content.includes('[...content truncated'));
      assert.ok(result[0].content.includes('10000 characters'));
    });

    it('should truncate long assistant message with marker', () => {
      let longText = 'b'.repeat(10000);
      let messages = [{ role: 'assistant', content: longText }];
      let result   = truncateContent(messages);
      assert.ok(result[0].content.length < longText.length);
      assert.ok(result[0].content.includes('[...content truncated'));
    });

    it('should not truncate content at exact maxContentLength', () => {
      let exactText = 'c'.repeat(8000);
      let messages  = [{ role: 'user', content: exactText }];
      let result    = truncateContent(messages);
      assert.equal(result[0].content, exactText);
    });

    it('should truncate content at maxContentLength+1', () => {
      let overText = 'd'.repeat(8001);
      let messages = [{ role: 'user', content: overText }];
      let result   = truncateContent(messages);
      assert.ok(result[0].content.includes('[...content truncated'));
    });

    it('should handle empty content gracefully', () => {
      let messages = [
        { role: 'user', content: '' },
        { role: 'assistant', content: '' },
      ];
      let result = truncateContent(messages);
      assert.equal(result[0].content, '');
      assert.equal(result[1].content, '');
    });

    it('should handle null content gracefully', () => {
      let messages = [
        { role: 'user', content: null },
        { type: 'tool-result', content: { output: null } },
      ];
      let result = truncateContent(messages);
      assert.equal(result[0].content, null);
      assert.equal(result[1].content.output, null);
    });

    it('should handle undefined content gracefully', () => {
      let messages = [{ role: 'user' }];
      let result   = truncateContent(messages);
      assert.equal(result[0].content, undefined);
    });

    it('should handle missing content on tool-result gracefully', () => {
      let messages = [{ type: 'tool-result', content: null }];
      let result   = truncateContent(messages);
      assert.equal(result[0].content, null);
    });

    it('should use custom maxContentLength option', () => {
      let text     = 'e'.repeat(200);
      let messages = [{ role: 'user', content: text }];

      let resultDefault = truncateContent(messages);
      assert.equal(resultDefault[0].content, text); // 200 < 8000

      let resultCustom = truncateContent(messages, { maxContentLength: 100 });
      assert.ok(resultCustom[0].content.includes('[...content truncated'));
      assert.ok(resultCustom[0].content.includes('200 characters'));
    });

    it('should include original character count in marker', () => {
      let text     = 'f'.repeat(12345);
      let messages = [{ role: 'user', content: text }];
      let result   = truncateContent(messages, { maxContentLength: 100 });
      assert.ok(result[0].content.includes('12345 characters'));
    });

    it('should not mutate the original messages array', () => {
      let longText = 'g'.repeat(10000);
      let messages = [{ role: 'user', content: longText }];
      truncateContent(messages);
      assert.equal(messages[0].content, longText);
    });

    it('should not mutate original tool-result content object', () => {
      let longOutput = 'h'.repeat(10000);
      let original   = { output: longOutput, toolUseId: 'tu_1' };
      let messages   = [{ type: 'tool-result', content: original }];
      truncateContent(messages);
      assert.equal(original.output, longOutput);
    });

    it('should return empty array for empty input', () => {
      assert.deepEqual(truncateContent([]), []);
    });

    it('should return empty array for null input', () => {
      assert.deepEqual(truncateContent(null), []);
    });

    it('should return empty array for undefined input', () => {
      assert.deepEqual(truncateContent(undefined), []);
    });

    it('should preserve toolUseId on truncated tool-result', () => {
      let longOutput = 'i'.repeat(10000);
      let messages   = [
        { type: 'tool-result', content: { output: longOutput, toolUseId: 'tu_42' } },
      ];
      let result = truncateContent(messages);
      assert.equal(result[0].content.toolUseId, 'tu_42');
    });

    it('should not truncate tool-call messages', () => {
      let largeArguments = { data: 'j'.repeat(10000) };
      let messages       = [
        { type: 'tool-call', content: { toolName: 'test', arguments: largeArguments, toolUseId: 'tu_1' } },
      ];
      let result = truncateContent(messages);
      assert.deepEqual(result[0], messages[0]);
    });

    it('should preserve frameId and other metadata on truncated messages', () => {
      let longText = 'k'.repeat(10000);
      let messages = [
        { role: 'user', content: longText, frameId: 'frm_123', sourceAgentID: 'agent-A' },
      ];
      let result = truncateContent(messages);
      assert.equal(result[0].frameId, 'frm_123');
      assert.equal(result[0].sourceAgentID, 'agent-A');
    });

    it('should handle mixed message types in a single pass', () => {
      let longText   = 'l'.repeat(10000);
      let shortText  = 'short';
      let longOutput = 'm'.repeat(10000);

      let messages = [
        { role: 'user', content: longText },
        { role: 'assistant', content: shortText },
        { type: 'tool-call', content: { toolName: 'test', arguments: {}, toolUseId: 'tu_1' } },
        { type: 'tool-result', content: { output: longOutput, toolUseId: 'tu_1' } },
      ];

      let result = truncateContent(messages);
      assert.ok(result[0].content.includes('[...content truncated'));  // user truncated
      assert.equal(result[1].content, shortText);                      // assistant untouched
      assert.equal(result[2].type, 'tool-call');                       // tool-call untouched
      assert.ok(result[3].content.output.includes('[...content truncated')); // tool-result truncated
    });
  });

  // ---------------------------------------------------------------------------
  // truncateConversation — conversation-level truncation
  // ---------------------------------------------------------------------------

  describe('truncateConversation', () => {

    it('should pass under-budget conversation through unchanged', () => {
      let messages = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
      ];
      let result = truncateConversation(messages, { maxTotalChars: 100 });
      assert.deepEqual(result, messages);
    });

    it('should drop oldest messages first when over budget', () => {
      let messages = [
        { role: 'user', content: 'a'.repeat(100) },
        { role: 'assistant', content: 'b'.repeat(100) },
        { role: 'user', content: 'c'.repeat(100) },
        { role: 'assistant', content: 'd'.repeat(100) },
        { role: 'user', content: 'latest question' },
      ];

      let result = truncateConversation(messages, { maxTotalChars: 250 });
      // Should have dropped some oldest messages and added a marker
      assert.ok(result[0].content.includes('[Earlier conversation history was truncated'));
      assert.ok(result.length < messages.length + 1); // fewer than original + marker
      // The last user message must still be present
      let lastMessage = result[result.length - 1];
      assert.equal(lastMessage.content, 'latest question');
    });

    it('should prepend truncation marker with removed count', () => {
      let messages = [
        { role: 'user', content: 'a'.repeat(500) },
        { role: 'assistant', content: 'b'.repeat(500) },
        { role: 'user', content: 'final' },
      ];

      let result = truncateConversation(messages, { maxTotalChars: 100 });
      assert.equal(result[0].role, 'user');
      assert.ok(result[0].content.includes('messages removed'));
    });

    it('should never drop the last user message', () => {
      let longContent = 'x'.repeat(10000);
      let messages    = [
        { role: 'user', content: longContent },
      ];

      let result = truncateConversation(messages, { maxTotalChars: 100 });
      // Single message exceeding budget — must still be kept
      let hasUserMessage = result.some((message) => message.content === longContent);
      assert.ok(hasUserMessage, 'Last user message must be preserved');
    });

    it('should keep tool-call + tool-result pairs together', () => {
      let messages = [
        { role: 'user', content: 'a'.repeat(200) },
        { type: 'tool-call', content: { toolName: 'test', toolUseId: 'tu_1' } },
        { type: 'tool-result', content: { output: 'b'.repeat(200), toolUseId: 'tu_1' } },
        { role: 'assistant', content: 'c'.repeat(200) },
        { role: 'user', content: 'latest' },
      ];

      let result = truncateConversation(messages, { maxTotalChars: 300 });

      // Both tool-call and tool-result should be either both present or both absent
      let hasToolCall   = result.some((message) => message.type === 'tool-call');
      let hasToolResult = result.some((message) => message.type === 'tool-result');
      assert.equal(hasToolCall, hasToolResult, 'Tool-call and tool-result must be kept/dropped together');
    });

    it('should keep a single message that exceeds budget (not return empty)', () => {
      let hugeContent = 'z'.repeat(100000);
      let messages    = [
        { role: 'user', content: hugeContent },
      ];

      let result = truncateConversation(messages, { maxTotalChars: 100 });
      assert.ok(result.length > 0);
      let hasContent = result.some((message) => message.content === hugeContent);
      assert.ok(hasContent);
    });

    it('should show correct removed count in marker', () => {
      let messages = [
        { role: 'user', content: 'a'.repeat(200) },
        { role: 'assistant', content: 'b'.repeat(200) },
        { role: 'user', content: 'c'.repeat(200) },
        { role: 'assistant', content: 'd'.repeat(200) },
        { role: 'user', content: 'latest' },
      ];

      let result = truncateConversation(messages, { maxTotalChars: 250 });
      let marker = result[0].content;
      // Extract the count from the marker
      let match  = marker.match(/(\d+) messages removed/);
      assert.ok(match, 'Marker should include removed count');
      let removedCount = parseInt(match[1], 10);
      assert.ok(removedCount > 0);
      // Verify the count is consistent
      assert.equal(result.length, messages.length - removedCount + 1); // +1 for the marker
    });

    it('should use custom maxTotalChars option', () => {
      let messages = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
      ];

      // Under default budget — unchanged
      let resultDefault = truncateConversation(messages);
      assert.deepEqual(resultDefault, messages);

      // Under custom small budget — should truncate
      let resultSmall = truncateConversation(messages, { maxTotalChars: 5 });
      assert.ok(resultSmall[0].content.includes('[Earlier conversation'));
    });

    it('should return empty array for empty input', () => {
      assert.deepEqual(truncateConversation([]), []);
    });

    it('should return empty array for null input', () => {
      assert.deepEqual(truncateConversation(null), []);
    });

    it('should return empty array for undefined input', () => {
      assert.deepEqual(truncateConversation(undefined), []);
    });

    it('should not mutate the original messages array', () => {
      let messages = [
        { role: 'user', content: 'a'.repeat(200) },
        { role: 'assistant', content: 'b'.repeat(200) },
        { role: 'user', content: 'latest' },
      ];
      let originalLength = messages.length;
      truncateConversation(messages, { maxTotalChars: 100 });
      assert.equal(messages.length, originalLength);
    });

    it('should handle conversation with only tool messages', () => {
      let messages = [
        { type: 'tool-call', content: { toolName: 'test', toolUseId: 'tu_1' } },
        { type: 'tool-result', content: { output: 'a'.repeat(10000), toolUseId: 'tu_1' } },
      ];

      // Should not crash — even though there's no "last user message"
      let result = truncateConversation(messages, { maxTotalChars: 100 });
      assert.ok(Array.isArray(result));
    });

    it('should handle multiple tool pairs where some must be dropped', () => {
      let messages = [
        { role: 'user', content: 'start' },
        { type: 'tool-call', content: { toolName: 'tool1', toolUseId: 'tu_1' } },
        { type: 'tool-result', content: { output: 'a'.repeat(300), toolUseId: 'tu_1' } },
        { type: 'tool-call', content: { toolName: 'tool2', toolUseId: 'tu_2' } },
        { type: 'tool-result', content: { output: 'b'.repeat(300), toolUseId: 'tu_2' } },
        { role: 'assistant', content: 'response' },
        { role: 'user', content: 'followup' },
      ];

      let result = truncateConversation(messages, { maxTotalChars: 400 });
      // Verify pairs are consistent
      let toolCalls   = result.filter((message) => message.type === 'tool-call');
      let toolResults = result.filter((message) => message.type === 'tool-result');

      let callIds   = new Set(toolCalls.map((message) => message.content.toolUseId));
      let resultIds = new Set(toolResults.map((message) => message.content.toolUseId));

      // Every remaining tool-call should have a matching tool-result and vice versa
      for (let identifier of callIds)
        assert.ok(resultIds.has(identifier), `Tool-call ${identifier} missing its tool-result`);

      for (let identifier of resultIds)
        assert.ok(callIds.has(identifier), `Tool-result ${identifier} missing its tool-call`);
    });

    it('should preserve message order after truncation', () => {
      let messages = [
        { role: 'user', content: 'a'.repeat(200) },
        { role: 'assistant', content: 'b'.repeat(200) },
        { role: 'user', content: 'c'.repeat(200) },
        { role: 'assistant', content: 'd'.repeat(50) },
        { role: 'user', content: 'latest' },
      ];

      let result = truncateConversation(messages, { maxTotalChars: 300 });

      // Skip the marker (index 0), remaining should be in original order
      let remaining = result.slice(1);
      for (let i = 0; i < remaining.length - 1; i++) {
        let currentIndex  = messages.indexOf(remaining[i]);
        let nextIndex     = messages.indexOf(remaining[i + 1]);
        assert.ok(currentIndex < nextIndex, 'Messages should maintain original order');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Integration — pipeline: buildMessages → truncateContent → truncateConversation
  // ---------------------------------------------------------------------------

  describe('Integration', () => {

    it('should produce valid output through the full pipeline', () => {
      let frames = [
        { id: 'f1', type: 'user-message', content: { text: 'hello' }, deleted: false, hidden: false },
        { id: 'f2', type: 'message', content: { html: 'response' }, deleted: false, hidden: false },
        { id: 'f3', type: 'tool-call', content: { toolName: 'test', arguments: {}, toolUseId: 'tu_1' }, deleted: false, hidden: false },
        { id: 'f4', type: 'tool-result', content: { output: 'result', toolUseId: 'tu_1' }, deleted: false, hidden: false },
        { id: 'f5', type: 'user-message', content: { text: 'followup' }, deleted: false, hidden: false },
      ];

      let messages = buildMessages(frames);
      messages     = truncateContent(messages);
      messages     = truncateConversation(messages);

      assert.ok(Array.isArray(messages));
      assert.ok(messages.length > 0);
    });

    it('should cap massive tool-result then keep conversation under budget', () => {
      let hugeOutput = 'z'.repeat(50000);
      let frames     = [
        { id: 'f1', type: 'user-message', content: { text: 'start' }, deleted: false, hidden: false },
        { id: 'f2', type: 'message', content: { html: 'ok' }, deleted: false, hidden: false },
        { id: 'f3', type: 'tool-call', content: { toolName: 'shell', arguments: { command: 'ls /tmp/' }, toolUseId: 'tu_1' }, deleted: false, hidden: false },
        { id: 'f4', type: 'tool-result', content: { output: hugeOutput, toolUseId: 'tu_1' }, deleted: false, hidden: false },
        { id: 'f5', type: 'message', content: { html: 'done' }, deleted: false, hidden: false },
        { id: 'f6', type: 'user-message', content: { text: 'what happened?' }, deleted: false, hidden: false },
      ];

      let messages = buildMessages(frames);
      messages     = truncateContent(messages);
      messages     = truncateConversation(messages);

      // The huge tool-result should have been truncated per-message
      let toolResults = messages.filter((message) => message.type === 'tool-result');
      for (let toolResult of toolResults)
        assert.ok(toolResult.content.output.length <= 8000 + 100, 'Tool result should be capped'); // 8000 + marker overhead

      // Total chars should be within budget
      let totalChars = 0;
      for (let message of messages) {
        if (message.type === 'tool-result')
          totalChars += (message.content.output || '').length;
        else if (typeof message.content === 'string')
          totalChars += message.content.length;
      }
      assert.ok(totalChars <= 600000, 'Total should be under default budget');
    });

    it('should handle an empty session gracefully through the pipeline', () => {
      let messages = buildMessages([]);
      messages     = truncateContent(messages);
      messages     = truncateConversation(messages);
      assert.deepEqual(messages, []);
    });

    it('should preserve last user message through aggressive truncation', () => {
      let frames = [];
      // Generate many frames to exceed budget
      for (let i = 0; i < 20; i++) {
        frames.push({
          id: `f${i * 2}`, type: 'user-message',
          content: { text: `message-${i}-${'x'.repeat(500)}` },
          deleted: false, hidden: false,
        });
        frames.push({
          id: `f${i * 2 + 1}`, type: 'message',
          content: { html: `response-${i}-${'y'.repeat(500)}` },
          deleted: false, hidden: false,
        });
      }
      // Add final user message
      frames.push({
        id: 'f_last', type: 'user-message',
        content: { text: 'the final question' },
        deleted: false, hidden: false,
      });

      let messages = buildMessages(frames);
      messages     = truncateContent(messages);
      messages     = truncateConversation(messages, { maxTotalChars: 2000 });

      let lastUserMessage = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user' && !messages[i].content.includes('[Earlier conversation')) {
          lastUserMessage = messages[i];
          break;
        }
      }

      assert.ok(lastUserMessage, 'Last user message must exist');
      assert.equal(lastUserMessage.content, 'the final question');
    });
  });
});
