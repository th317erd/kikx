'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { reinjectInstructions } from '../../src/core/interaction/instructions-reinjection.mjs';

// =============================================================================
// Instructions Re-injection Tests
// =============================================================================

const TRUNCATION_MARKER = '[Earlier conversation history was truncated to fit within the context window.]';

function makeAgent(instructions) {
  return { id: 'agt_test', name: 'test-agent', instructions };
}

function markerMessage() {
  return { role: 'user', content: TRUNCATION_MARKER };
}

function userMessage(content = 'Hello, how are you?') {
  return { role: 'user', content };
}

function assistantMessage(content = 'I am fine, thanks.') {
  return { role: 'assistant', content };
}

describe('reinjectInstructions', () => {

  // ---------------------------------------------------------------------------
  // No-op / early-return conditions
  // ---------------------------------------------------------------------------

  describe('early returns (no injection)', () => {

    it('should return empty array when messages is null', () => {
      let result = reinjectInstructions(null, makeAgent('Be helpful'));
      assert.deepStrictEqual(result, []);
    });

    it('should return empty array when messages is undefined', () => {
      let result = reinjectInstructions(undefined, makeAgent('Be helpful'));
      assert.deepStrictEqual(result, []);
    });

    it('should return empty array when messages is an empty array', () => {
      let result = reinjectInstructions([], makeAgent('Be helpful'));
      assert.deepStrictEqual(result, []);
    });

    it('should return messages unchanged when primerInjected is true', () => {
      let messages = [
        markerMessage(),
        userMessage(),
      ];
      let result = reinjectInstructions(messages, makeAgent('Be helpful'), { primerInjected: true });
      assert.strictEqual(result, messages); // same reference — no copy needed
    });

    it('should return messages unchanged when agent is null', () => {
      let messages = [markerMessage(), userMessage()];
      let result = reinjectInstructions(messages, null);
      assert.strictEqual(result, messages);
    });

    it('should return messages unchanged when agent is undefined', () => {
      let messages = [markerMessage(), userMessage()];
      let result = reinjectInstructions(messages, undefined);
      assert.strictEqual(result, messages);
    });

    it('should return messages unchanged when agent.instructions is empty string', () => {
      let messages = [markerMessage(), userMessage()];
      let result = reinjectInstructions(messages, makeAgent(''));
      assert.strictEqual(result, messages);
    });

    it('should return messages unchanged when agent.instructions is null', () => {
      let messages = [markerMessage(), userMessage()];
      let result = reinjectInstructions(messages, { id: 'agt_test', instructions: null });
      assert.strictEqual(result, messages);
    });

    it('should return messages unchanged when agent.instructions is undefined', () => {
      let messages = [markerMessage(), userMessage()];
      let result = reinjectInstructions(messages, { id: 'agt_test' });
      assert.strictEqual(result, messages);
    });

    it('should return messages unchanged when no truncation marker is present', () => {
      let messages = [
        userMessage('Hi there'),
        assistantMessage('Hello!'),
        userMessage('How do you work?'),
      ];
      let result = reinjectInstructions(messages, makeAgent('Be helpful'));
      assert.strictEqual(result, messages);
    });

    it('should return messages unchanged when only assistant messages follow the marker', () => {
      let messages = [
        markerMessage(),
        assistantMessage('I was saying...'),
      ];
      let result = reinjectInstructions(messages, makeAgent('Be helpful'));
      assert.strictEqual(result, messages);
    });

    it('should return messages unchanged when only marker user messages exist', () => {
      let messages = [
        markerMessage(),
      ];
      let result = reinjectInstructions(messages, makeAgent('Be helpful'));
      assert.strictEqual(result, messages);
    });
  });

  // ---------------------------------------------------------------------------
  // Synchronous behavior
  // ---------------------------------------------------------------------------

  describe('synchronous behavior', () => {

    it('should return a value synchronously (not a Promise)', () => {
      let messages = [markerMessage(), userMessage()];
      let result = reinjectInstructions(messages, makeAgent('Be helpful'));
      // If it returned a Promise, this would fail
      assert.ok(Array.isArray(result), 'Expected result to be an array, not a Promise');
      assert.ok(!(result instanceof Promise), 'Result must not be a Promise');
    });
  });

  // ---------------------------------------------------------------------------
  // Non-mutation verification
  // ---------------------------------------------------------------------------

  describe('non-mutation', () => {

    it('should not mutate the original messages array', () => {
      let messages = [
        markerMessage(),
        userMessage('Original content'),
        assistantMessage(),
      ];
      let originalLength = messages.length;
      let originalContent = messages[1].content;

      let result = reinjectInstructions(messages, makeAgent('Be helpful'));

      // Original array untouched
      assert.strictEqual(messages.length, originalLength);
      assert.strictEqual(messages[1].content, originalContent);

      // Result is a different array reference
      assert.notStrictEqual(result, messages);
    });

    it('should not mutate the target message object', () => {
      let targetMsg = userMessage('My question');
      let messages = [markerMessage(), targetMsg];

      reinjectInstructions(messages, makeAgent('Be helpful'));

      assert.strictEqual(targetMsg.content, 'My question');
    });

    it('should preserve references for non-target messages', () => {
      let msg0 = markerMessage();
      let msg2 = assistantMessage('response');
      let messages = [msg0, userMessage('question'), msg2];

      let result = reinjectInstructions(messages, makeAgent('Instructions'));

      // Non-target messages should be the same object references
      assert.strictEqual(result[0], msg0);
      assert.strictEqual(result[2], msg2);
    });
  });

  // ---------------------------------------------------------------------------
  // Happy path — instructions injection
  // ---------------------------------------------------------------------------

  describe('injection behavior', () => {

    it('should inject instructions into the first non-marker user message', () => {
      let messages = [
        markerMessage(),
        userMessage('Hello agent'),
      ];

      let result = reinjectInstructions(messages, makeAgent('You are a friendly assistant.'));

      assert.ok(result[1].content.includes('Hello agent'));
      assert.ok(result[1].content.includes('--- INSTRUCTIONS ---'));
      assert.ok(result[1].content.includes('You are a friendly assistant.'));
      assert.ok(result[1].content.includes('--- END INSTRUCTIONS ---'));
    });

    it('should include the mandatory compliance text after the instructions block', () => {
      let messages = [markerMessage(), userMessage('test')];
      let result = reinjectInstructions(messages, makeAgent('My instructions'));

      assert.ok(result[1].content.includes('INSTRUCTIONS ARE MANDATORY'));
      assert.ok(result[1].content.includes('You MUST follow the instructions above'));
    });

    it('should append instructions after the original content separated by double newline', () => {
      let messages = [markerMessage(), userMessage('Original text')];
      let result = reinjectInstructions(messages, makeAgent('Do stuff'));

      // The content should start with the original text
      assert.ok(result[1].content.startsWith('Original text'));

      // The instructions block follows after \n\n
      let idx = result[1].content.indexOf('\n\n--- INSTRUCTIONS ---');
      assert.ok(idx > 0, 'Instructions block should be separated by double newline');
    });

    it('should inject into first non-marker user message when multiple user messages exist', () => {
      let messages = [
        markerMessage(),
        userMessage('First user message'),
        assistantMessage('Some response'),
        userMessage('Second user message'),
      ];

      let result = reinjectInstructions(messages, makeAgent('My rules'));

      // First user message (index 1) gets the injection
      assert.ok(result[1].content.includes('--- INSTRUCTIONS ---'));
      assert.ok(result[1].content.includes('My rules'));

      // Second user message (index 3) should remain untouched
      assert.strictEqual(result[3].content, 'Second user message');
    });

    it('should skip assistant messages when looking for the first user message', () => {
      let messages = [
        markerMessage(),
        assistantMessage('I was responding earlier'),
        assistantMessage('Continuing...'),
        userMessage('User follow-up'),
      ];

      let result = reinjectInstructions(messages, makeAgent('Be concise'));

      // Assistants untouched
      assert.strictEqual(result[1].content, 'I was responding earlier');
      assert.strictEqual(result[2].content, 'Continuing...');

      // User message gets injection
      assert.ok(result[3].content.includes('--- INSTRUCTIONS ---'));
      assert.ok(result[3].content.includes('Be concise'));
    });

    it('should handle user message with empty string content', () => {
      let messages = [
        markerMessage(),
        { role: 'user', content: '' },
      ];

      let result = reinjectInstructions(messages, makeAgent('Be kind'));

      // Empty string + \n\n + block => should start with \n\n---
      assert.ok(result[1].content.includes('--- INSTRUCTIONS ---'));
      assert.ok(result[1].content.includes('Be kind'));
    });

    it('should handle user message with undefined content (treated as empty)', () => {
      let messages = [
        markerMessage(),
        { role: 'user' }, // no content property
      ];

      let result = reinjectInstructions(messages, makeAgent('Be kind'));

      assert.ok(result[1].content.includes('--- INSTRUCTIONS ---'));
      assert.ok(result[1].content.includes('Be kind'));
    });

    it('should preserve the result array length', () => {
      let messages = [
        markerMessage(),
        userMessage('q'),
        assistantMessage('a'),
      ];

      let result = reinjectInstructions(messages, makeAgent('Rules'));
      assert.strictEqual(result.length, messages.length);
    });
  });

  // ---------------------------------------------------------------------------
  // Truncation marker at various positions
  // ---------------------------------------------------------------------------

  describe('truncation marker positioning', () => {

    it('should work when truncation marker is the first message', () => {
      let messages = [
        markerMessage(),
        userMessage('After truncation'),
      ];

      let result = reinjectInstructions(messages, makeAgent('Rules'));
      assert.ok(result[1].content.includes('--- INSTRUCTIONS ---'));
    });

    it('should work when truncation marker is in the middle of the array', () => {
      // This is an unusual case but tests robustness
      let messages = [
        userMessage('Before truncation'),
        markerMessage(),
        userMessage('After truncation'),
      ];

      let result = reinjectInstructions(messages, makeAgent('Rules'));

      // The first non-marker user message is at index 0 (before the marker)
      assert.ok(result[0].content.includes('--- INSTRUCTIONS ---'));
      // The second user message should be untouched
      assert.strictEqual(result[2].content, 'After truncation');
    });

    it('should work when truncation marker is the last message', () => {
      let messages = [
        userMessage('Real content'),
        assistantMessage('Response'),
        markerMessage(),
      ];

      let result = reinjectInstructions(messages, makeAgent('Rules'));

      // First non-marker user message is at index 0
      assert.ok(result[0].content.includes('--- INSTRUCTIONS ---'));
    });

    it('should handle multiple truncation markers', () => {
      let messages = [
        markerMessage(),
        markerMessage(), // second marker
        userMessage('Finally a real message'),
      ];

      let result = reinjectInstructions(messages, makeAgent('Rules'));
      assert.ok(result[2].content.includes('--- INSTRUCTIONS ---'));
      // Markers should be left alone
      assert.strictEqual(result[0].content, TRUNCATION_MARKER);
      assert.strictEqual(result[1].content, TRUNCATION_MARKER);
    });
  });

  // ---------------------------------------------------------------------------
  // Truncation marker variations
  // ---------------------------------------------------------------------------

  describe('truncation marker detection', () => {

    it('should detect a marker with different trailing text', () => {
      let messages = [
        { role: 'user', content: '[Earlier conversation history was truncated due to length limits.]' },
        userMessage('Hello'),
      ];

      let result = reinjectInstructions(messages, makeAgent('Rules'));
      assert.ok(result[1].content.includes('--- INSTRUCTIONS ---'));
    });

    it('should NOT treat a non-user role message with marker text as a truncation marker', () => {
      let messages = [
        { role: 'assistant', content: TRUNCATION_MARKER },
        userMessage('Hello'),
      ];

      // No truncation marker detected (it is an assistant message), so no injection
      let result = reinjectInstructions(messages, makeAgent('Rules'));
      assert.strictEqual(result, messages);
    });

    it('should NOT detect marker if content is a non-string type', () => {
      let messages = [
        { role: 'user', content: 12345 },
        userMessage('Hello'),
      ];

      // The numeric content does not start with the marker prefix
      let result = reinjectInstructions(messages, makeAgent('Rules'));
      assert.strictEqual(result, messages);
    });

    it('should NOT treat partial marker prefix as a truncation marker', () => {
      let messages = [
        { role: 'user', content: '[Earlier conversation' }, // incomplete prefix
        userMessage('Hello'),
      ];

      let result = reinjectInstructions(messages, makeAgent('Rules'));
      // No injection because the prefix does not match
      assert.strictEqual(result, messages);
    });
  });

  // ---------------------------------------------------------------------------
  // Options handling
  // ---------------------------------------------------------------------------

  describe('options handling', () => {

    it('should default options to empty object when not provided', () => {
      let messages = [markerMessage(), userMessage('Hi')];

      // Should not throw when options is omitted
      let result = reinjectInstructions(messages, makeAgent('Rules'));
      assert.ok(result[1].content.includes('--- INSTRUCTIONS ---'));
    });

    it('should inject when primerInjected is false', () => {
      let messages = [markerMessage(), userMessage('Hi')];
      let result = reinjectInstructions(messages, makeAgent('Rules'), { primerInjected: false });
      assert.ok(result[1].content.includes('--- INSTRUCTIONS ---'));
    });

    it('should inject when primerInjected is falsy but not strictly true', () => {
      let messages = [markerMessage(), userMessage('Hi')];

      // 0, null, undefined, '' are all falsy — should still inject
      for (let falsyValue of [0, null, undefined, '', false]) {
        let result = reinjectInstructions(messages, makeAgent('Rules'), { primerInjected: falsyValue });
        assert.ok(
          result[1].content.includes('--- INSTRUCTIONS ---'),
          `Expected injection when primerInjected is ${JSON.stringify(falsyValue)}`
        );
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Instructions block structure
  // ---------------------------------------------------------------------------

  describe('instructions block format', () => {

    it('should wrap instructions with correct delimiters', () => {
      let instructions = 'You are a pirate. Always say "Arrr".';
      let messages = [markerMessage(), userMessage('Talk to me')];
      let result = reinjectInstructions(messages, makeAgent(instructions));

      let content = result[1].content;

      // Check delimiter order
      let startIdx = content.indexOf('--- INSTRUCTIONS ---');
      let textIdx  = content.indexOf(instructions);
      let endIdx   = content.indexOf('--- END INSTRUCTIONS ---');

      assert.ok(startIdx >= 0, 'Start delimiter missing');
      assert.ok(textIdx > startIdx, 'Instructions text should follow start delimiter');
      assert.ok(endIdx > textIdx, 'End delimiter should follow instructions text');
    });

    it('should preserve multiline instructions', () => {
      let instructions = 'Line one.\nLine two.\nLine three.';
      let messages = [markerMessage(), userMessage('Go')];
      let result = reinjectInstructions(messages, makeAgent(instructions));

      assert.ok(result[1].content.includes('Line one.\nLine two.\nLine three.'));
    });

    it('should preserve instructions with special characters', () => {
      let instructions = 'Use $variables, {braces}, and "quotes" freely.';
      let messages = [markerMessage(), userMessage('Go')];
      let result = reinjectInstructions(messages, makeAgent(instructions));

      assert.ok(result[1].content.includes(instructions));
    });
  });
});
