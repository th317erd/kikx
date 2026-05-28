'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { reinjectBehaviors } from '../../../src/core/interaction/behaviors-reinjection.mjs';

// =============================================================================
// Step 3 — Post-Truncation Behaviors Re-injection Tests
// =============================================================================

// Helper: build a truncation marker message (matches truncateConversation output)
function truncationMarker(count = 5) {
  return {
    role:    'user',
    content: `[Earlier conversation history was truncated. ${count} messages removed.]`,
  };
}

// Helper: build a fake agent with behaviors (async methods)
function agentWithBehaviors(text) {
  return {
    id:           'agt_test',
    hasBehaviors: async () => true,
    getBehaviors: async () => text,
  };
}

// Helper: build a fake agent without behaviors (async methods)
function agentWithoutBehaviors() {
  return {
    id:           'agt_test',
    hasBehaviors: async () => false,
    getBehaviors: async () => null,
  };
}

describe('reinjectBehaviors (Step 3)', () => {

  // ---------------------------------------------------------------------------
  // Truncation occurred + agent has behaviors => re-inject
  // ---------------------------------------------------------------------------

  describe('when truncation occurred and agent has behaviors', () => {
    it('should concatenate behaviors text onto the first user message', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Hello agent' },
        { role: 'assistant', content: 'Hi there' },
      ];

      let agent  = agentWithBehaviors('Never deploy on Fridays.');
      let result = await reinjectBehaviors(messages, agent);

      assert.ok(result[1].content.includes('Hello agent'));
      assert.ok(result[1].content.includes('Never deploy on Fridays.'));
    });

    it('should use --- BEHAVIORS --- / --- END BEHAVIORS --- delimiters', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Help me' },
      ];

      let agent  = agentWithBehaviors('Rule 1: Check tests.');
      let result = await reinjectBehaviors(messages, agent);

      assert.ok(result[1].content.includes('--- BEHAVIORS ---'));
      assert.ok(result[1].content.includes('--- END BEHAVIORS ---'));
    });

    it('should include the behaviors mandate after the behaviors block', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Question?' },
      ];

      let agent  = agentWithBehaviors('Some behavior.');
      let result = await reinjectBehaviors(messages, agent);

      assert.ok(result[1].content.includes('BEHAVIORS ARE MANDATORY'));
      assert.ok(result[1].content.includes('behaviors override your default behavior'));
    });

    it('should format the behaviors block correctly', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Original message' },
      ];

      let agent  = agentWithBehaviors('Rule A\nRule B');
      let result = await reinjectBehaviors(messages, agent);

      assert.ok(result[1].content.includes('--- BEHAVIORS ---\nRule A\nRule B\n--- END BEHAVIORS ---'));
      assert.ok(result[1].content.includes('BEHAVIORS ARE MANDATORY'));
    });

    it('should inject into the first user message even if truncation marker is also user role', async () => {
      let messages = [
        truncationMarker(),
        { role: 'assistant', content: 'Resumed conversation.' },
        { role: 'user', content: 'Continue please' },
      ];

      let agent  = agentWithBehaviors('Behavior text.');
      let result = await reinjectBehaviors(messages, agent);

      // Truncation marker should be untouched
      assert.ok(result[0].content.startsWith('[Earlier conversation'));
      assert.ok(!result[0].content.includes('--- BEHAVIORS ---'));

      // The non-marker user message gets the injection
      assert.ok(result[2].content.includes('Behavior text.'));
      assert.ok(result[2].content.includes('Continue please'));
    });
  });

  // ---------------------------------------------------------------------------
  // Truncation occurred + agent has NO behaviors => unchanged
  // ---------------------------------------------------------------------------

  describe('when truncation occurred but agent has no behaviors', () => {
    it('should return messages unchanged', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Hello' },
      ];

      let agent  = agentWithoutBehaviors();
      let result = await reinjectBehaviors(messages, agent);

      assert.equal(result[1].content, 'Hello');
      assert.ok(!result[1].content.includes('--- BEHAVIORS ---'));
    });
  });

  // ---------------------------------------------------------------------------
  // No truncation occurred => unchanged
  // ---------------------------------------------------------------------------

  describe('when no truncation occurred', () => {
    it('should return messages unchanged', async () => {
      let messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ];

      let agent  = agentWithBehaviors('Some behavior.');
      let result = await reinjectBehaviors(messages, agent);

      assert.equal(result[0].content, 'Hello');
      assert.ok(!result[0].content.includes('--- BEHAVIORS ---'));
    });

    it('should return messages unchanged even with many messages', async () => {
      let messages = [
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: 'Response' },
        { role: 'user', content: 'Second message' },
        { role: 'assistant', content: 'Another response' },
      ];

      let agent  = agentWithBehaviors('Behavior text.');
      let result = await reinjectBehaviors(messages, agent);

      for (let i = 0; i < result.length; i++)
        assert.equal(result[i].content, messages[i].content);
    });
  });

  // ---------------------------------------------------------------------------
  // Primer already injected this turn => unchanged (no double-injection)
  // ---------------------------------------------------------------------------

  describe('when primer is already being injected this turn', () => {
    it('should return messages unchanged when primerInjected is true', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Hello' },
      ];

      let agent  = agentWithBehaviors('Some behavior.');
      let result = await reinjectBehaviors(messages, agent, { primerInjected: true });

      assert.equal(result[1].content, 'Hello');
      assert.ok(!result[1].content.includes('--- BEHAVIORS ---'));
    });

    it('should inject when primerInjected is false', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Hello' },
      ];

      let agent  = agentWithBehaviors('Some behavior.');
      let result = await reinjectBehaviors(messages, agent, { primerInjected: false });

      assert.ok(result[1].content.includes('--- BEHAVIORS ---'));
      assert.ok(result[1].content.includes('Some behavior.'));
    });

    it('should inject when primerInjected is not provided', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Hello' },
      ];

      let agent  = agentWithBehaviors('Some behavior.');
      let result = await reinjectBehaviors(messages, agent);

      assert.ok(result[1].content.includes('--- BEHAVIORS ---'));
    });
  });

  // ---------------------------------------------------------------------------
  // Null/missing agent => unchanged
  // ---------------------------------------------------------------------------

  describe('when agent is null or undefined', () => {
    it('should return messages unchanged when agent is null', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Hello' },
      ];

      let result = await reinjectBehaviors(messages, null);

      assert.equal(result[1].content, 'Hello');
    });

    it('should return messages unchanged when agent is undefined', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Hello' },
      ];

      let result = await reinjectBehaviors(messages, undefined);

      assert.equal(result[1].content, 'Hello');
    });

    it('should return messages unchanged when agent is a plain object without hasBehaviors method', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Hello' },
      ];

      let agent  = { id: 'agt_plain', name: 'Plain Agent' };
      let result = await reinjectBehaviors(messages, agent);

      assert.equal(result[1].content, 'Hello');
      assert.ok(!result[1].content.includes('--- BEHAVIORS ---'));
    });
  });

  // ---------------------------------------------------------------------------
  // DM session exclusion
  // ---------------------------------------------------------------------------

  describe('when isDMForAgent returns true', () => {
    it('should skip re-injection in DM sessions', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Hello' },
      ];

      let agent  = agentWithBehaviors('Some behavior.');
      let result = await reinjectBehaviors(messages, agent, {
        isDMForAgent: async () => true,
      });

      assert.equal(result[1].content, 'Hello');
      assert.ok(!result[1].content.includes('--- BEHAVIORS ---'));
    });

    it('should inject normally when isDMForAgent returns false', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Hello' },
      ];

      let agent  = agentWithBehaviors('Some behavior.');
      let result = await reinjectBehaviors(messages, agent, {
        isDMForAgent: async () => false,
      });

      assert.ok(result[1].content.includes('--- BEHAVIORS ---'));
    });

    it('should inject normally when isDMForAgent is not provided', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Hello' },
      ];

      let agent  = agentWithBehaviors('Some behavior.');
      let result = await reinjectBehaviors(messages, agent);

      assert.ok(result[1].content.includes('--- BEHAVIORS ---'));
    });
  });

  // ---------------------------------------------------------------------------
  // Does not mutate input
  // ---------------------------------------------------------------------------

  describe('immutability', () => {
    it('should not mutate the original messages array', async () => {
      let originalMessage = { role: 'user', content: 'Hello' };
      let messages        = [truncationMarker(), originalMessage];

      let agent = agentWithBehaviors('Some behavior.');
      await reinjectBehaviors(messages, agent);

      assert.equal(originalMessage.content, 'Hello');
      assert.equal(messages.length, 2);
    });

    it('should return a new array reference', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Hello' },
      ];

      let agent  = agentWithBehaviors('Some behavior.');
      let result = await reinjectBehaviors(messages, agent);

      assert.notEqual(result, messages);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should handle empty messages array', async () => {
      let agent  = agentWithBehaviors('Some behavior.');
      let result = await reinjectBehaviors([], agent);

      assert.deepEqual(result, []);
    });

    it('should handle null messages', async () => {
      let agent  = agentWithBehaviors('Some behavior.');
      let result = await reinjectBehaviors(null, agent);

      assert.deepEqual(result, []);
    });

    it('should handle undefined messages', async () => {
      let agent  = agentWithBehaviors('Some behavior.');
      let result = await reinjectBehaviors(undefined, agent);

      assert.deepEqual(result, []);
    });

    it('should handle truncation marker with no following user message', async () => {
      let messages = [
        truncationMarker(),
        { role: 'assistant', content: 'Some response' },
      ];

      let agent  = agentWithBehaviors('Some behavior.');
      let result = await reinjectBehaviors(messages, agent);

      // No user message to inject into, so nothing changes
      assert.equal(result.length, 2);
      assert.ok(!result[0].content.includes('--- BEHAVIORS ---'));
      assert.ok(!result[1].content.includes('--- BEHAVIORS ---'));
    });

    it('should handle user message with null content after truncation', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: null },
      ];

      let agent  = agentWithBehaviors('Some behavior.');
      let result = await reinjectBehaviors(messages, agent);

      assert.ok(result[1].content.includes('--- BEHAVIORS ---'));
      assert.ok(result[1].content.includes('Some behavior.'));
    });

    it('should handle user message with empty string content after truncation', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: '' },
      ];

      let agent  = agentWithBehaviors('Some behavior.');
      let result = await reinjectBehaviors(messages, agent);

      assert.ok(result[1].content.includes('--- BEHAVIORS ---'));
      assert.ok(result[1].content.includes('Some behavior.'));
    });

    it('should handle agent with hasBehaviors returning true but getBehaviors returning empty string', async () => {
      let agent = {
        id:           'agt_test',
        hasBehaviors: async () => true,
        getBehaviors: async () => '',
      };

      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Hello' },
      ];

      let result = await reinjectBehaviors(messages, agent);

      // hasBehaviors() is true, so we proceed — getBehaviors returns empty string
      // The function should still inject the block with the empty content
      assert.ok(result[1].content.includes('--- BEHAVIORS ---'));
    });

    it('should only inject into the first non-marker user message', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'First user msg' },
        { role: 'user', content: 'Second user msg' },
      ];

      let agent  = agentWithBehaviors('Some behavior.');
      let result = await reinjectBehaviors(messages, agent);

      assert.ok(result[1].content.includes('--- BEHAVIORS ---'));
      assert.ok(!result[2].content.includes('--- BEHAVIORS ---'));
      assert.equal(result[2].content, 'Second user msg');
    });

    it('should detect truncation marker regardless of message count in marker text', async () => {
      let messages = [
        { role: 'user', content: '[Earlier conversation history was truncated. 42 messages removed.]' },
        { role: 'user', content: 'Hello' },
      ];

      let agent  = agentWithBehaviors('Some behavior.');
      let result = await reinjectBehaviors(messages, agent);

      assert.ok(result[1].content.includes('--- BEHAVIORS ---'));
    });
  });
});
