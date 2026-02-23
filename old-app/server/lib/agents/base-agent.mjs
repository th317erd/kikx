'use strict';

/**
 * Base Agent class.
 * All agent implementations must extend this class and implement the abstract methods.
 */
export class BaseAgent {
  /**
   * Create a new agent.
   *
   * @param {object} config - Agent configuration
   * @param {string} [config.apiKey] - API key for the agent's service
   * @param {string} [config.apiUrl] - Custom API URL (optional)
   * @param {string} [config.system] - System prompt
   * @param {Array} [config.tools] - Available tools
   */
  constructor(config = {}) {
    this.apiKey = config.apiKey;
    this.apiUrl = config.apiUrl;
    this.system = config.system || '';
    this.tools  = config.tools || [];
  }

  /**
   * Get the agent type identifier.
   *
   * @returns {string} Agent type (e.g., 'claude', 'openai')
   */
  static get type() {
    throw new Error('Agent subclass must define static type property');
  }

  /**
   * Send a message and get the agent's response.
   * Handles the full agentic loop (tool_use → execute → tool_result → repeat).
   *
   * @param {Array<{role: string, content: string|Array}>} messages - Conversation history
   * @param {object} [options] - Additional options
   * @param {AbortSignal} [options.signal] - AbortSignal for cancellation
   * @returns {Promise<AgentResponse>} Agent's response
   */
  async sendMessage(messages, options = {}) {
    throw new Error('sendMessage must be implemented by subclass');
  }

  /**
   * Send a message and stream the response.
   *
   * @param {Array<{role: string, content: string|Array}>} messages - Conversation history
   * @param {object} [options] - Additional options
   * @param {AbortSignal} [options.signal] - AbortSignal for cancellation
   * @returns {AsyncGenerator<StreamChunk>} Async generator of response chunks
   */
  async *sendMessageStream(messages, options = {}) {
    throw new Error('sendMessageStream must be implemented by subclass');
  }

  /**
   * Execute a tool by name.
   *
   * @param {string} name - Tool name
   * @param {object} input - Tool input parameters
   * @param {AbortSignal} [signal] - AbortSignal for cancellation
   * @returns {Promise<string>} Tool result as string
   */
  async executeTool(name, input, signal) {
    let tool = this.tools.find((t) => t.name === name);

    if (!tool)
      throw new Error(`Tool "${name}" not found`);

    if (typeof tool.execute !== 'function')
      throw new Error(`Tool "${name}" has no execute function`);

    return await tool.execute(input, signal);
  }

  /**
   * Get tool definitions in the format expected by the API.
   *
   * @returns {Array<ToolDefinition>} Tool definitions
   */
  getToolDefinitions() {
    return this.tools.map((tool) => ({
      name:         tool.name,
      description:  tool.description,
      input_schema: tool.input_schema || tool.inputSchema,
    }));
  }

  /**
   * Set the available tools for this agent.
   *
   * @param {Array<Tool>} tools - Tools to make available
   */
  setTools(tools) {
    this.tools = tools;
  }

  /**
   * Add a tool to this agent.
   *
   * @param {Tool} tool - Tool to add
   */
  addTool(tool) {
    // Remove existing tool with same name
    this.tools = this.tools.filter((t) => t.name !== tool.name);
    this.tools.push(tool);
  }
}

/**
 * @typedef {object} AgentResponse
 * @property {Array<ContentBlock>} content - Response content blocks
 * @property {Array<ToolCall>} [toolCalls] - Tool calls made during response
 * @property {Array<Message>} [toolMessages] - Messages from tool execution loop
 * @property {string} stopReason - Why the agent stopped ('end_turn', 'tool_use', etc.)
 */

/**
 * @typedef {object} ContentBlock
 * @property {'text'|'tool_use'|'tool_result'} type
 * @property {string} [text] - For text blocks
 * @property {string} [id] - For tool_use blocks
 * @property {string} [name] - For tool_use blocks
 * @property {object} [input] - For tool_use blocks
 * @property {string} [tool_use_id] - For tool_result blocks
 * @property {string} [content] - For tool_result blocks
 */

/**
 * @typedef {object} ToolCall
 * @property {string} id - Tool use ID
 * @property {string} name - Tool name
 * @property {object} input - Tool input
 * @property {string} result - Tool result
 */

/**
 * @typedef {object} Tool
 * @property {string} name - Tool name
 * @property {string} description - Tool description
 * @property {object} input_schema - JSON schema for input
 * @property {function(object, AbortSignal?): Promise<string>} execute - Execution function
 */

/**
 * @typedef {object} StreamChunk
 * @property {'text'|'tool_use_start'|'tool_use_input'|'tool_result'|'done'} type
 * @property {string} [text] - For text chunks
 * @property {object} [toolUse] - For tool_use chunks
 * @property {string} [stopReason] - For done chunks
 */

export default BaseAgent;
