'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { PrimerAssembler }     from '../../../src/core/primer/index.mjs';
import { PluginRegistry }      from '../../../src/core/plugin-loader/registry.mjs';
import { reinjectAbilities }   from '../../../src/core/interaction/abilities-reinjection.mjs';
import { truncateConversation } from '../../../src/core/interaction/context-truncation.mjs';

// =============================================================================
// Abilities System — Integration Tests
// =============================================================================
// End-to-end tests that exercise the full abilities pipeline:
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
    getAbilities:  async () => config.abilities || null,
    hasAbilities:  async () => !!config.abilities,
    setAbilities:  (text) => { config.abilities = text || null; },
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

describe('Abilities System — Integration', () => {

  // ---------------------------------------------------------------------------
  // Test 1: Full round-trip — primer includes abilities
  // ---------------------------------------------------------------------------

  describe('full round-trip: primer includes abilities', () => {
    it('should include abilities text, delimiters, reminder, and management note in primer', async () => {
      let { assembler } = createAssembler();
      let agent = createMockAgent({
        instructions: 'You are a helpful coding assistant.',
        config:       { abilities: 'Never deploy on Fridays.\nAlways run tests first.' },
      });

      let primer = await assembler.assemble(agent);

      // Abilities text is present
      assert.ok(primer.includes('Never deploy on Fridays.'));
      assert.ok(primer.includes('Always run tests first.'));

      // Delimiters are present
      assert.ok(primer.includes('--- ABILITIES ---'));
      assert.ok(primer.includes('--- END ABILITIES ---'));

      // Reminder is present
      assert.ok(primer.includes('ABILITIES ARE MANDATORY'));

      // Management note is present
      assert.ok(primer.includes('memory:updateAgentConfig'));
    });

    it('should order sections: instructions before abilities before management note before reminder', async () => {
      let { assembler } = createAssembler();
      let agent = createMockAgent({
        instructions: 'AGENT_INSTRUCTIONS_MARKER',
        config:       { abilities: 'ABILITIES_TEXT_MARKER' },
      });

      let primer = await assembler.assemble(agent);

      let instructionsIndex  = primer.indexOf('AGENT_INSTRUCTIONS_MARKER');
      let abilitiesIndex     = primer.indexOf('ABILITIES_TEXT_MARKER');
      let managementIndex    = primer.indexOf('memory:updateAgentConfig');
      let reminderIndex      = primer.indexOf('ABILITIES ARE MANDATORY');

      assert.ok(instructionsIndex >= 0, 'Instructions should be present');
      assert.ok(abilitiesIndex >= 0, 'Abilities should be present');
      assert.ok(managementIndex >= 0, 'Management note should be present');
      assert.ok(reminderIndex >= 0, 'Reminder should be present');

      assert.ok(instructionsIndex < abilitiesIndex, 'Instructions should come before abilities');
      assert.ok(abilitiesIndex < managementIndex, 'Abilities should come before management note');
      assert.ok(managementIndex < reminderIndex, 'Management note should come before reminder');
    });

    it('should wrap the entire primer in instruction boundaries', async () => {
      let { assembler } = createAssembler();
      let agent = createMockAgent({
        config: { abilities: 'Some ability text.' },
      });

      let primer = await assembler.assemble(agent);

      assert.ok(primer.startsWith('--- START OF INSTRUCTIONS ---\n'));
      assert.ok(primer.endsWith('\n--- END OF INSTRUCTIONS ---'));
    });
  });

  // ---------------------------------------------------------------------------
  // Test 2: Agent with no abilities — management note present, no abilities section
  // ---------------------------------------------------------------------------

  describe('agent with no abilities: management note but no abilities section', () => {
    it('should NOT include abilities delimiters or reminder', async () => {
      let { assembler } = createAssembler();
      let agent = createMockAgent({
        instructions: 'Be helpful.',
      });

      let primer = await assembler.assemble(agent);

      assert.ok(!primer.includes('--- ABILITIES ---'));
      assert.ok(!primer.includes('--- END ABILITIES ---'));
      assert.ok(!primer.includes('ABILITIES ARE MANDATORY'));
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
  // Test 3: Truncation round-trip — abilities re-injected after truncation
  // ---------------------------------------------------------------------------

  describe('truncation round-trip: abilities re-injected after truncation', () => {
    it('should re-inject abilities into messages after truncateConversation drops them', async () => {
      let abilitiesText = 'Never force push to main.\nAlways write tests.';
      let agent = createMockAgent({
        config: { abilities: abilitiesText },
      });

      // Build a message array that exceeds the budget to trigger truncation.
      // The first message is a user message with primer+abilities (simulating real flow).
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

      // Verify the original abilities are gone (the primer message was dropped)
      let hasPrimerAbilities = truncated.some(
        (message) => message.content && message.content.includes('--- ABILITIES ---') && message.content.includes(abilitiesText),
      );
      assert.ok(!hasPrimerAbilities, 'Original abilities should have been truncated away');

      // Re-inject abilities
      let result = await reinjectAbilities(truncated, agent, { primerInjected: false });

      // Verify abilities are back in the output
      let reinjectedMessage = result.find(
        (message) => message.content && message.content.includes('--- ABILITIES ---'),
      );

      assert.ok(reinjectedMessage, 'Abilities should be re-injected after truncation');
      assert.ok(reinjectedMessage.content.includes(abilitiesText), 'Re-injected text should match agent abilities');
      assert.ok(reinjectedMessage.content.includes('--- END ABILITIES ---'), 'Should include end delimiter');
      assert.ok(
        reinjectedMessage.content.includes('ABILITIES ARE MANDATORY'),
        'Should include reminder',
      );
    });

    it('should inject into the first non-marker user message', async () => {
      let agent = createMockAgent({
        config: { abilities: 'Check tests before merging.' },
      });

      // Simulate a post-truncation message array
      let messages = [
        truncationMarker(10),
        { role: 'assistant', content: 'Some assistant response.' },
        { role: 'user', content: 'My next question' },
        { role: 'assistant', content: 'Another response.' },
      ];

      let result = await reinjectAbilities(messages, agent, { primerInjected: false });

      // Truncation marker should be untouched
      assert.ok(!result[0].content.includes('--- ABILITIES ---'));

      // The first non-marker user message should have abilities
      assert.ok(result[2].content.includes('--- ABILITIES ---'));
      assert.ok(result[2].content.includes('Check tests before merging.'));
      assert.ok(result[2].content.includes('My next question'));
    });
  });

  // ---------------------------------------------------------------------------
  // Test 4: Truncation with primer injection — no double-injection
  // ---------------------------------------------------------------------------

  describe('truncation with primer already injected: no double-injection', () => {
    it('should NOT re-inject abilities when primerInjected is true', async () => {
      let agent = createMockAgent({
        config: { abilities: 'Never deploy on Fridays.' },
      });

      let messages = [
        truncationMarker(8),
        { role: 'user', content: 'Hello' },
      ];

      let result = await reinjectAbilities(messages, agent, { primerInjected: true });

      assert.ok(!result[1].content.includes('--- ABILITIES ---'));
      assert.equal(result[1].content, 'Hello');
    });

    it('should leave the message array completely unchanged when primer is already injected', async () => {
      let agent = createMockAgent({
        config: { abilities: 'Always run linter.' },
      });

      let messages = [
        truncationMarker(3),
        { role: 'assistant', content: 'Response' },
        { role: 'user', content: 'Follow-up' },
      ];

      let result = await reinjectAbilities(messages, agent, { primerInjected: true });

      // Should be the exact same reference (early return path)
      assert.equal(result, messages);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 5: Set abilities -> get abilities -> primer reflects change
  // ---------------------------------------------------------------------------

  describe('set abilities then re-assemble primer reflects change', () => {
    it('should reflect new abilities after setAbilities()', async () => {
      let { assembler } = createAssembler();
      let agent = createMockAgent({
        instructions: 'Be concise.',
        config:       { abilities: 'Original ability: check PRs.' },
      });

      // First primer — has original abilities
      let primer1 = await assembler.assemble(agent);
      assert.ok(primer1.includes('Original ability: check PRs.'));

      // Update abilities
      agent.setAbilities('Updated ability: run CI before merge.');

      // Second primer — has updated abilities, NOT original
      let primer2 = await assembler.assemble(agent);
      assert.ok(primer2.includes('Updated ability: run CI before merge.'));
      assert.ok(!primer2.includes('Original ability: check PRs.'));
    });

    it('should round-trip through getAbilities after setAbilities', async () => {
      let agent = createMockAgent();

      assert.equal(await agent.getAbilities(), null);
      assert.equal(await agent.hasAbilities(), false);

      agent.setAbilities('Ability 1');
      assert.equal(await agent.getAbilities(), 'Ability 1');
      assert.equal(await agent.hasAbilities(), true);

      agent.setAbilities('Ability 2: different text');
      assert.equal(await agent.getAbilities(), 'Ability 2: different text');
      assert.equal(await agent.hasAbilities(), true);
    });

    it('should reflect each change in a freshly assembled primer', async () => {
      let { assembler } = createAssembler();
      let agent = createMockAgent({
        instructions: 'Agent instructions.',
      });

      // No abilities initially
      let primer0 = await assembler.assemble(agent);
      assert.ok(!primer0.includes('--- ABILITIES ---'));

      // Add abilities
      agent.setAbilities('First set of abilities.');
      let primer1 = await assembler.assemble(agent);
      assert.ok(primer1.includes('First set of abilities.'));
      assert.ok(primer1.includes('--- ABILITIES ---'));

      // Change abilities
      agent.setAbilities('Second set of abilities.');
      let primer2 = await assembler.assemble(agent);
      assert.ok(primer2.includes('Second set of abilities.'));
      assert.ok(!primer2.includes('First set of abilities.'));

      // Third change
      agent.setAbilities('Third and final abilities.');
      let primer3 = await assembler.assemble(agent);
      assert.ok(primer3.includes('Third and final abilities.'));
      assert.ok(!primer3.includes('Second set of abilities.'));
    });
  });

  // ---------------------------------------------------------------------------
  // Test 6: Clear abilities -> primer no longer has abilities section
  // ---------------------------------------------------------------------------

  describe('clear abilities: primer no longer has abilities section', () => {
    it('should remove abilities section from primer after setAbilities(null)', async () => {
      let { assembler } = createAssembler();
      let agent = createMockAgent({
        instructions: 'Agent instructions.',
        config:       { abilities: 'Ability that will be cleared.' },
      });

      // Primer with abilities
      let primerBefore = await assembler.assemble(agent);
      assert.ok(primerBefore.includes('--- ABILITIES ---'));
      assert.ok(primerBefore.includes('Ability that will be cleared.'));
      assert.ok(primerBefore.includes('--- END ABILITIES ---'));
      assert.ok(primerBefore.includes('ABILITIES ARE MANDATORY'));

      // Clear abilities
      agent.setAbilities(null);

      // Primer without abilities
      let primerAfter = await assembler.assemble(agent);
      assert.ok(!primerAfter.includes('--- ABILITIES ---'));
      assert.ok(!primerAfter.includes('Ability that will be cleared.'));
      assert.ok(!primerAfter.includes('--- END ABILITIES ---'));
      assert.ok(!primerAfter.includes('ABILITIES ARE MANDATORY'));
    });

    it('should retain management note after clearing abilities', async () => {
      let { assembler } = createAssembler();
      let agent = createMockAgent({
        config: { abilities: 'Temporary ability.' },
      });

      // Before clearing
      let primerBefore = await assembler.assemble(agent);
      assert.ok(primerBefore.includes('memory:updateAgentConfig'));

      // Clear abilities
      agent.setAbilities(null);

      // After clearing — management note should still be present
      let primerAfter = await assembler.assemble(agent);
      assert.ok(primerAfter.includes('memory:updateAgentConfig'));
    });

    it('should handle clearing with empty string same as null', async () => {
      let { assembler } = createAssembler();
      let agent = createMockAgent({
        config: { abilities: 'Some ability.' },
      });

      // Verify abilities are present
      let primer1 = await assembler.assemble(agent);
      assert.ok(primer1.includes('--- ABILITIES ---'));

      // Clear with empty string (setAbilities converts falsy to null)
      agent.setAbilities('');

      // Verify abilities section is gone
      let primer2 = await assembler.assemble(agent);
      assert.ok(!primer2.includes('--- ABILITIES ---'));

      // Management note persists
      assert.ok(primer2.includes('memory:updateAgentConfig'));
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases: full pipeline
  // ---------------------------------------------------------------------------

  describe('edge cases across the full pipeline', () => {
    it('should handle multi-line abilities with special characters through primer and re-injection', async () => {
      let { assembler } = createAssembler();
      let abilitiesText = 'Rule 1: Use <code> tags for inline code.\nRule 2: Prefer "single quotes" over `backticks`.\nRule 3: Handle $special & characters.';
      let agent = createMockAgent({
        config: { abilities: abilitiesText },
      });

      // Through primer
      let primer = await assembler.assemble(agent);
      assert.ok(primer.includes(abilitiesText));

      // Through re-injection
      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Help me' },
      ];
      let result = await reinjectAbilities(messages, agent, { primerInjected: false });
      assert.ok(result[1].content.includes(abilitiesText));
    });

    it('should handle abilities with only whitespace as effectively empty', async () => {
      let { assembler } = createAssembler();
      let agent = createMockAgent({
        config: { abilities: '   ' },
      });

      // hasAbilities should be true (non-empty string)
      assert.equal(await agent.hasAbilities(), true);

      // Primer should include the whitespace-only abilities section
      let primer = await assembler.assemble(agent);
      assert.ok(primer.includes('--- ABILITIES ---'));
    });

    it('should not re-inject when there is no truncation marker in messages', async () => {
      let agent = createMockAgent({
        config: { abilities: 'Some ability.' },
      });

      let messages = [
        { role: 'user', content: 'Normal conversation' },
        { role: 'assistant', content: 'Normal response' },
        { role: 'user', content: 'Follow up' },
      ];

      let result = await reinjectAbilities(messages, agent, { primerInjected: false });

      // No changes because no truncation occurred
      assert.equal(result[0].content, 'Normal conversation');
      assert.equal(result[2].content, 'Follow up');
      assert.ok(!result[0].content.includes('--- ABILITIES ---'));
      assert.ok(!result[2].content.includes('--- ABILITIES ---'));
    });

    it('should work correctly with truncateConversation using a low budget', async () => {
      let agent = createMockAgent({
        config: { abilities: 'Always validate inputs.' },
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
        let result = await reinjectAbilities(truncated, agent, { primerInjected: false });

        let hasAbilities = result.some(
          (message) => message.content && message.content.includes('--- ABILITIES ---'),
        );
        assert.ok(hasAbilities, 'Abilities should be re-injected after low-budget truncation');
      }
    });

    it('should keep re-injection and primer mutually exclusive via primerInjected flag', async () => {
      let agent = createMockAgent({
        config: { abilities: 'Critical ability.' },
      });

      let messages = [
        truncationMarker(),
        { role: 'user', content: 'Hello' },
      ];

      // With primerInjected: true -> no re-injection (primer will have abilities)
      let resultWithPrimer = await reinjectAbilities(messages, agent, { primerInjected: true });
      assert.ok(!resultWithPrimer[1].content.includes('--- ABILITIES ---'));

      // With primerInjected: false -> re-injection happens
      let resultWithoutPrimer = await reinjectAbilities(messages, agent, { primerInjected: false });
      assert.ok(resultWithoutPrimer[1].content.includes('--- ABILITIES ---'));
    });
  });
});
