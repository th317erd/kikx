'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { reinjectAbilities } from '../../../src/core/interaction/abilities-reinjection.mjs';

// =============================================================================
// Step 3 — Post-Truncation Abilities Re-injection Tests
// =============================================================================

// Helper: build a truncation marker message (matches truncateConversation output)
function truncationMarker(count = 5) {
  return {
    role:    'user',
    content: `[Earlier conversation history was truncated. ${count} messages removed.]`,
  };
}

// Helper: build a fake agent with abilities (async methods)
function agentWithAbilities(text) {
  return {
    id:           'agt_test',
    hasAbilities: async () => true,
    getAbilities: async () => text,
  };
}

// Helper: build a fake agent without abilities (async methods)
function agentWithoutAbilities() {
  return {
    id:           'agt_test',
    hasAbilities: async () => false,
    getAbilities: async () => null,
  };
}

describe('reinjectAbilities (Step 3)', () => {

  // ---------------------------------------------------------------------------
  // Truncation occurred + agent has abilities => re-inject
  // ---------------------------------------------------------------------------

  describe('when truncation occurred and agent has abilities', () => {
    it('should concatenate abilities text onto the first user message', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Hello agent' },
        { role: 'assistant', content: 'Hi there' },
      ];

      let agent  = agentWithAbilities('Never deploy on Fridays.');
      let result = await reinjectAbilities(messages, agent);

      assert.ok(result[1].content.includes('Hello agent'));
      assert.ok(result[1].content.includes('Never deploy on Fridays.'));
    });

    it('should use --- ABILITIES --- / --- END ABILITIES --- delimiters', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Help me' },
      ];

      let agent  = agentWithAbilities('Rule 1: Check tests.');
      let result = await reinjectAbilities(messages, agent);

      assert.ok(result[1].content.includes('--- ABILITIES ---'));
      assert.ok(result[1].content.includes('--- END ABILITIES ---'));
    });

    it('should include a reminder line after the abilities block', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Question?' },
      ];

      let agent  = agentWithAbilities('Some ability.');
      let result = await reinjectAbilities(messages, agent);

      assert.ok(result[1].content.includes('Remember to check each user request against your ABILITIES before proceeding.'));
    });

    it('should format the abilities block correctly', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Original message' },
      ];

      let agent    = agentWithAbilities('Rule A\nRule B');
      let result   = await reinjectAbilities(messages, agent);
      let expected = '--- ABILITIES ---\nRule A\nRule B\n--- END ABILITIES ---\nRemember to check each user request against your ABILITIES before proceeding.';

      assert.ok(result[1].content.includes(expected));
    });

    it('should inject into the first user message even if truncation marker is also user role', async () => {
      let messages = [
        truncationMarker(),
        { role: 'assistant', content: 'Resumed conversation.' },
        { role: 'user', content: 'Continue please' },
      ];

      let agent  = agentWithAbilities('Ability text.');
      let result = await reinjectAbilities(messages, agent);

      // Truncation marker should be untouched
      assert.ok(result[0].content.startsWith('[Earlier conversation'));
      assert.ok(!result[0].content.includes('--- ABILITIES ---'));

      // The non-marker user message gets the injection
      assert.ok(result[2].content.includes('Ability text.'));
      assert.ok(result[2].content.includes('Continue please'));
    });
  });

  // ---------------------------------------------------------------------------
  // Truncation occurred + agent has NO abilities => unchanged
  // ---------------------------------------------------------------------------

  describe('when truncation occurred but agent has no abilities', () => {
    it('should return messages unchanged', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Hello' },
      ];

      let agent  = agentWithoutAbilities();
      let result = await reinjectAbilities(messages, agent);

      assert.equal(result[1].content, 'Hello');
      assert.ok(!result[1].content.includes('--- ABILITIES ---'));
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

      let agent  = agentWithAbilities('Some ability.');
      let result = await reinjectAbilities(messages, agent);

      assert.equal(result[0].content, 'Hello');
      assert.ok(!result[0].content.includes('--- ABILITIES ---'));
    });

    it('should return messages unchanged even with many messages', async () => {
      let messages = [
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: 'Response' },
        { role: 'user', content: 'Second message' },
        { role: 'assistant', content: 'Another response' },
      ];

      let agent  = agentWithAbilities('Ability text.');
      let result = await reinjectAbilities(messages, agent);

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

      let agent  = agentWithAbilities('Some ability.');
      let result = await reinjectAbilities(messages, agent, { primerInjected: true });

      assert.equal(result[1].content, 'Hello');
      assert.ok(!result[1].content.includes('--- ABILITIES ---'));
    });

    it('should inject when primerInjected is false', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Hello' },
      ];

      let agent  = agentWithAbilities('Some ability.');
      let result = await reinjectAbilities(messages, agent, { primerInjected: false });

      assert.ok(result[1].content.includes('--- ABILITIES ---'));
      assert.ok(result[1].content.includes('Some ability.'));
    });

    it('should inject when primerInjected is not provided', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Hello' },
      ];

      let agent  = agentWithAbilities('Some ability.');
      let result = await reinjectAbilities(messages, agent);

      assert.ok(result[1].content.includes('--- ABILITIES ---'));
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

      let result = await reinjectAbilities(messages, null);

      assert.equal(result[1].content, 'Hello');
    });

    it('should return messages unchanged when agent is undefined', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Hello' },
      ];

      let result = await reinjectAbilities(messages, undefined);

      assert.equal(result[1].content, 'Hello');
    });

    it('should return messages unchanged when agent is a plain object without hasAbilities method', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Hello' },
      ];

      let agent  = { id: 'agt_plain', name: 'Plain Agent' };
      let result = await reinjectAbilities(messages, agent);

      assert.equal(result[1].content, 'Hello');
      assert.ok(!result[1].content.includes('--- ABILITIES ---'));
    });
  });

  // ---------------------------------------------------------------------------
  // Does not mutate input
  // ---------------------------------------------------------------------------

  describe('immutability', () => {
    it('should not mutate the original messages array', async () => {
      let originalMessage = { role: 'user', content: 'Hello' };
      let messages        = [truncationMarker(), originalMessage];

      let agent = agentWithAbilities('Some ability.');
      await reinjectAbilities(messages, agent);

      assert.equal(originalMessage.content, 'Hello');
      assert.equal(messages.length, 2);
    });

    it('should return a new array reference', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Hello' },
      ];

      let agent  = agentWithAbilities('Some ability.');
      let result = await reinjectAbilities(messages, agent);

      assert.notEqual(result, messages);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should handle empty messages array', async () => {
      let agent  = agentWithAbilities('Some ability.');
      let result = await reinjectAbilities([], agent);

      assert.deepEqual(result, []);
    });

    it('should handle null messages', async () => {
      let agent  = agentWithAbilities('Some ability.');
      let result = await reinjectAbilities(null, agent);

      assert.deepEqual(result, []);
    });

    it('should handle undefined messages', async () => {
      let agent  = agentWithAbilities('Some ability.');
      let result = await reinjectAbilities(undefined, agent);

      assert.deepEqual(result, []);
    });

    it('should handle truncation marker with no following user message', async () => {
      let messages = [
        truncationMarker(),
        { role: 'assistant', content: 'Some response' },
      ];

      let agent  = agentWithAbilities('Some ability.');
      let result = await reinjectAbilities(messages, agent);

      // No user message to inject into, so nothing changes
      assert.equal(result.length, 2);
      assert.ok(!result[0].content.includes('--- ABILITIES ---'));
      assert.ok(!result[1].content.includes('--- ABILITIES ---'));
    });

    it('should handle user message with null content after truncation', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: null },
      ];

      let agent  = agentWithAbilities('Some ability.');
      let result = await reinjectAbilities(messages, agent);

      assert.ok(result[1].content.includes('--- ABILITIES ---'));
      assert.ok(result[1].content.includes('Some ability.'));
    });

    it('should handle user message with empty string content after truncation', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: '' },
      ];

      let agent  = agentWithAbilities('Some ability.');
      let result = await reinjectAbilities(messages, agent);

      assert.ok(result[1].content.includes('--- ABILITIES ---'));
      assert.ok(result[1].content.includes('Some ability.'));
    });

    it('should handle agent with hasAbilities returning true but getAbilities returning empty string', async () => {
      let agent = {
        id:           'agt_test',
        hasAbilities: async () => true,
        getAbilities: async () => '',
      };

      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Hello' },
      ];

      let result = await reinjectAbilities(messages, agent);

      // hasAbilities() is true, so we proceed — getAbilities returns empty string
      // The function should still inject the block with the empty content
      assert.ok(result[1].content.includes('--- ABILITIES ---'));
    });

    it('should only inject into the first non-marker user message', async () => {
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'First user msg' },
        { role: 'user', content: 'Second user msg' },
      ];

      let agent  = agentWithAbilities('Some ability.');
      let result = await reinjectAbilities(messages, agent);

      assert.ok(result[1].content.includes('--- ABILITIES ---'));
      assert.ok(!result[2].content.includes('--- ABILITIES ---'));
      assert.equal(result[2].content, 'Second user msg');
    });

    it('should detect truncation marker regardless of message count in marker text', async () => {
      let messages = [
        { role: 'user', content: '[Earlier conversation history was truncated. 42 messages removed.]' },
        { role: 'user', content: 'Hello' },
      ];

      let agent  = agentWithAbilities('Some ability.');
      let result = await reinjectAbilities(messages, agent);

      assert.ok(result[1].content.includes('--- ABILITIES ---'));
    });
  });
});
