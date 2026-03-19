'use strict';

import XID from 'xid-js';

function generateID(prefix) {
  return `${prefix}${XID.next()}`;
}

// =============================================================================
// Default Compaction Prompt
// =============================================================================
// Used when the plugin does not provide a custom prompt via getCompactionPrompt().
// Directs the LLM to compress conversation history with a gradient approach:
// older content is more aggressively compressed, recent content retains detail.
// =============================================================================

const DEFAULT_COMPACTION_PROMPT = `Your job is to compact/compress the following memories/conversation. It is \
VITALLY IMPORTANT that you identify things of importance, and that these \
survive compaction/compression, things such as file paths, secrets, keys, \
how to execute commands, tool run ids, other important ids, and any other \
context-related important items that are vital, and ensure they SURVIVE your \
compression. Beyond that, I would like you to take an approach where the \
older the content the more aggressively you compress. Think of this as a \
gradient of resolution: recent memories/conversations have high resolution, \
and won't be compressed quite as much, whereas older things will be more \
aggressively compressed. Useless or unimportant things should undergo more \
compression, or be stripped altogether, regardless of where they are in the \
history. It is VITAL that the essence of the memory remains intact, such that \
agents can continue with their current tasks uninterrupted and without being \
confused. The context you need to compact/compress is as follows:`;

// =============================================================================
// CompactionRunner
// =============================================================================
// Core logic for rolling compaction of session history. Creates a compaction
// frame as a lock, asks the LLM to compress conversation, and stores the
// summary back into the compaction frame.
//
// CompactionRunner does NOT own persistence — callers (e.g., InteractionLoop)
// are responsible for persisting frame changes to the database. This module
// operates purely on in-memory FrameManager state and emits frames through it.
// =============================================================================

class CompactionRunner {
  constructor(options = {}) {
    this._logger = options.logger || console;
  }

  // ---------------------------------------------------------------------------
  // canStartCompaction
  // ---------------------------------------------------------------------------
  // Returns true if no compaction is currently in progress for this session.
  // Checks all frames in the FrameManager for type='compaction' with
  // content.status='started'.
  // ---------------------------------------------------------------------------

  async canStartCompaction(sessionID, frameManager) {
    let frames = frameManager.toArray();

    for (let i = 0; i < frames.length; i++) {
      let frame = frames[i];

      if (frame.type === 'compaction' && frame.content && frame.content.status === 'started')
        return false;
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // runCompaction
  // ---------------------------------------------------------------------------
  // Main compaction entry point. Creates a compaction frame as a lock, builds
  // conversation content from existing frames, calls the LLM for compression,
  // and updates the compaction frame with the result.
  //
  // params:
  //   agent         — the agent record (needs .id)
  //   plugin        — the agent plugin instance (needs _createSingleTurn,
  //                   getCompactionPrompt, getMaxCompactionTokens)
  //   frameManager  — the session's FrameManager instance
  // ---------------------------------------------------------------------------

  async runCompaction(sessionID, params) {
    let { agent, plugin, frameManager } = params;

    // 1. Race guard — double-check no active compaction
    let canStart = await this.canStartCompaction(sessionID, frameManager);
    if (!canStart) {
      this._logger.warn('[CompactionRunner] Compaction already in progress for session:', sessionID);
      return null;
    }

    // 2. Gather all frames for this session (excluding compaction frames)
    let allFrames       = frameManager.toArray();
    let compactable     = allFrames.filter((f) => f.type !== 'compaction' && !f.deleted);
    let framesCompacted = compactable.length;

    // Edge case: nothing to compact
    if (framesCompacted === 0) {
      this._logger.info('[CompactionRunner] No frames to compact for session:', sessionID);
      return null;
    }

    let firstFrameID = compactable[0].id;
    let lastFrameID  = compactable[compactable.length - 1].id;

    // 3. Create compaction frame (THE LOCK)
    let frameID   = generateID('frm_');
    let startedAt = new Date().toISOString();

    let compactionFrame = {
      id:         frameID,
      type:       'compaction',
      authorType: 'system',
      authorID:   null,
      parentID:   null,
      hidden:     false,
      deleted:    false,
      processed:  false,
      timestamp:  Date.now(),
      content:    {
        status:           'started',
        compactionID:     frameID,
        startedAt,
        finishedAt:       null,
        compactorAgentID: agent.id,
        summary:          null,
        framesCompacted,
        firstFrameID,
        lastFrameID,
      },
    };

    frameManager.merge([compactionFrame], { authorType: 'system' });

    // 4. Build conversation content from frames
    let conversationContent = this._buildConversationContent(compactable);

    // 5. Get prompt and max tokens from plugin (with fallbacks)
    let prompt    = (typeof plugin.getCompactionPrompt === 'function')
      ? plugin.getCompactionPrompt({})
      : DEFAULT_COMPACTION_PROMPT;

    let maxTokens = (typeof plugin.getMaxCompactionTokens === 'function')
      ? plugin.getMaxCompactionTokens({})
      : 8000;

    // 6. Build messages array for the LLM
    let messages = [{ role: 'user', content: prompt + '\n\n' + conversationContent }];

    // 7. Call plugin._createSingleTurn
    let responseText;

    try {
      responseText = await plugin._createSingleTurn(messages, {
        maxTokens,
        apiKey: agent.apiKey,
        model:  agent.model,
      });
    } catch (error) {
      this._logger.error('[CompactionRunner] LLM call failed:', error.message);

      // Mark compaction as abandoned
      this._updateCompactionFrame(frameManager, frameID, {
        status:     'abandoned',
        finishedAt: new Date().toISOString(),
      });

      return null;
    }

    // 8. Empty summary check — treat as failure
    if (!responseText || (typeof responseText === 'string' && responseText.trim() === '')) {
      this._logger.warn('[CompactionRunner] LLM returned empty summary for session:', sessionID);

      this._updateCompactionFrame(frameManager, frameID, {
        status:     'abandoned',
        finishedAt: new Date().toISOString(),
      });

      return null;
    }

    // 9. Success — update compaction frame with summary
    let finishedAt = new Date().toISOString();

    this._updateCompactionFrame(frameManager, frameID, {
      status:     'finished',
      summary:    responseText,
      finishedAt,
    });

    this._logger.info('[CompactionRunner] Compaction finished for session:', sessionID,
      `(${framesCompacted} frames compacted)`);

    return frameID;
  }

  // ---------------------------------------------------------------------------
  // cleanupStaleCompactions
  // ---------------------------------------------------------------------------
  // Marks any compaction frames stuck in 'started' status as 'abandoned'.
  // Called on server startup to recover from crashes during active compaction.
  // ---------------------------------------------------------------------------

  async cleanupStaleCompactions(frameManager) {
    let frames  = frameManager.toArray();
    let cleaned = 0;

    for (let i = 0; i < frames.length; i++) {
      let frame = frames[i];

      if (frame.type === 'compaction' && frame.content && frame.content.status === 'started') {
        this._updateCompactionFrame(frameManager, frame.id, {
          status:     'abandoned',
          finishedAt: new Date().toISOString(),
        });

        cleaned++;
      }
    }

    if (cleaned > 0)
      this._logger.info(`[CompactionRunner] Cleaned up ${cleaned} stale compaction(s)`);

    return cleaned;
  }

  // ---------------------------------------------------------------------------
  // _buildConversationContent
  // ---------------------------------------------------------------------------
  // Builds a readable text representation of frames for the LLM to compress.
  // Excludes compaction frames themselves. Extracts plain text from frame
  // content (text, html, or stringified content).
  // ---------------------------------------------------------------------------

  _buildConversationContent(frames) {
    let parts = [];

    for (let i = 0; i < frames.length; i++) {
      let frame = frames[i];

      // Skip compaction frames
      if (frame.type === 'compaction')
        continue;

      // Skip deleted frames
      if (frame.deleted)
        continue;

      let text = this._extractText(frame);
      if (!text)
        continue;

      let authorType = frame.authorType || 'unknown';
      parts.push(`${authorType}: ${text}`);
    }

    return parts.join('\n---\n');
  }

  // ---------------------------------------------------------------------------
  // _extractText — pull readable text from frame content
  // ---------------------------------------------------------------------------

  _extractText(frame) {
    let content = frame.content;

    if (!content)
      return '';

    // Direct text field
    if (typeof content.text === 'string')
      return content.text;

    // HTML field (strip tags for compaction input)
    if (typeof content.html === 'string')
      return content.html;

    // Tool call: format as readable text
    if (content.toolName)
      return `[tool-call: ${content.toolName}]`;

    // Tool result: extract output
    if (content.output !== undefined) {
      if (typeof content.output === 'string')
        return content.output;

      return JSON.stringify(content.output);
    }

    // Generic: stringify if non-empty
    let keys = Object.keys(content);
    if (keys.length > 0)
      return JSON.stringify(content);

    return '';
  }

  // ---------------------------------------------------------------------------
  // _updateCompactionFrame — update a compaction frame's content via merge
  // ---------------------------------------------------------------------------
  // Uses FrameManager's target-based merge to deep-merge new content fields
  // into the existing compaction frame.
  // ---------------------------------------------------------------------------

  _updateCompactionFrame(frameManager, frameID, contentUpdates) {
    let updateFrame = {
      id:      generateID('frm_'),
      type:    'compaction-update',
      targets: [frameID],
      content: contentUpdates,
    };

    frameManager.merge([updateFrame], { authorType: 'system' });
  }
}

export default CompactionRunner;
export { DEFAULT_COMPACTION_PROMPT };
