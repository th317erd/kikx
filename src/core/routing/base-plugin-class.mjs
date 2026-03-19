'use strict';

import { truncateContent, truncateConversation } from '../interaction/context-truncation.mjs';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_COMPACTION_PROMPT = `Your job is to compact/compress the following memories/conversation. It is VITALLY IMPORTANT that you identify things of importance, and that these survive compaction/compression, things such as file paths, secrets, keys, how to execute commands, tool run ids, other important ids, and any other context-related important items that are vital, and ensure they SURVIVE your compression. Beyond that, I would like you to take an approach where the older the content the more aggressively you compress. Think of this as a gradient of resolution: recent memories/conversations have high resolution, and won't be compressed quite as much, whereas older things will be more aggressively compressed. Useless or unimportant things should undergo more compression, or be stripped altogether, regardless of where they are in the history. It is VITAL that the essence of the memory remains intact, such that agents can continue with their current tasks uninterrupted and without being confused. The context you need to compact/compress is as follows:`;

// Default context window used when no model info is available
const DEFAULT_CONTEXT_WINDOW = 200000;

// =============================================================================
// BasePluginClass — Base class for all routing plugins
// =============================================================================
// Fresh instances are created per routing cycle (not long-lived singletons).
// Subclasses override process(), onChange(), and checkPermission() to implement
// plugin-specific behavior within the middleware chain.
//
// Lifecycle:
//   1. Router creates new instance with context
//   2. Router calls process(next, done)
//   3. Plugin does work, then calls next(ctx) to continue or done(ctx) to stop
//   4. Instance is discarded after the routing cycle completes
// =============================================================================

export class BasePluginClass {
  constructor(context) {
    this._context = context;
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  // Returns the context object passed to the constructor.
  get context() {
    return this._context;
  }

  // Returns the logger from context, falling back to the global console.
  get logger() {
    return this._context.logger || console;
  }

  // ---------------------------------------------------------------------------
  // Primary handler — override in subclasses
  // ---------------------------------------------------------------------------

  // Called by the router's middleware chain.
  // `next(ctx)` continues to the next plugin in the chain.
  // `done(ctx)` stops the chain immediately.
  // Default behavior: pass through to the next plugin.
  async process(next, done) {
    return await next(this._context);
  }

  // ---------------------------------------------------------------------------
  // Change processing
  // ---------------------------------------------------------------------------

  // Iterates context.changes and calls onChange() for each entry.
  // Handles missing or non-array changes gracefully (no-op).
  processChanges() {
    let changes = this._context.changes;
    if (!changes || !Array.isArray(changes))
      return;

    for (let i = 0; i < changes.length; i++) {
      let change = changes[i];
      this.onChange(change.propName, change.previousValue, change.newValue);
    }
  }

  // ---------------------------------------------------------------------------
  // Per-property change handler — override in subclasses
  // ---------------------------------------------------------------------------

  // Called by processChanges() for each change entry.
  // Override in subclasses to react to specific property changes.
  // eslint-disable-next-line no-unused-vars
  onChange(propName, previousValue, newValue) {
    // Default: no-op
  }

  // ---------------------------------------------------------------------------
  // Permission check — delegates to PermissionService
  // ---------------------------------------------------------------------------

  // Returns: { approved: true, signature } or { approved: false, reason }
  // If no PermissionService is available on context, defaults to approved.
  async checkPermission(toolName, params) {
    let permissionService = this._context.permissionService || null;
    if (!permissionService)
      return { approved: true };

    let options = {
      organizationID: this._context.organizationID || null,
      sessionID:      (this._context.session && this._context.session.id) || null,
    };

    try {
      let result = await permissionService.check(toolName, params, options);

      if (result.decision === 'allow')
        return { approved: true, signature: result.signature };

      return { approved: false, reason: 'needs-approval' };
    } catch (error) {
      if (error.name === 'PermissionDeniedError')
        return { approved: false, reason: error.reason || 'denied' };

      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Compaction — override in agent plugins to enable rolling compaction
  // ---------------------------------------------------------------------------

  // stats: { totalChars, estimatedTokens, contextWindow, modelID, sessionID }
  // Returns: { compact: boolean, reason: string }
  // Override in agent plugins to determine when compaction should trigger.
  shouldCompact(_stats) {
    return { compact: false, reason: '' };
  }

  // Returns the prompt text sent to the compactor agent.
  // Override in agent plugins to customize.
  getCompactionPrompt(_stats) {
    return DEFAULT_COMPACTION_PROMPT;
  }

  // Returns max tokens the compaction summary should use.
  // Override in agent plugins to adjust based on context window.
  getMaxCompactionTokens(_stats) {
    return 8000;
  }

  // Makes a single non-streaming API call to the LLM.
  // options: { maxTokens, systemPrompt }
  // Must be overridden by agent plugins that support compaction.
  async _createSingleTurn(_messages, _options) {
    throw new Error('_createSingleTurn() not implemented — override in agent plugin');
  }

  // ---------------------------------------------------------------------------
  // Model Registry — override in agent plugins
  // ---------------------------------------------------------------------------

  // Returns an array of model descriptor objects for this plugin.
  // Each descriptor: { id, contextWindow, maxOutputTokens, displayName,
  //                    description, pricePerToken, useWhen }
  // Default: empty array (no models declared).
  static getModels() {
    return [];
  }

  // ---------------------------------------------------------------------------
  // Token Estimation — override in agent plugins for better accuracy
  // ---------------------------------------------------------------------------

  // Estimates the token count for a text string.
  // Default implementation: chars / 4 (rough universal approximation).
  // Override in plugins that know the specific tokenizer (e.g., Claude: 3.5).
  // options.cache (boolean) — some providers discount cached tokens.
  // eslint-disable-next-line no-unused-vars
  estimateTokens(text, _options) {
    return Math.ceil((text || '').length / 4);
  }

  // ---------------------------------------------------------------------------
  // Context Truncation — override in agent plugins for model-aware truncation
  // ---------------------------------------------------------------------------
  // ::agis.map_territory — this is called from InteractionLoop.startInteraction()
  // at the point where standalone truncateContent/truncateConversation were called.
  // options: {
  //   systemPromptText   — string, for estimating system prompt token cost
  //   behaviorsText      — string, combined behaviors for 50% cap check
  //   instructionsText   — string, combined instructions for 50% cap check
  //   onOverflow         — async fn(type) called when behaviors+instructions exceed 50% cap
  // }
  // Returns a new messages array (does not mutate input).

  async truncate(messages, options = {}) {
    if (!messages || messages.length === 0)
      return messages || [];

    let { systemPromptText = '', behaviorsText = '', instructionsText = '', onOverflow } = options;

    // 1. Determine context window from model info
    let models        = this.constructor.getModels();
    let agentModelID  = this._agent && this._agent.model;
    let modelInfo     = (agentModelID && models.find((m) => m.id === agentModelID)) || models[0];
    let contextWindow = (modelInfo && modelInfo.contextWindow) || DEFAULT_CONTEXT_WINDOW;

    // 2. Calculate character budget (subtract system prompt size)
    let charBudget = (contextWindow * 4) - (systemPromptText || '').length;

    // 3. Check behaviors + instructions against 50% cap
    let maxBehaviorsChars = Math.floor(contextWindow * 4 * 0.50);
    let behaviorsTotal    = (behaviorsText || '').length + (instructionsText || '').length;

    if (behaviorsTotal > maxBehaviorsChars) {
      if (typeof onOverflow === 'function')
        await onOverflow('behaviors');
    }

    // 4. Per-message cap (tool results, large agent/user messages)
    let result = truncateContent(messages);

    // 5. Conversation budget (drop oldest when total exceeds budget)
    result = truncateConversation(result, { maxTotalChars: charBudget });

    return result;
  }
}

export { DEFAULT_COMPACTION_PROMPT, DEFAULT_CONTEXT_WINDOW };
