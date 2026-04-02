'use strict';

import XID from 'xid-js';
import { createTypedFrame } from '../../shared/frame-types/index.mjs';

/**
 * @param {string} prefix
 * @returns {string}
 */
function generateID(prefix) {
  return `${prefix}${XID.next()}`;
}

// =============================================================================
// Default Compaction Prompt
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

class CompactionRunner {
  /**
   * @param {object} [options]
   * @param {Console} [options.logger]
   */
  constructor(options = {}) {
    /** @type {Console} */
    this._logger = options.logger || console;
  }

  /**
   * Returns true if no compaction is currently in progress for this session.
   * @param {string} sessionID
   * @param {object} frameManager
   * @returns {Promise<boolean>}
   */
  async canStartCompaction(sessionID, frameManager) {
    let frames = frameManager.toArray();

    for (let i = 0; i < frames.length; i++) {
      let frame = frames[i];

      if (frame.type === 'Compaction' && frame.content && frame.content.status === 'started')
        return false;
    }

    return true;
  }

  /**
   * Main compaction entry point.
   * @param {string} sessionID
   * @param {object} params
   * @param {import('../types').Agent} params.agent
   * @param {import('../types').BasePluginClass} params.plugin
   * @param {object} params.frameManager
   * @returns {Promise<string|null>} Frame ID of the compaction frame, or null on failure
   */
  async runCompaction(sessionID, params) {
    let { agent, plugin, frameManager } = params;

    let canStart = await this.canStartCompaction(sessionID, frameManager);
    if (!canStart) {
      this._logger.warn('[CompactionRunner] Compaction already in progress for session:', sessionID);
      return null;
    }

    let allFrames       = frameManager.toArray();
    let compactable     = allFrames.filter((f) => f.type !== 'Compaction' && !f.deleted);
    let framesCompacted = compactable.length;

    if (framesCompacted === 0) {
      this._logger.info('[CompactionRunner] No frames to compact for session:', sessionID);
      return null;
    }

    let firstFrameID = compactable[0].id;
    let lastFrameID  = compactable[compactable.length - 1].id;

    let frameID   = generateID('frm_');
    let startedAt = new Date().toISOString();

    /** @type {import('../types').FrameData} */
    let compactionFrame = {
      id:         frameID,
      type:       'Compaction',
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

    let conversationContent = this._buildConversationContent(compactable);

    let prompt    = (typeof plugin.getCompactionPrompt === 'function')
      ? plugin.getCompactionPrompt({})
      : DEFAULT_COMPACTION_PROMPT;

    let maxTokens = (typeof plugin.getMaxCompactionTokens === 'function')
      ? plugin.getMaxCompactionTokens({})
      : 8000;

    /** @type {import('../types').ChatMessage[]} */
    let messages = [{ role: 'user', content: prompt + '\n\n' + conversationContent }];

    /** @type {string|null} */
    let responseText;

    try {
      responseText = await plugin._createSingleTurn(messages, {
        maxTokens,
        apiKey: agent.apiKey,
        model:  agent.model,
      });
    } catch (error) {
      this._logger.error('[CompactionRunner] LLM call failed:', error.message);

      this._updateCompactionFrame(frameManager, frameID, {
        status:     'abandoned',
        finishedAt: new Date().toISOString(),
      });

      return null;
    }

    if (!responseText || (typeof responseText === 'string' && responseText.trim() === '')) {
      this._logger.warn('[CompactionRunner] LLM returned empty summary for session:', sessionID);

      this._updateCompactionFrame(frameManager, frameID, {
        status:     'abandoned',
        finishedAt: new Date().toISOString(),
      });

      return null;
    }

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

  /**
   * Marks any compaction frames stuck in 'started' status as 'abandoned'.
   * @param {object} frameManager
   * @returns {Promise<number>} Count of cleaned compactions
   */
  async cleanupStaleCompactions(frameManager) {
    let frames  = frameManager.toArray();
    let cleaned = 0;

    for (let i = 0; i < frames.length; i++) {
      let frame = frames[i];

      if (frame.type === 'Compaction' && frame.content && frame.content.status === 'started') {
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

  /**
   * Builds a readable text representation of frames for the LLM to compress.
   * @param {import('../types').FrameData[]} frames
   * @returns {string}
   */
  _buildConversationContent(frames) {
    let parts = [];

    for (let i = 0; i < frames.length; i++) {
      let frame = frames[i];

      if (frame.type === 'Compaction')
        continue;

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

  /**
   * Pull readable text from frame content.
   * @param {import('../types').FrameData} frame
   * @returns {string}
   */
  _extractText(frame) {
    let typed = createTypedFrame(frame, null);
    return typed.toMessage();
  }

  /**
   * Update a compaction frame's content via merge.
   * @param {object} frameManager
   * @param {string} frameID
   * @param {Record<string, any>} contentUpdates
   * @returns {void}
   */
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
