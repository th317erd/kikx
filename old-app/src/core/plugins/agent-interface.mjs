'use strict';

// =============================================================================
// AgentInterface
// =============================================================================

import { PluginInterface } from '../plugin-loader/plugin-interface.mjs';

export class AgentInterface extends PluginInterface {
  /** @type {string|null} */
  static pluginID     = null;
  /** @type {string|null} */
  static featureName  = null;
  /** @type {string|null} */
  static displayName  = null;
  /** @type {string|null} */
  static description  = null;
  /** @type {string|null} */
  static agentType    = null;
  /** @type {string|null} e.g. 'anthropic', 'openai' — used for cost tracking */
  static serviceType  = null;

  /**
   * Public API — entry point for the kernel.
   * @param {object} params
   * @param {import('../types').ChatMessage[]} params.messages
   * @param {import('../types').Agent} params.agent
   * @param {import('../types').CascadingContext} [params.context]
   * @returns {Promise<AsyncGenerator<import('../types').GeneratorBlock, void, any>>}
   */
  async execute(params) {
    return this._createGenerator(params);
  }

  /**
   * Workhorse method — subclasses MUST override.
   * Must return an async generator that yields frame-like block objects.
   * @param {object} _params
   * @returns {AsyncGenerator<import('../types').GeneratorBlock, void, any>}
   */
  async *_createGenerator(_params) {
    throw new Error(`${this.constructor.name}._createGenerator() not implemented`);
  }

  /**
   * System prompt assembly.
   * @param {import('../types').Agent} agent
   * @param {import('../types').CascadingContext} [_context]
   * @returns {string}
   */
  getSystemPrompt(agent, _context) {
    let parts = [];

    parts.push('You are a helpful assistant.');

    if (agent && agent.instructions)
      parts.push(agent.instructions);

    if (agent && agent.dmSummary)
      parts.push('--- Configuration from DM ---\n' + agent.dmSummary);

    return parts.join('\n\n');
  }

  /**
   * Message assembly. Base implementation returns messages as-is.
   * @param {import('../types').ChatMessage[]} messages
   * @param {string} [_systemPrompt]
   * @returns {import('../types').ChatMessage[]}
   */
  assembleMessages(messages, _systemPrompt) {
    return messages;
  }

  /**
   * Configuration validation.
   * @param {import('../types').Agent} agent
   * @returns {{ valid: boolean, errors?: string[] }}
   */
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

  /**
   * Capability declaration.
   * @returns {{ streaming: boolean, toolCalls: boolean, reflection: boolean, images: boolean }}
   */
  getCapabilities() {
    return {
      streaming:  false,
      toolCalls:  false,
      reflection: false,
      images:     false,
    };
  }
}
