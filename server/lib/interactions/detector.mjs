'use strict';

// ============================================================================
// Interaction Detector
// ============================================================================
// Detects and executes interaction requests from AI agent responses.
// The AI requests interactions by outputting <interaction> tags containing JSON.
//
// Flow:
// 1. Agent outputs <interaction>JSON</interaction> tag(s) anywhere in response
// 2. System detects and parses all interaction tags
// 3. For each interaction:
//    a. Check permissions via allowed()
//    b. Send 'pending' status to agent
//    c. Execute the interaction
//    d. Send 'completed' or 'failed' status to agent
// 4. Format all results as feedback for the agent

import { getInteractionBus, queueAgentMessage, TARGETS } from './bus.mjs';
import { checkSystemMethodAllowed } from './functions/system.mjs';
import { createRequestFrame, createResultFrame } from '../frames/broadcast.mjs';
import { beforeTool, afterTool } from '../plugins/hooks.mjs';
import { evaluate as evaluatePermission, Action as PermissionAction } from '../permissions/index.mjs';
import { requestPermissionPrompt } from '../permissions/prompt.mjs';

// Regex to find <interaction> tag starts (with or without attributes)
// Handles both <interaction> and <interaction type="...">, since LLMs sometimes
// add HTML attributes despite being instructed to use plain <interaction> tags.
const INTERACTION_START_REGEX = /<interaction(?:\s[^>]*)?>[\s]*/g;

// Maximum parse attempts per tag to prevent infinite loops
const MAX_PARSE_ATTEMPTS = 5;

/**
 * Find the closing </interaction> for a tag that produces valid JSON.
 * Handles cases where the JSON payload itself contains </interaction> sequences.
 *
 * Strategy: Try parsing at each </interaction> we find. If JSON.parse throws,
 * move cursor forward and keep looking until we find valid JSON,
 * hit EOF, or exceed max attempts.
 *
 * @param {string} text - Full text
 * @param {number} startIndex - Index after the opening <interaction>
 * @returns {Object|null} { endIndex, json } or null if no valid close found
 */
function findValidClosing(text, startIndex) {
  let searchFrom = startIndex;
  let attempts = 0;
  const CLOSE_TAG = '</interaction>';

  while (attempts < MAX_PARSE_ATTEMPTS) {
    let closeIndex = text.indexOf(CLOSE_TAG, searchFrom);

    if (closeIndex === -1) {
      return null; // No more closing tags - EOF
    }

    // Try to parse the content up to this </interaction>
    let jsonStr = text.slice(startIndex, closeIndex).trim();

    try {
      let parsed = JSON.parse(jsonStr);
      return { endIndex: closeIndex + CLOSE_TAG.length, json: parsed };
    } catch (e) {
      // Invalid JSON - this </interaction> might be inside a string, keep looking
      searchFrom = closeIndex + CLOSE_TAG.length;
      attempts++;
    }
  }

  // Exceeded max attempts - give up on this tag
  return null;
}

/**
 * Extract text content from response content (handles both string and array formats).
 *
 * @param {string|Array} content - Response content
 * @returns {string} Extracted text
 */
function extractTextContent(content) {
  if (typeof content === 'string')
    return content;

  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }

  return '';
}

/**
 * Strip security-sensitive properties from an interaction.
 * These properties CAN NOT be set by the agent - they are reserved for
 * system use (e.g., sender_id for user authorization).
 *
 * @param {Object} interaction - Interaction object
 * @returns {Object} Interaction with sensitive properties stripped
 */
function stripSensitiveProperties(interaction) {
  // Create shallow copy to avoid mutating original
  let clean = { ...interaction };

  // Strip sender_id - only the system can set this to indicate
  // the interaction originated from an authenticated user
  delete clean.sender_id;

  // Strip any other future security-sensitive root properties
  // (payload contents are NOT stripped - only root-level properties)

  return clean;
}

/**
 * Validate an interaction object.
 *
 * @param {Object} interaction - Interaction object
 * @returns {boolean} True if valid
 */
function validateInteraction(interaction) {
  if (typeof interaction !== 'object' || interaction === null)
    return false;

  // Must have target_id and target_property
  if (!interaction.target_id || typeof interaction.target_id !== 'string')
    return false;

  if (!interaction.target_property || typeof interaction.target_property !== 'string')
    return false;

  // interaction_id is required (agent generates it)
  if (!interaction.interaction_id || typeof interaction.interaction_id !== 'string')
    return false;

  return true;
}

/**
 * Parse HTML attributes from an <interaction> opening tag into an interaction object.
 * Handles the case where the LLM uses HTML attribute format instead of JSON body:
 *   <interaction type="websearch" query="latest news"></interaction>
 *
 * @param {string} openingTag - The full matched opening tag (e.g., '<interaction type="websearch">')
 * @param {string} bodyContent - Content between opening and closing tags
 * @returns {Object|null} Parsed interaction object, or null if not parseable
 */
function parseAttributeInteraction(openingTag, bodyContent) {
  // Extract attributes from the opening tag
  let attributeRegex = /(\w+)=["']([^"']*)["']/g;
  let attributes     = {};
  let attrMatch;

  while ((attrMatch = attributeRegex.exec(openingTag)) !== null) {
    attributes[attrMatch[1]] = attrMatch[2];
  }

  // Need at least a type/target_property to build an interaction
  let targetProperty = attributes.type || attributes.target_property;
  if (!targetProperty)
    return null;

  // Build a standard interaction object from attributes
  let interaction = {
    interaction_id:  attributes.interaction_id || attributes.id || `attr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    target_id:       attributes.target_id || '@system',
    target_property: targetProperty,
    payload:         {},
  };

  // Populate payload from remaining attributes
  for (let [key, value] of Object.entries(attributes)) {
    if (['type', 'target_property', 'target_id', 'interaction_id', 'id'].includes(key))
      continue;
    interaction.payload[key] = value;
  }

  // If there's body content that's not JSON, use it as the primary payload value
  let trimmedBody = (bodyContent || '').trim();
  if (trimmedBody && !trimmedBody.startsWith('{') && !trimmedBody.startsWith('[')) {
    interaction.payload.query = interaction.payload.query || trimmedBody;
  }

  return interaction;
}

/**
 * Detect interaction tags anywhere in the response.
 * Pattern: <interaction>JSON</interaction> (can appear multiple times, interlaced with text)
 *
 * Handles edge cases:
 * - JSON payload containing </interaction> sequences
 * - <interaction> tags with HTML attributes (LLM format deviation)
 * - Empty body with attributes: <interaction type="websearch" query="..."></interaction>
 *
 * Interaction format:
 *   Single: { interaction_id, target_id, target_property, payload }
 *   Array:  [{ interaction_id, target_id, target_property, payload }, ...]
 *
 * @param {string|Array} content - Response content
 * @returns {Object|null} Parsed interactions, or null if no valid interaction tags found
 */
export function detectInteractions(content) {
  let text = extractTextContent(content);

  // Find all <interaction> tags
  let allInteractions = [];
  let match;

  // Reset regex state
  INTERACTION_START_REGEX.lastIndex = 0;

  while ((match = INTERACTION_START_REGEX.exec(text)) !== null) {
    let openingTag = match[0];
    let startIndex = match.index + openingTag.length;

    // Find valid closing that produces valid JSON
    let result = findValidClosing(text, startIndex);

    if (result) {
      let parsed = result.json;

      // Single interaction object
      if (!Array.isArray(parsed)) {
        let clean = stripSensitiveProperties(parsed);
        if (validateInteraction(clean))
          allInteractions.push(clean);
      } else {
        // Array of interactions
        for (let interaction of parsed) {
          let clean = stripSensitiveProperties(interaction);
          if (validateInteraction(clean))
            allInteractions.push(clean);
        }
      }

      // Move past this tag to avoid re-matching
      INTERACTION_START_REGEX.lastIndex = result.endIndex;
      continue;
    }

    // JSON parsing failed — try attribute-based fallback
    // This handles: <interaction type="websearch" query="...">body text</interaction>
    let closeIndex = text.indexOf('</interaction>', startIndex);
    if (closeIndex !== -1) {
      let bodyContent = text.slice(startIndex, closeIndex).trim();
      let attrInteraction = parseAttributeInteraction(openingTag, bodyContent);

      if (attrInteraction) {
        let clean = stripSensitiveProperties(attrInteraction);
        if (validateInteraction(clean))
          allInteractions.push(clean);
      }

      INTERACTION_START_REGEX.lastIndex = closeIndex + '</interaction>'.length;
    }
  }

  if (allInteractions.length === 0)
    return null;

  return {
    mode:         (allInteractions.length === 1) ? 'single' : 'sequential',
    interactions: allInteractions,
  };
}

/**
 * Execute interactions through the InteractionBus.
 * Sends status updates to the agent via @agent target.
 * Creates REQUEST/RESULT frames when context has parentFrameId and agentId.
 *
 * @param {Object} interactionBlock - Parsed interaction block from detectInteractions
 * @param {Object} context - Execution context
 * @param {number} [context.sessionId] - Session ID
 * @param {number} [context.userId] - User ID
 * @param {number} [context.agentId] - Agent ID (for frame creation)
 * @param {string} [context.parentFrameId] - Parent frame ID (for frame creation)
 * @param {number} [context.senderId] - Sender ID (user ID if from authenticated user, null if from agent)
 * @returns {Promise<Object>} Execution results
 */
export async function executeInteractions(interactionBlock, context) {
  let bus     = getInteractionBus();
  let results = [];

  // Check if we should create frames (need sessionId, userId, agentId, and parentFrameId)
  let canCreateFrames = !!(
    context.sessionId &&
    context.userId &&
    context.agentId &&
    context.parentFrameId
  );

  for (let interactionData of interactionBlock.interactions) {
    let agentInteractionId = interactionData.interaction_id;
    let requestFrame = null;

    // Step 1: Check permissions for @system targets
    if (interactionData.target_id === TARGETS.SYSTEM) {
      let permCheck = await checkSystemMethodAllowed(
        interactionData.target_property,
        interactionData.payload,
        context
      );

      if (!permCheck.allowed) {
        // Queue denied status for agent
        queueAgentMessage(context.sessionId, agentInteractionId, 'interaction_update', {
          status: 'denied',
          reason: permCheck.reason,
        });

        results.push({
          interaction_id:  agentInteractionId,
          target_id:       interactionData.target_id,
          target_property: interactionData.target_property,
          status:          'denied',
          reason:          permCheck.reason,
        });

        continue;
      }
    }

    // Step 1.5: Execute BEFORE_TOOL hook (plugin permission gating)
    // This allows plugins to inspect, modify, or block tool execution
    // before it happens — analogous to BEFORE_COMMAND for commands.
    let toolData = {
      name:  interactionData.target_property,
      input: interactionData.payload,
    };

    let hookContext = {
      sessionId: context.sessionId,
      userId:    context.userId,
      agentId:   context.agentId,
      targetId:  interactionData.target_id,
    };

    try {
      let hookResult = await beforeTool(toolData, hookContext);

      // If hook returns blocked: true, deny the interaction
      if (hookResult && hookResult.blocked) {
        let blockReason = hookResult.reason || 'Blocked by plugin';

        queueAgentMessage(context.sessionId, agentInteractionId, 'interaction_update', {
          status: 'denied',
          reason: blockReason,
        });

        results.push({
          interaction_id:  agentInteractionId,
          target_id:       interactionData.target_id,
          target_property: interactionData.target_property,
          status:          'denied',
          reason:          blockReason,
        });

        continue;
      }

      // If hook modified the tool data, apply the changes
      if (hookResult && typeof hookResult === 'object' && !hookResult.blocked) {
        if (hookResult.name)
          interactionData.target_property = hookResult.name;
        if (hookResult.input !== undefined)
          interactionData.payload = hookResult.input;
      }
    } catch (hookError) {
      // Hook errors should not break the pipeline — log and continue
      console.error(`BEFORE_TOOL hook error for '${toolData.name}':`, hookError.message);
    }

    // Step 1.75: Permission engine evaluation
    // User-originated interactions (senderId present) are pre-authorized.
    // Agent-originated interactions MUST pass the permission engine.
    // If the permission engine cannot run (missing db, missing agentId),
    // the interaction is DENIED — security gates fail closed, never open.
    if (!context.senderId) {
      if (!context.agentId || !context.db) {
        // Cannot evaluate permissions — deny for safety
        let reason = !context.db
          ? 'Permission check failed — no database available'
          : 'Permission check failed — no agent context';

        console.error(`[Security] ${reason} for '${interactionData.target_property}'`);

        queueAgentMessage(context.sessionId, agentInteractionId, 'interaction_update', {
          status: 'denied',
          reason,
        });

        results.push({
          interaction_id:  agentInteractionId,
          target_id:       interactionData.target_id,
          target_property: interactionData.target_property,
          status:          'denied',
          reason,
        });

        continue;
      }

      let permSubject = {
        type: 'agent',
        id:   context.agentId,
        name: context.agent?.name || `Agent #${context.agentId}`,
      };

      let permResource = {
        type: interactionData.target_id === TARGETS.SYSTEM ? 'tool' : 'ability',
        name: interactionData.target_property,
      };

      let permContext = {
        sessionId: context.sessionId ? parseInt(context.sessionId, 10) : null,
        ownerId:   context.userId || null,
      };

      try {
        let permResult = evaluatePermission(permSubject, permResource, permContext, context.db);

        if (permResult.action === PermissionAction.DENY) {
          let denyReason = 'Denied by permission rule';

          queueAgentMessage(context.sessionId, agentInteractionId, 'interaction_update', {
            status: 'denied',
            reason: denyReason,
          });

          results.push({
            interaction_id:  agentInteractionId,
            target_id:       interactionData.target_id,
            target_property: interactionData.target_property,
            status:          'denied',
            reason:          denyReason,
          });

          continue;
        }

        if (permResult.action === PermissionAction.PROMPT) {
          // requestPermissionPrompt creates the system message frame internally
          // and returns a Promise that resolves when the user submits
          let promptResult = await requestPermissionPrompt(permSubject, permResource, {
            ...permContext,
            userId: context.userId,
            db:     context.db,
          });

          if (promptResult.action === PermissionAction.DENY) {
            let denyReason = promptResult.reason || 'Denied by user';

            queueAgentMessage(context.sessionId, agentInteractionId, 'interaction_update', {
              status: 'denied',
              reason: denyReason,
            });

            results.push({
              interaction_id:  agentInteractionId,
              target_id:       interactionData.target_id,
              target_property: interactionData.target_property,
              status:          'denied',
              reason:          denyReason,
            });

            continue;
          }

          // Permission granted — fall through to execution
        }

        // action === 'allow' — fall through to execution
      } catch (permError) {
        // Permission errors fail-safe to DENY — never allow on error
        console.error(`[Security] Permission evaluation error for '${interactionData.target_property}':`, permError.message);

        queueAgentMessage(context.sessionId, agentInteractionId, 'interaction_update', {
          status: 'denied',
          reason: 'Permission check failed — denied for safety',
        });

        results.push({
          interaction_id:  agentInteractionId,
          target_id:       interactionData.target_id,
          target_property: interactionData.target_property,
          status:          'denied',
          reason:          'Permission check failed — denied for safety',
        });

        continue;
      }
    }

    // Step 2: Create REQUEST frame (before execution)
    if (canCreateFrames) {
      try {
        requestFrame = createRequestFrame({
          sessionId: parseInt(context.sessionId, 10),
          userId:    context.userId,
          agentId:   context.agentId,
          parentId:  context.parentFrameId,
          action:    interactionData.target_property,
          data:      interactionData.payload,
        }, context.db);
      } catch (error) {
        console.error('Failed to create REQUEST frame:', error);
      }
    }

    // Step 3: Queue pending status for agent
    queueAgentMessage(context.sessionId, agentInteractionId, 'interaction_update', {
      status: 'pending',
      permit: 'allowed',
    });

    // Step 4: Create and send the interaction
    // Include senderId if provided - this indicates the interaction originated
    // from an authenticated user (secure/authorized)
    let interactionOptions = {
      sourceId:      agentInteractionId,
      sessionId:     context.sessionId,
      userId:        context.userId,
      sourceAgentId: context.agent?.id || context.agentId || null,
    };

    // Only add senderId if explicitly provided in context
    // This cannot be spoofed by agents because we strip sender_id during parsing
    if (context.senderId !== undefined) {
      interactionOptions.senderId = context.senderId;
    }

    let interaction = bus.create(
      interactionData.target_id,
      interactionData.target_property,
      interactionData.payload,
      interactionOptions
    );

    // Attach execution context for system functions (not part of the interaction
    // protocol, but accessible to handlers that need session/auth state)
    interaction._executionContext = context;

    try {
      let result = await bus.send(interaction);

      // Check if the function returned a failed status (common for @system functions)
      let functionFailed = result && typeof result === 'object' && result.status === 'failed';

      // Step 5: Create RESULT frame (after execution)
      if (canCreateFrames && requestFrame) {
        try {
          createResultFrame({
            sessionId: parseInt(context.sessionId, 10),
            userId:    context.userId,
            parentId:  requestFrame.id,
            agentId:   context.agentId,
            result:    functionFailed
              ? { status: 'failed', error: result.error }
              : { status: 'completed', data: result },
          }, context.db);
        } catch (error) {
          console.error('Failed to create RESULT frame:', error);
        }
      }

      // Handle function failures that didn't throw
      if (functionFailed) {
        queueAgentMessage(context.sessionId, agentInteractionId, 'interaction_update', {
          status: 'failed',
          error:  result.error,
        });

        results.push({
          interaction_id:  agentInteractionId,
          target_id:       interactionData.target_id,
          target_property: interactionData.target_property,
          status:          'failed',
          error:           result.error,
          requestFrameId:  requestFrame?.id,
        });
        continue;
      }

      // Step 5.5: Execute AFTER_TOOL hook (post-execution)
      try {
        await afterTool(
          { name: interactionData.target_property, input: interactionData.payload, result },
          hookContext,
        );
      } catch (afterHookError) {
        console.error(`AFTER_TOOL hook error for '${interactionData.target_property}':`, afterHookError.message);
      }

      // Step 6: Queue completed status for agent
      queueAgentMessage(context.sessionId, agentInteractionId, 'interaction_update', {
        status: 'completed',
        result: result,
      });

      results.push({
        interaction_id:  agentInteractionId,
        target_id:       interactionData.target_id,
        target_property: interactionData.target_property,
        status:          'completed',
        result:          result,
        requestFrameId:  requestFrame?.id,
      });

    } catch (error) {
      // Create RESULT frame for failure
      if (canCreateFrames && requestFrame) {
        try {
          createResultFrame({
            sessionId: parseInt(context.sessionId, 10),
            userId:    context.userId,
            parentId:  requestFrame.id,
            agentId:   context.agentId,
            result:    {
              status: 'failed',
              error:  error.message,
            },
          }, context.db);
        } catch (frameError) {
          console.error('Failed to create RESULT frame:', frameError);
        }
      }

      // Queue failed status for agent
      queueAgentMessage(context.sessionId, agentInteractionId, 'interaction_update', {
        status: 'failed',
        error:  error.message,
      });

      results.push({
        interaction_id:  agentInteractionId,
        target_id:       interactionData.target_id,
        target_property: interactionData.target_property,
        status:          'failed',
        error:           error.message,
        requestFrameId:  requestFrame?.id,
      });
    }
  }

  return {
    mode:    interactionBlock.mode,
    results: results,
  };
}

/**
 * Truncate a string to a maximum length, adding ellipsis if needed.
 *
 * @param {string} str - String to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated string
 */
function truncateResult(str, maxLength = 2000) {
  if (!str || str.length <= maxLength)
    return str;

  return str.slice(0, maxLength) + '\n... [truncated]';
}

/**
 * Format interaction results as feedback for the AI.
 * Truncates large results to prevent token bloat.
 *
 * @param {Object} executionResult - Result from executeInteractions
 * @returns {string} Formatted feedback string
 */
export function formatInteractionFeedback(executionResult) {
  if (!executionResult.results || executionResult.results.length === 0)
    return 'No results.';

  return executionResult.results.map((r) => {
    let prefix = `[${r.target_id}:${r.target_property}] interaction_id='${r.interaction_id}'`;

    if (r.status === 'completed') {
      let resultStr;

      // Handle result object with status/result structure
      if (r.result && typeof r.result === 'object') {
        if (r.result.status === 'completed' && r.result.result) {
          resultStr = (typeof r.result.result === 'string')
            ? r.result.result
            : JSON.stringify(r.result.result, null, 2);
        } else if (r.result.status === 'denied') {
          return `${prefix} denied: ${r.result.reason || 'Permission denied'}`;
        } else if (r.result.status === 'failed') {
          return `${prefix} failed: ${r.result.error || 'Unknown error'}`;
        } else {
          resultStr = JSON.stringify(r.result, null, 2);
        }
      } else {
        resultStr = (typeof r.result === 'string')
          ? r.result
          : JSON.stringify(r.result, null, 2);
      }

      // Truncate large results to prevent token bloat
      resultStr = truncateResult(resultStr, 2000);

      return `${prefix} completed:\n${resultStr}`;
    }

    if (r.status === 'failed') {
      return `${prefix} failed: ${r.error}`;
    }

    if (r.status === 'denied') {
      return `${prefix} denied: ${r.reason}`;
    }

    return `${prefix} status: ${r.status}`;
  }).join('\n\n');
}

export default {
  detectInteractions,
  executeInteractions,
  formatInteractionFeedback,
};
