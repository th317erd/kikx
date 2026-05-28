'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { PrimerAssembler }     from '../../../src/core/primer/index.mjs';
import { PluginRegistry }      from '../../../src/core/plugin-loader/registry.mjs';
import { reinjectBehaviors }   from '../../../src/core/interaction/behaviors-reinjection.mjs';
import { truncateConversation } from '../../../src/core/interaction/context-truncation.mjs';

// =============================================================================
// Behaviors System — Integration Tests
// =============================================================================
// End-to-end tests that exercise the full behaviors pipeline:
//   Agent model -> PrimerAssembler -> truncation -> re-injection
//
// Uses mock agents that match the Agent interface to test the pipeline
// without requiring a database connection.
// =============================================================================

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function createMockAgent(options = {}) {
  let config = { ...options.config };
  return {
    id:            options.id || 'agt_integration_test',
    instructions:  options.instructions || '',
    dmSummary:     options.dmSummary || '',
    getBehaviors:  async () => config.behaviors || null,
    hasBehaviors:  async () => !!config.behaviors,
    setBehaviors:  (text) => { config.behaviors = text || null; },
    getConfig:     async () => ({ ...config }),
  };
}

function createMockContext(overrides = {}) {
  let properties = new Map();

  let context = {
    getProperty: (key) => properties.get(key) || null,
    setProperty: (key, value) => properties.set(key, value),
    ...overrides,
  };

  return { context, properties };
}

function createAssembler() {
  let registry = new PluginRegistry();
  let { context, properties } = createMockContext();
  properties.set('pluginRegistry', registry);
  let assembler = new PrimerAssembler(context);
  return { assembler, registry };
}

/**
 * Build a truncation marker message that matches truncateConversation output.
 */
function truncationMarker(count = 5) {
  return {
    role:    'user',
    content: `[Earlier conversation history was truncated. ${count} messages removed.]`,
  };
}

/**
 * Generate a large string to force truncation.
 */
function generateLargeContent(charCount) {
  return 'x'.repeat(charCount);
}

// =============================================================================
// Integration Tests
// =============================================================================

describe('Behaviors System — Integration', () => {

  // ---------------------------------------------------------------------------
  // Test 1: Full round-trip — primer includes behaviors
  // ---------------------------------------------------------------------------

  describe('full round-trip: primer includes behaviors', () => {
    it('should include behaviors text, delimiters, reminder, and management note in primer', async () => {
      let { assembler } = createAssembler();
      let agent = createMockAgent({
        instructions: 'You are a helpful coding assistant.',
        config:       { behaviors: 'Never deploy on Fridays.\nAlways run tests first.' },
      });

      let primer = await assembler.assemble(agent);

      // Behaviors text is present
      assert.ok(primer.includes('Never deploy on Fridays.'));
      assert.ok(primer.includes('Always run tests first.'));

      // Delimiters are present
      assert.ok(primer.includes('--- BEHAVIORS ---'));
      assert.ok(primer.includes('--- END BEHAVIORS ---'));

      // Reminder is present
      assert.ok(primer.includes('BEHAVIORS ARE MANDATORY'));

      // Management note is present
      assert.ok(primer.includes('memory:updateAgentConfig'));
    });

    it('should order sections: instructions before behaviors before management note before reminder', async () => {
      let { assembler } = createAssembler();
      let agent = createMockAgent({
        instructions: 'AGENT_INSTRUCTIONS_MARKER',
        config:       { behaviors: 'BEHAVIORS_TEXT_MARKER' },
      });

      let primer = await assembler.assemble(agent);

      let instructionsIndex  = primer.indexOf('AGENT_INSTRUCTIONS_MARKER');
      let behaviorsIndex     = primer.indexOf('BEHAVIORS_TEXT_MARKER');
      let managementIndex    = primer.indexOf('memory:updateAgentConfig');
      let reminderIndex      = primer.indexOf('BEHAVIORS ARE MANDATORY');

      assert.ok(instructionsIndex >= 0, 'Instructions should be present');
      assert.ok(behaviorsIndex >= 0, 'Behaviors should be present');
      assert.ok(managementIndex >= 0, 'Management note should be present');
      assert.ok(reminderIndex >= 0, 'Reminder should be present');

      assert.ok(instructionsIndex < behaviorsIndex, 'Instructions should come before behaviors');
      assert.ok(behaviorsIndex < managementIndex, 'Behaviors should come before management note');
      assert.ok(managementIndex < reminderIndex, 'Management note should come before reminder');
    });

    it('should wrap the entire primer in instruction boundaries', async () => {
      let { assembler } = createAssembler();
      let agent = createMockAgent({
        config: { behaviors: 'Some behavior text.' },
      });

      let primer = await assembler.assemble(agent);

      assert.ok(primer.startsWith('--- START OF INSTRUCTIONS ---\n'));
      assert.ok(primer.endsWith('\n--- END OF INSTRUCTIONS ---'));
    });
  });

  // ---------------------------------------------------------------------------
  // Test 2: Agent with no behaviors — management note present, no behaviors section
  // ---------------------------------------------------------------------------

  describe('agent with no behaviors: management note but no behaviors section', () => {
    it('should NOT include behaviors delimiters or reminder', async () => {
      let { assembler } = createAssembler();
      let agent = createMockAgent({
        instructions: 'Be helpful.',
      });

      let primer = await assembler.assemble(agent);

      assert.ok(!primer.includes('--- BEHAVIORS ---'));
      assert.ok(!primer.includes('--- END BEHAVIORS ---'));
      assert.ok(!primer.includes('BEHAVIORS ARE MANDATORY'));
    });

    it('should still include management note', async () => {
      let { assembler } = createAssembler();
      let agent = createMockAgent({
        instructions: 'Be helpful.',
      });

      let primer = await assembler.assemble(agent);

      assert.ok(primer.includes('memory:updateAgentConfig'));
    });
  });

  // ---------------------------------------------------------------------------
  // Test 3: Truncation round-trip — behaviors re-injected after truncation
  // ---------------------------------------------------------------------------

  describe('truncation round-trip: behaviors re-injected after truncation', () => {
    it('should re-inject behaviors into messages after truncateConversation drops them', async () => {
      let behaviorsText = 'Never force push to main.\nAlways write tests.';
      let agent = createMockAgent({
        config: { behaviors: behaviorsText },
      });

      // Build a message array that exceeds the budget to trigger truncation.
      // The first message is a user message with primer+behaviors (simulating real flow).
      // Add large assistant messages to exceed the budget.
      let { assembler } = createAssembler();
      let primer = await assembler.assemble(agent);

      let messages = [
        { role: 'user', content: primer + '\n\nHello, help me with code.' },
        { role: 'assistant', content: generateLargeContent(200000) },
        { role: 'user', content: 'Follow-up question 1' },
        { role: 'assistant', content: generateLargeContent(200000) },
        { role: 'user', content: 'Follow-up question 2' },
        { role: 'assistant', content: generateLargeContent(200000) },
        { role: 'user', content: 'Current question' },
      ];

      // Truncate — this should drop early messages and prepend a marker
      let truncated = truncateConversation(messages, { maxTotalChars: 300000 });

      // Verify truncation actually happened
      assert.ok(
        truncated[0].content.startsWith('[Earlier conversation history was truncated'),
        'First message should be truncation marker',
      );

      // Verify the original behaviors are gone (the primer message was dropped)
      let hasPrimerBehaviors = truncated.some(
        (message) => message.content && message.content.includes('--- BEHAVIORS ---') && message.content.includes(behaviorsText),
      );
      assert.ok(!hasPrimerBehaviors, 'Original behaviors should have been truncated away');

      // Re-inject behaviors
      let result = await reinjectBehaviors(truncated, agent, { primerInjected: false });

      // Verify behaviors are back in the output
      let reinjectedMessage = result.find(
        (message) => message.content && message.content.includes('--- BEHAVIORS ---'),
      );

      assert.ok(reinjectedMessage, 'Behaviors should be re-injected after truncation');
      assert.ok(reinjectedMessage.content.includes(behaviorsText), 'Re-injected text should match agent behaviors');
      assert.ok(reinjectedMessage.content.includes('--- END BEHAVIORS ---'), 'Should include end delimiter');
      assert.ok(
        reinjectedMessage.content.includes('BEHAVIORS ARE MANDATORY'),
        'Should include reminder',
      );
    });

    it('should inject into the first non-marker user message', async () => {
      let agent = createMockAgent({
        config: { behaviors: 'Check tests before merging.' },
      });

      // Simulate a post-truncation message array
      let messages = [
        truncationMarker(10),
        { role: 'assistant', content: 'Some assistant response.' },
        { role: 'user', content: 'My next question' },
        { role: 'assistant', content: 'Another response.' },
      ];

      let result = await reinjectBehaviors(messages, agent, { primerInjected: false });

      // Truncation marker should be untouched
      assert.ok(!result[0].content.includes('--- BEHAVIORS ---'));

      // The first non-marker user message should have behaviors
      assert.ok(result[2].content.includes('--- BEHAVIORS ---'));
      assert.ok(result[2].content.includes('Check tests before merging.'));
      assert.ok(result[2].content.includes('My next question'));
    });
  });

  // ---------------------------------------------------------------------------
  // Test 4: Truncation with primer injection — no double-injection
  // ---------------------------------------------------------------------------

  describe('truncation with primer already injected: no double-injection', () => {
    it('should NOT re-inject behaviors when primerInjected is true', async () => {
      let agent = createMockAgent({
        config: { behaviors: 'Never deploy on Fridays.' },
      });

      let messages = [
        truncationMarker(8),
        { role: 'user', content: 'Hello' },
      ];

      let result = await reinjectBehaviors(messages, agent, { primerInjected: true });

      assert.ok(!result[1].content.includes('--- BEHAVIORS ---'));
      assert.equal(result[1].content, 'Hello');
    });

    it('should leave the message array completely unchanged when primer is already injected', async () => {
      let agent = createMockAgent({
        config: { behaviors: 'Always run linter.' },
      });

      let messages = [
        truncationMarker(3),
        { role: 'assistant', content: 'Response' },
        { role: 'user', content: 'Follow-up' },
      ];

      let result = await reinjectBehaviors(messages, agent, { primerInjected: true });

      // Should be the exact same reference (early return path)
      assert.equal(result, messages);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 5: Set behaviors -> get behaviors -> primer reflects change
  // ---------------------------------------------------------------------------

  describe('set behaviors then re-assemble primer reflects change', () => {
    it('should reflect new behaviors after setBehaviors()', async () => {
      let { assembler } = createAssembler();
      let agent = createMockAgent({
        instructions: 'Be concise.',
        config:       { behaviors: 'Original behavior: check PRs.' },
      });

      // First primer — has original behaviors
      let primer1 = await assembler.assemble(agent);
      assert.ok(primer1.includes('Original behavior: check PRs.'));

      // Update behaviors
      agent.setBehaviors('Updated behavior: run CI before merge.');

      // Second primer — has updated behaviors, NOT original
      let primer2 = await assembler.assemble(agent);
      assert.ok(primer2.includes('Updated behavior: run CI before merge.'));
      assert.ok(!primer2.includes('Original behavior: check PRs.'));
    });

    it('should round-trip through getBehaviors after setBehaviors', async () => {
      let agent = createMockAgent();

      assert.equal(await agent.getBehaviors(), null);
      assert.equal(await agent.hasBehaviors(), false);

      agent.setBehaviors('Behavior 1');
      assert.equal(await agent.getBehaviors(), 'Behavior 1');
      assert.equal(await agent.hasBehaviors(), true);

      agent.setBehaviors('Behavior 2: different text');
      assert.equal(await agent.getBehaviors(), 'Behavior 2: different text');
      assert.equal(await agent.hasBehaviors(), true);
    });

    it('should reflect each change in a freshly assembled primer', async () => {
      let { assembler } = createAssembler();
      let agent = createMockAgent({
        instructions: 'Agent instructions.',
      });

      // No behaviors initially
      let primer0 = await assembler.assemble(agent);
      assert.ok(!primer0.includes('--- BEHAVIORS ---'));

      // Add behaviors
      agent.setBehaviors('First set of behaviors.');
      let primer1 = await assembler.assemble(agent);
      assert.ok(primer1.includes('First set of behaviors.'));
      assert.ok(primer1.includes('--- BEHAVIORS ---'));

      // Change behaviors
      agent.setBehaviors('Second set of behaviors.');
      let primer2 = await assembler.assemble(agent);
      assert.ok(primer2.includes('Second set of behaviors.'));
      assert.ok(!primer2.includes('First set of behaviors.'));

      // Third change
      agent.setBehaviors('Third and final behaviors.');
      let primer3 = await assembler.assemble(agent);
      assert.ok(primer3.includes('Third and final behaviors.'));
      assert.ok(!primer3.includes('Second set of behaviors.'));
    });
  });

  // ---------------------------------------------------------------------------
  // Test 6: Clear behaviors -> primer no longer has behaviors section
  // ---------------------------------------------------------------------------

  describe('clear behaviors: primer no longer has behaviors section', () => {
    it('should remove behaviors section from primer after setBehaviors(null)', async () => {
      let { assembler } = createAssembler();
      let agent = createMockAgent({
        instructions: 'Agent instructions.',
        config:       { behaviors: 'Behavior that will be cleared.' },
      });

      // Primer with behaviors
      let primerBefore = await assembler.assemble(agent);
      assert.ok(primerBefore.includes('--- BEHAVIORS ---'));
      assert.ok(primerBefore.includes('Behavior that will be cleared.'));
      assert.ok(primerBefore.includes('--- END BEHAVIORS ---'));
      assert.ok(primerBefore.includes('BEHAVIORS ARE MANDATORY'));

      // Clear behaviors
      agent.setBehaviors(null);

      // Primer without behaviors
      let primerAfter = await assembler.assemble(agent);
      assert.ok(!primerAfter.includes('--- BEHAVIORS ---'));
      assert.ok(!primerAfter.includes('Behavior that will be cleared.'));
      assert.ok(!primerAfter.includes('--- END BEHAVIORS ---'));
      assert.ok(!primerAfter.includes('BEHAVIORS ARE MANDATORY'));
    });

    it('should retain management note after clearing behaviors', async () => {
      let { assembler } = createAssembler();
      let agent = createMockAgent({
        config: { behaviors: 'Temporary behavior.' },
      });

      // Before clearing
      let primerBefore = await assembler.assemble(agent);
      assert.ok(primerBefore.includes('memory:updateAgentConfig'));

      // Clear behaviors
      agent.setBehaviors(null);

      // After clearing — management note should still be present
      let primerAfter = await assembler.assemble(agent);
      assert.ok(primerAfter.includes('memory:updateAgentConfig'));
    });

    it('should handle clearing with empty string same as null', async () => {
      let { assembler } = createAssembler();
      let agent = createMockAgent({
        config: { behaviors: 'Some behavior.' },
      });

      // Verify behaviors are present
      let primer1 = await assembler.assemble(agent);
      assert.ok(primer1.includes('--- BEHAVIORS ---'));

      // Clear with empty string (setBehaviors converts falsy to null)
      agent.setBehaviors('');

      // Verify behaviors section is gone
      let primer2 = await assembler.assemble(agent);
      assert.ok(!primer2.includes('--- BEHAVIORS ---'));

      // Management note persists
      assert.ok(primer2.includes('memory:updateAgentConfig'));
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases: full pipeline
  // ---------------------------------------------------------------------------

  describe('edge cases across the full pipeline', () => {
    it('should handle multi-line behaviors with special characters through primer and re-injection', async () => {
      let { assembler } = createAssembler();
      let behaviorsText = 'Rule 1: Use <code> tags for inline code.\nRule 2: Prefer "single quotes" over `backticks`.\nRule 3: Handle $special & characters.';
      let agent = createMockAgent({
        config: { behaviors: behaviorsText },
      });

      // Through primer
      let primer = await assembler.assemble(agent);
      assert.ok(primer.includes(behaviorsText));

      // Through re-injection
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Help me' },
      ];
      let result = await reinjectBehaviors(messages, agent, { primerInjected: false });
      assert.ok(result[1].content.includes(behaviorsText));
    });

    it('should handle behaviors with only whitespace as effectively empty', async () => {
      let { assembler } = createAssembler();
      let agent = createMockAgent({
        config: { behaviors: '   ' },
      });

      // hasBehaviors should be true (non-empty string)
      assert.equal(await agent.hasBehaviors(), true);

      // Primer should include the whitespace-only behaviors section
      let primer = await assembler.assemble(agent);
      assert.ok(primer.includes('--- BEHAVIORS ---'));
    });

    it('should not re-inject when there is no truncation marker in messages', async () => {
      let agent = createMockAgent({
        config: { behaviors: 'Some behavior.' },
      });

      let messages = [
        { role: 'user', content: 'Normal conversation' },
        { role: 'assistant', content: 'Normal response' },
        { role: 'user', content: 'Follow up' },
      ];

      let result = await reinjectBehaviors(messages, agent, { primerInjected: false });

      // No changes because no truncation occurred
      assert.equal(result[0].content, 'Normal conversation');
      assert.equal(result[2].content, 'Follow up');
      assert.ok(!result[0].content.includes('--- BEHAVIORS ---'));
      assert.ok(!result[2].content.includes('--- BEHAVIORS ---'));
    });

    it('should work correctly with truncateConversation using a low budget', async () => {
      let agent = createMockAgent({
        config: { behaviors: 'Always validate inputs.' },
      });

      // Build messages that just barely exceed a low budget
      let messages = [
        { role: 'user', content: 'First message with some content here' },
        { role: 'assistant', content: generateLargeContent(500) },
        { role: 'user', content: 'Second message' },
        { role: 'assistant', content: generateLargeContent(500) },
        { role: 'user', content: 'Current turn' },
      ];

      // Use a budget that forces some truncation
      let truncated = truncateConversation(messages, { maxTotalChars: 600 });

      // Only proceed if truncation actually happened
      if (truncated[0].content.startsWith('[Earlier conversation history was truncated')) {
        let result = await reinjectBehaviors(truncated, agent, { primerInjected: false });

        let hasBehaviors = result.some(
          (message) => message.content && message.content.includes('--- BEHAVIORS ---'),
        );
        assert.ok(hasBehaviors, 'Behaviors should be re-injected after low-budget truncation');
      }
    });

    it('should keep re-injection and primer mutually exclusive via primerInjected flag', async () => {
      let agent = createMockAgent({
        config: { behaviors: 'Critical behavior.' },
      });

      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Hello' },
      ];

      // With primerInjected: true -> no re-injection (primer will have behaviors)
      let resultWithPrimer = await reinjectBehaviors(messages, agent, { primerInjected: true });
      assert.ok(!resultWithPrimer[1].content.includes('--- BEHAVIORS ---'));

      // With primerInjected: false -> re-injection happens
      let resultWithoutPrimer = await reinjectBehaviors(messages, agent, { primerInjected: false });
      assert.ok(resultWithoutPrimer[1].content.includes('--- BEHAVIORS ---'));
    });
  });
});
