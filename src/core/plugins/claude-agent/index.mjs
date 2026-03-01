'use strict';

// =============================================================================
// ClaudeAgent — Anthropic Claude API integration
// =============================================================================
// Implements AgentInterface using the Anthropic Messages API.
// Uses raw fetch() for zero external dependencies.
//
// Yield protocol:
//   { type: 'message',    content: { html } }
//   { type: 'tool-call',  content: { toolName, arguments, toolUseId } }
//   { type: 'reflection', content: { text }, hidden: true }
//   { type: 'done',       content: { usage: { inputTokens, outputTokens } } }
//
// Two-channel architecture:
//   1. Structured tool calls → server orchestration (tool_use blocks)
//   2. Inline HTML           → user display (text blocks)
// =============================================================================

import { AgentInterface } from '../agent-interface.mjs';

const DEFAULT_MODEL      = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = 4096;
const API_URL            = 'https://api.anthropic.com/v1/messages';
const API_VERSION        = '2023-06-01';

const HTML_INSTRUCTION = [
  'Output your responses in HTML format.',
  'Use standard HTML tags for formatting (p, strong, em, code, pre, ul, ol, li, h1-h6, table, etc).',
  'Do not use markdown.',
].join(' ');

export class ClaudeAgent extends AgentInterface {
  // Static metadata
  static pluginId    = 'claude-agent';
  static featureName = 'chat';
  static displayName = 'Claude';
  static description = 'Anthropic Claude AI agent';
  static agentType   = 'claude';

  // ---------------------------------------------------------------------------
  // Capabilities
  // ---------------------------------------------------------------------------

  getCapabilities() {
    return {
      streaming:  true,
      toolCalls:  true,
      reflection: true,
      images:     false,
    };
  }

  // ---------------------------------------------------------------------------
  // System prompt — HTML output instruction + agent instructions
  // ---------------------------------------------------------------------------

  getSystemPrompt(agent, _context) {
    let parts = [];

    parts.push('You are a helpful assistant.');
    parts.push(HTML_INSTRUCTION);

    if (agent && agent.instructions)
      parts.push(agent.instructions);

    return parts.join('\n\n');
  }

  // ---------------------------------------------------------------------------
  // Message assembly — convert internal frames to Anthropic format
  // ---------------------------------------------------------------------------
  // Internal frame format:
  //   { type, content, authorType, authorID }
  //
  // Anthropic format:
  //   { role: 'user'|'assistant', content: string|array }
  // ---------------------------------------------------------------------------

  assembleMessages(messages, _systemPrompt) {
    if (!messages || messages.length === 0)
      return [];

    let assembled = [];

    for (let msg of messages) {
      let converted = this._convertMessage(msg);

      if (converted)
        assembled.push(converted);
    }

    // Anthropic requires alternating user/assistant roles.
    // Merge consecutive same-role messages if necessary.
    return this._enforceAlternation(assembled);
  }

  _convertMessage(msg) {
    // Already in Anthropic format (role + content)
    if (msg.role)
      return { role: msg.role, content: msg.content };

    // Frame-like format
    switch (msg.type) {
      case 'message':
        return {
          role:    (msg.authorType === 'agent') ? 'assistant' : 'user',
          content: (msg.content && msg.content.html) || (msg.content && msg.content.text) || '',
        };

      case 'tool-call':
        return {
          role:    'assistant',
          content: [{
            type:  'tool_use',
            id:    (msg.content && msg.content.toolUseId) || `tool_${Date.now()}`,
            name:  msg.content && msg.content.toolName,
            input: (msg.content && msg.content.arguments) || {},
          }],
        };

      case 'tool-result':
        return {
          role:    'user',
          content: [{
            type:        'tool_result',
            tool_use_id: (msg.content && msg.content.toolUseId) || '',
            content:     (msg.content && msg.content.output) || '',
          }],
        };

      case 'reflection':
        // Reflection/thinking blocks are not sent back to the API;
        // they are internal-only. Skip them in assembled messages.
        return null;

      default:
        // Unknown type — skip
        return null;
    }
  }

  _enforceAlternation(messages) {
    if (messages.length <= 1)
      return messages;

    let result = [messages[0]];

    for (let i = 1; i < messages.length; i++) {
      let current  = messages[i];
      let previous = result[result.length - 1];

      if (current.role === previous.role) {
        // Merge: combine content
        if (typeof previous.content === 'string' && typeof current.content === 'string') {
          previous.content = previous.content + '\n\n' + current.content;
        } else {
          // Convert both to arrays and concatenate
          let prevArray = Array.isArray(previous.content)
            ? previous.content
            : [{ type: 'text', text: previous.content }];

          let currArray = Array.isArray(current.content)
            ? current.content
            : [{ type: 'text', text: current.content }];

          previous.content = prevArray.concat(currArray);
        }
      } else {
        result.push(current);
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Config validation
  // ---------------------------------------------------------------------------

  validateConfig(agent) {
    let baseResult = super.validateConfig(agent);

    if (!baseResult.valid)
      return baseResult;

    let errors = [];

    if (!agent.encryptedAPIKey)
      errors.push('Agent must have an encryptedAPIKey');

    if (errors.length > 0)
      return { valid: false, errors };

    return { valid: true };
  }

  // ---------------------------------------------------------------------------
  // Generator — main workhorse
  // ---------------------------------------------------------------------------
  // Multi-turn loop:
  //   1. Call API with current messages
  //   2. Yield blocks from streaming response
  //   3. If tool-call yielded, receive result via generator.next(result)
  //   4. Append tool-call + result to messages, loop back to step 1
  //   5. When no tool calls remain, yield done block
  // ---------------------------------------------------------------------------

  async *_createGenerator(params) {
    let { messages: rawMessages, agent, session, context } = params;

    // Resolve API key
    let apiKey = params.apiKey;

    if (!apiKey && agent && agent.encryptedAPIKey && context) {
      let keystore = context.getProperty
        ? context.getProperty('keystore')
        : (context.keystore || null);

      if (keystore) {
        let decrypted = keystore.decrypt(
          (typeof agent.encryptedAPIKey === 'string')
            ? JSON.parse(agent.encryptedAPIKey)
            : agent.encryptedAPIKey,
        );

        apiKey = decrypted.toString('utf8');
      }
    }

    if (!apiKey)
      throw new Error('No API key available — provide apiKey in params or encrypted key on agent');

    // Build system prompt
    let systemPrompt = this.getSystemPrompt(agent, context);

    // Assemble initial messages
    let apiMessages = this.assembleMessages(rawMessages, systemPrompt);

    // Model config
    let model     = (agent && agent.model) || DEFAULT_MODEL;
    let maxTokens = (agent && agent.maxTokens) || DEFAULT_MAX_TOKENS;

    // Multi-turn loop
    let totalInputTokens  = 0;
    let totalOutputTokens = 0;

    while (true) {
      let pendingToolCalls = [];
      let usage            = { inputTokens: 0, outputTokens: 0 };

      // Stream the API response
      let events = this._streamAPI(apiKey, systemPrompt, apiMessages, { model, maxTokens });

      // State tracking for accumulating content blocks
      let blocks          = new Map(); // index -> { type, data }
      let hadToolCalls    = false;

      for await (let event of events) {
        if (event.type === 'message_start') {
          if (event.message && event.message.usage)
            usage.inputTokens = event.message.usage.input_tokens || 0;

          continue;
        }

        if (event.type === 'content_block_start') {
          let block = event.content_block || {};
          blocks.set(event.index, { type: block.type, data: '' });

          if (block.type === 'tool_use')
            blocks.set(event.index, { type: 'tool_use', data: '', id: block.id, name: block.name });

          continue;
        }

        if (event.type === 'content_block_delta') {
          let block = blocks.get(event.index);

          if (!block)
            continue;

          let delta = event.delta || {};

          if (delta.type === 'text_delta')
            block.data += delta.text || '';
          else if (delta.type === 'input_json_delta')
            block.data += delta.partial_json || '';
          else if (delta.type === 'thinking_delta')
            block.data += delta.thinking || '';

          continue;
        }

        if (event.type === 'content_block_stop') {
          let block = blocks.get(event.index);

          if (!block)
            continue;

          if (block.type === 'text') {
            yield {
              type:       'message',
              content:    { html: block.data },
              authorType: 'agent',
              authorID:   (agent && agent.id) || null,
            };
          } else if (block.type === 'tool_use') {
            hadToolCalls = true;

            let toolArguments = {};

            try {
              if (block.data)
                toolArguments = JSON.parse(block.data);
            } catch (_e) {
              // Malformed JSON — pass raw string
              toolArguments = { _raw: block.data };
            }

            let toolCall = {
              type:       'tool-call',
              content:    {
                toolName:  block.name,
                arguments: toolArguments,
                toolUseId: block.id,
              },
              authorType: 'agent',
              authorID:   (agent && agent.id) || null,
            };

            pendingToolCalls.push(toolCall);

            // Yield the tool call and receive the result
            let result = yield toolCall;

            if (result) {
              pendingToolCalls[pendingToolCalls.length - 1].result = result;
            }
          } else if (block.type === 'thinking') {
            yield {
              type:       'reflection',
              content:    { text: block.data },
              hidden:     true,
              authorType: 'agent',
              authorID:   (agent && agent.id) || null,
            };
          }

          blocks.delete(event.index);
          continue;
        }

        if (event.type === 'message_delta') {
          let delta = event.delta || {};
          if (event.usage)
            usage.outputTokens = event.usage.output_tokens || 0;

          continue;
        }

        // message_stop, ping — no action needed
      }

      totalInputTokens  += usage.inputTokens;
      totalOutputTokens += usage.outputTokens;

      // If we had tool calls, append them + results and loop
      if (hadToolCalls && pendingToolCalls.length > 0) {
        // Add assistant message with tool_use blocks
        let toolUseBlocks = pendingToolCalls.map((tc) => ({
          type:  'tool_use',
          id:    tc.content.toolUseId,
          name:  tc.content.toolName,
          input: tc.content.arguments,
        }));

        apiMessages.push({ role: 'assistant', content: toolUseBlocks });

        // Add user message with tool_result blocks
        let toolResultBlocks = pendingToolCalls.map((tc) => ({
          type:        'tool_result',
          tool_use_id: tc.content.toolUseId,
          content:     (tc.result && tc.result.content && tc.result.content.output) || '',
        }));

        apiMessages.push({ role: 'user', content: toolResultBlocks });

        // Continue the loop — make another API call
        continue;
      }

      // No tool calls — we're done
      break;
    }

    yield {
      type:    'done',
      content: {
        usage: {
          inputTokens:  totalInputTokens,
          outputTokens: totalOutputTokens,
        },
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Anthropic API streaming — async generator of parsed SSE events
  // ---------------------------------------------------------------------------

  async *_streamAPI(apiKey, systemPrompt, messages, options = {}) {
    let { model, maxTokens } = options;

    let body = {
      model:      model || DEFAULT_MODEL,
      max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
      system:     systemPrompt,
      messages,
      stream:     true,
    };

    let response = await fetch(API_URL, {
      method:  'POST',
      headers: {
        'content-type':     'application/json',
        'x-api-key':        apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      let errorBody = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errorBody}`);
    }

    // Parse SSE stream
    yield* this._parseSSEStream(response.body);
  }

  // ---------------------------------------------------------------------------
  // SSE stream parser — converts ReadableStream to parsed JSON events
  // ---------------------------------------------------------------------------

  async *_parseSSEStream(readableStream) {
    let reader  = readableStream.getReader();
    let decoder = new TextDecoder();
    let buffer  = '';

    try {
      while (true) {
        let { done, value } = await reader.read();

        if (done)
          break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        let lines = buffer.split('\n');

        // Keep the last (possibly incomplete) line in the buffer
        buffer = lines.pop() || '';

        let eventType = null;

        for (let line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
            continue;
          }

          if (line.startsWith('data: ')) {
            let jsonStr = line.slice(6);

            try {
              let parsed = JSON.parse(jsonStr);

              // Attach event type if the parsed data doesn't already have 'type'
              if (eventType && !parsed.type)
                parsed.type = eventType;

              yield parsed;
            } catch (_e) {
              // Malformed JSON line — skip
            }

            eventType = null;
            continue;
          }

          // Empty line or other — reset event type
          if (line.trim() === '')
            eventType = null;
        }
      }

      // Flush any remaining buffer
      if (buffer.trim()) {
        let lines = buffer.split('\n');
        let eventType = null;

        for (let line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
            continue;
          }

          if (line.startsWith('data: ')) {
            try {
              let parsed = JSON.parse(line.slice(6));

              if (eventType && !parsed.type)
                parsed.type = eventType;

              yield parsed;
            } catch (_e) {
              // skip
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

// =============================================================================
// Plugin setup() — registers ClaudeAgent with the plugin registry
// =============================================================================

export function setup(pluginContext) {
  let { context } = pluginContext;

  // Register the agent type on context so the interaction loop can find it
  let agentTypes = context.getProperty
    ? context.getProperty('agentTypes')
    : (context.agentTypes || null);

  if (!agentTypes) {
    agentTypes = new Map();

    if (context.setProperty)
      context.setProperty('agentTypes', agentTypes);
  }

  agentTypes.set('claude', ClaudeAgent);

  // Return teardown closure
  return () => {
    agentTypes.delete('claude');
  };
}
