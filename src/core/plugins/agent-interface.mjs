'use strict';

// =============================================================================
// AgentInterface
// =============================================================================
// Base class for agent-type plugins (ClaudeAgent, OpenAIAgent, etc.).
// Extends PluginInterface and defines the async generator yield-based frame
// protocol that the kernel uses to drive interactions.
//
// Subclasses MUST override:
//   - static metadata (pluginID, featureName, agentType, etc.)
//   - _createGenerator(params) — returns an async generator yielding blocks
//
// The interaction protocol:
//   1. Kernel calls agentPlugin.execute({ messages, agent, session, context })
//   2. Gets back an async generator
//   3. Kernel iterates with .next(result) — passing tool results back in
//   4. Each yielded block is a frame-like object ({ type, content, ... })
//   5. When generator returns, the interaction is done
// =============================================================================

import { PluginInterface } from '../plugin-loader/plugin-interface.mjs';

export class AgentInterface extends PluginInterface {
  // Static metadata — subclasses MUST override
  static pluginID     = null;
  static featureName  = null;
  static displayName  = null;
  static description  = null;
  static agentType    = null;
  static serviceType  = null;  // e.g. 'anthropic', 'openai' — used for cost tracking

  // ---------------------------------------------------------------------------
  // Public API — entry point for the kernel
  // ---------------------------------------------------------------------------

  async execute(params) {
    return this._createGenerator(params);
  }

  // ---------------------------------------------------------------------------
  // Workhorse method — subclasses MUST override
  // ---------------------------------------------------------------------------
  // Must return an async generator that yields frame-like block objects:
  //
  //   { type: 'Message',    content: { html: '...' },                authorType, authorID }
  //   { type: 'ToolCall',   content: { toolName: '...', arguments }, authorType, authorID }
  //   { type: 'Reflection', content: { text: '...' }, hidden: true,  authorType, authorID }
  //   { type: 'Done',       content: {} }
  //
  // Tool results are passed back via generator.next(result):
  //   let result = yield { type: 'ToolCall', ... };
  //   // result === { type: 'ToolResult', content: { output: '...' } }
  // ---------------------------------------------------------------------------

  async *_createGenerator(_params) {
    throw new Error(`${this.constructor.name}._createGenerator() not implemented`);
  }

  // ---------------------------------------------------------------------------
  // System prompt assembly
  // ---------------------------------------------------------------------------
  // Base implementation assembles core instructions + agent.instructions.
  // Subclasses can override to add API-specific formatting.
  // ---------------------------------------------------------------------------

  getSystemPrompt(agent, _context) {
    let parts = [];

    parts.push('You are a helpful assistant.');

    if (agent && agent.instructions)
      parts.push(agent.instructions);

    if (agent && agent.dmSummary)
      parts.push('--- Configuration from DM ---\n' + agent.dmSummary);

    return parts.join('\n\n');
  }

  // ---------------------------------------------------------------------------
  // Message assembly
  // ---------------------------------------------------------------------------
  // Base implementation returns messages as-is.
  // Subclasses customize for their specific API format (e.g., OpenAI, Anthropic).
  // ---------------------------------------------------------------------------

  assembleMessages(messages, _systemPrompt) {
    return messages;
  }

  // ---------------------------------------------------------------------------
  // Configuration validation
  // ---------------------------------------------------------------------------
  // Checks that agent has the minimum required configuration.
  // Returns { valid: true } or { valid: false, errors: [...] }.
  // ---------------------------------------------------------------------------

  validateConfig(agent) {
    let errors = [];

    if (!agent || !agent.name)
      errors.push('Agent must have a name');

    if (!agent || !agent.pluginID)
      errors.push('Agent must have a pluginID');

    if (errors.length > 0)
      return { valid: false, errors };

    return { valid: true };
  }

  // ---------------------------------------------------------------------------
  // Capability declaration
  // ---------------------------------------------------------------------------
  // Returns what this agent type supports. Subclasses override to declare
  // their actual capabilities.
  // ---------------------------------------------------------------------------

  getCapabilities() {
    return {
      streaming:  false,
      toolCalls:  false,
      reflection: false,
      images:     false,
    };
  }
}
