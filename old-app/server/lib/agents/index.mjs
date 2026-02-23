'use strict';

import { BaseAgent } from './base-agent.mjs';
import { ClaudeAgent } from './claude-agent.mjs';

// Registry of available agent types
const agentRegistry = new Map();

// Register built-in agents
agentRegistry.set('claude', ClaudeAgent);

/**
 * Create an agent by type.
 *
 * @param {string} type - Agent type ('claude', 'openai', etc.)
 * @param {object} config - Agent configuration
 * @returns {BaseAgent} Agent instance
 * @throws {Error} If agent type is unknown
 */
export function createAgent(type, config = {}) {
  let AgentClass = agentRegistry.get(type);

  if (!AgentClass)
    throw new Error(`Unknown agent type: ${type}. Available types: ${getAgentTypes().join(', ')}`);

  return new AgentClass(config);
}

/**
 * Register a new agent type.
 *
 * @param {string} type - Agent type identifier
 * @param {typeof BaseAgent} agentClass - Agent class (must extend BaseAgent)
 */
export function registerAgent(type, agentClass) {
  if (!(agentClass.prototype instanceof BaseAgent) && agentClass !== BaseAgent)
    throw new Error('Agent class must extend BaseAgent');

  agentRegistry.set(type, agentClass);
}

/**
 * Unregister an agent type.
 *
 * @param {string} type - Agent type to unregister
 * @returns {boolean} True if agent was registered and removed
 */
export function unregisterAgent(type) {
  return agentRegistry.delete(type);
}

/**
 * Get list of registered agent types.
 *
 * @returns {Array<string>} Array of agent type identifiers
 */
export function getAgentTypes() {
  return Array.from(agentRegistry.keys());
}

/**
 * Check if an agent type is registered.
 *
 * @param {string} type - Agent type to check
 * @returns {boolean} True if registered
 */
export function hasAgentType(type) {
  return agentRegistry.has(type);
}

/**
 * Get the agent class for a type.
 *
 * @param {string} type - Agent type
 * @returns {typeof BaseAgent | undefined} Agent class or undefined
 */
export function getAgentClass(type) {
  return agentRegistry.get(type);
}

export {
  BaseAgent,
  ClaudeAgent,
};

export default {
  createAgent,
  registerAgent,
  unregisterAgent,
  getAgentTypes,
  hasAgentType,
  getAgentClass,
  BaseAgent,
  ClaudeAgent,
};
