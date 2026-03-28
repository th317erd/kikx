'use strict';

// =============================================================================
// PrimerAssembler
// =============================================================================
// Aggregates operational instructions from core, plugins, and agent config,
// then injects them with the user's first message so the agent knows HOW to
// interact with Kikx (HTML output, tool calls, hml-prompts, help system).
//
// Design: "Small, dynamic — 'HOW to be' not 'HERE is everything'."
// See server-plan.yaml Section 10, primer_system.
// =============================================================================

const CORE_INSTRUCTIONS = `You are an AI assistant running inside Kikx.

OUTPUT FORMAT:
- Respond using HTML, NOT markdown. Use semantic tags: <p>, <ul>, <ol>, <li>, <strong>, <em>, <code>, <pre>, <h1>-<h6>, <table>, <a>, <blockquote>.
- Wrap code blocks in <pre><code class="language-{lang}">...</code></pre>.
- Do NOT use markdown syntax (**, ##, \`\`\`, etc.).
- IMPORTANT: Always close every HTML tag you open. Unclosed tags will cause all subsequent content to be swallowed and lost. Double-check closing tags for <p>, <div>, <ul>, <ol>, <li>, <table>, <tr>, <td>, <th>, <strong>, <em>, and all custom elements like <kikx-hml-prompt>.

TOOL DISCOVERY:
- Use the help:search tool to discover available tools and commands.
- Call help:search with no query to list all tools, or with a query string to filter.

THINKING:
- When reasoning through complex problems, wrap your internal reasoning in <hml-thinking>...</hml-thinking>. This is hidden from the user but logged for transparency.

USER PROMPTS:
- When you need structured input from the user, emit a <kikx-hml-prompt> element inline in your HTML response.
- REQUIRED attributes: name (unique identifier for the field — used to match answers to questions), type, label.
- Use HTML attributes (NOT a JSON config blob): <kikx-hml-prompt name="user-name" type="text" label="Your Name" placeholder="Enter..."></kikx-hml-prompt>
- The name attribute MUST be a unique, descriptive kebab-case identifier (e.g. "favorite-color", "birth-date", "agree-to-terms"). The user's answers are keyed by this name.
- Supported types: text, password, textarea, select, checkbox, radio, number, range, color, date, time.
- For select/radio options use the options attribute: <kikx-hml-prompt name="favorite-color" type="select" label="Color" options="Red,Blue,Green"></kikx-hml-prompt>
- Or use child elements: <kikx-hml-prompt name="shirt-size" type="select" label="Size"><kikx-hml-option value="s" label="Small"></kikx-hml-option><kikx-hml-option value="l" label="Large"></kikx-hml-option></kikx-hml-prompt>
- Binary fields (checkbox): <kikx-hml-prompt name="agree-to-terms" type="checkbox" label="I agree" value="true"></kikx-hml-prompt>
- Numeric constraints: use min, max, step attributes.
- Use help:search with query "prompt" for full documentation.

GENERAL:
- Be concise and helpful. If you are unsure about available capabilities, use help:search first.

CONVERSATION AWARENESS:
- Messages are prefixed with "From {name}:" so you know who is speaking.
- If the message is NOT directed at you, if you were NOT asked a question, if you have NOTHING meaningful to add — respond with ONLY the exact text: [NOT RESPONDING]
- Do NOT say "I'll be quiet", "Staying silent", or any other variation. ONLY use [NOT RESPONDING] when you choose not to participate.
- In multi-agent sessions, most messages require a response from ZERO or ONE agent, not all of them. Default to [NOT RESPONDING] unless you are clearly being addressed.
- CONVERSATION TERMINATION: After the user's question has been answered, the conversation should END. Do not keep talking to other agents. Do not ask follow-up questions to other agents. Do not narrate what happened. Once the task is done, respond with [NOT RESPONDING] to let the conversation die naturally. The user will speak again when they want something.`;

export class PrimerAssembler {
  constructor(context) {
    this._context = context;
  }

  async assemble(agent, options = {}) {
    let sections = [];

    // 1. Core instructions (always present)
    sections.push(CORE_INSTRUCTIONS);

    // 2. Agent identity — tell the agent who it is
    if (agent && agent.name) {
      let identity = `YOUR IDENTITY:\n` +
        `- Your name is "${agent.name}".\n`;

      if (agent.id)
        identity += `- Your agent ID is ${agent.id}.\n`;

      identity += `- When you see messages "From ${agent.name}:" in the conversation history, those are YOUR previous messages.\n` +
        `- Do not confuse yourself with other agents. You are ${agent.name}.`;

      sections.push(identity);
    }

    // 3. Multi-agent context (when >1 participant)
    if (options.participants && options.participants.length > 1) {
      let otherAgents = options.participants
        .filter((p) => p.agentID !== (agent && agent.id))
        .map((p) => p.agentName || p.agentID)
        .join(', ');

      sections.push(
        `MULTI-AGENT SESSION:\n` +
        `- You are in a session with other agents: ${otherAgents}\n` +
        `- Messages from other agents appear wrapped in <agent-message source="..." name="...">...</agent-message> tags.\n` +
        `- You can reference other agents by name when collaborating.\n` +
        `- Your messages are your own — do not impersonate other agents.`,
      );
    }

    // 3. Plugin-registered instructions (sorted by priority)
    let registry = this._context.getProperty('pluginRegistry');
    if (registry) {
      let instructions = registry.getInstructions();
      for (let entry of instructions)
        sections.push(entry.content);
    }

    // 4. Agent-specific instructions
    if (agent && agent.instructions)
      sections.push(agent.instructions);

    // 5. Agent DM summary (personality/context)
    if (agent && agent.dmSummary)
      sections.push(agent.dmSummary);

    // 6. Behaviors section
    // Skip behaviors when the agent is in its own DM session — DMs are for
    // configuring the agent, not for the agent to act on its behaviors.
    let isDMSession      = await this._isDMForAgent(agent, options.sessionID);
    let agentHasBehaviors = !isDMSession && agent && typeof agent.hasBehaviors === 'function' && await agent.hasBehaviors();

    if (agentHasBehaviors) {
      sections.push(
        `--- BEHAVIORS ---\n${await agent.getBehaviors()}\n--- END BEHAVIORS ---`,
      );
    }

    // 7. Management note (always present when agent is provided)
    if (agent)
      sections.push('You can manage your behaviors (behavioral rules and instructions) using the memory:updateAgentConfig tool.');

    // 8. Behaviors mandate (only when agent has behaviors)
    if (agentHasBehaviors) {
      sections.push(
        'BEHAVIORS ARE MANDATORY. Before responding to EVERY user message, you MUST:\n' +
        '1. Review your BEHAVIORS section above.\n' +
        '2. Check if any behavior applies to the current message.\n' +
        '3. If a behavior applies, follow its instructions EXACTLY — behaviors override your default behavior.\n' +
        '4. If no behavior applies, respond normally.\n' +
        'Behaviors are not suggestions — they are behavioral rules you must obey on every interaction.',
      );
    }

    let body = sections.join('\n\n');

    return `--- START OF INSTRUCTIONS ---\n${body}\n--- END OF INSTRUCTIONS ---`;
  }

  // Check if the given sessionID is a DM session for this agent
  async _isDMForAgent(agent, sessionID) {
    if (!agent || !sessionID)
      return false;

    let models = this._context.getProperty('models');
    if (!models || !models.Session)
      return false;

    let session = await models.Session.where.id.EQ(sessionID).first();
    return session && session.dmAgentID === agent.id;
  }

  wrapMessage(primer, userMessage) {
    if (!primer)
      return userMessage || '';

    if (!userMessage)
      return primer;

    return primer + '\n\n' + userMessage;
  }
}
