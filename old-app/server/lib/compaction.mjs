'use strict';

// ============================================================================
// Conversation Compaction System (Frame-Based)
// ============================================================================
// Automatically compacts conversation history into compact frames to manage
// context size. Uses debouncing to avoid compacting during active conversation.
//
// Thresholds:
// - MIN_THRESHOLD: Start attempting to compact (debounced)
// - MAX_THRESHOLD: Force immediate compaction
//
// Compact frames are stored as checkpoints. When loading history, we get the
// most recent compact frame + any frames after it.

import {
  countMessagesSinceCompact,
  buildConversationForCompaction,
} from './frames/context.mjs';
import {
  getFrames,
  compileFrames,
  FrameType,
} from './frames/index.mjs';
import { createCompactFrame } from './frames/broadcast.mjs';
import { broadcastToSession } from './websocket.mjs';

// Default settings (can be overridden per-agent)
const DEFAULT_MIN_THRESHOLD = 15;  // Start debounced compaction
const DEFAULT_MAX_THRESHOLD = 25;  // Force immediate compaction
const DEFAULT_DEBOUNCE_MS   = 5000; // 5 seconds debounce

// Active debounce timers per session
const debounceTimers = new Map();

// Debug logging
function debug(...args) {
  if (process.env.DEBUG)
    console.log('[Compaction]', ...args);
}

/**
 * Get compaction settings for an agent.
 */
function getCompactionSettings(agent) {
  return {
    minThreshold: agent?.config?.compactionMinThreshold || DEFAULT_MIN_THRESHOLD,
    maxThreshold: agent?.config?.compactionMaxThreshold || DEFAULT_MAX_THRESHOLD,
    debounceMs:   agent?.config?.compactionDebounceMs || DEFAULT_DEBOUNCE_MS,
    enabled:      agent?.config?.compactionEnabled !== false, // Default enabled
  };
}

/**
 * Build the compaction prompt for the agent.
 */
function buildCompactionPrompt(conversation) {
  return `You are creating a memory snapshot to preserve the context of this conversation. This snapshot will be used as the starting context for future messages, so it MUST capture everything needed to continue working.

Create a comprehensive snapshot with TWO sections:

## CONTEXT SUMMARY
Capture ALL important details:
- User's name, preferences, and communication style
- Project/codebase details (file paths, structure, technologies)
- Key decisions made and their reasoning
- Problems identified and solutions discussed
- Configuration details, API keys mentioned, environment info
- Any specific instructions or constraints the user provided
- Code snippets or patterns that were important
- Errors encountered and how they were resolved

## TODO LIST
List ALL pending tasks and next steps:
- Tasks explicitly requested by the user that aren't complete
- Follow-up items that were discussed but not yet addressed
- Things the user mentioned wanting to do later
- Any unfinished work from this session

If there are no pending tasks, write "No pending tasks."

CONVERSATION TO SUMMARIZE:
${conversation}

MEMORY SNAPSHOT:`;
}

/**
 * Build a snapshot of visible message payloads for the compact frame.
 * This preserves the compiled state so compileFrames can restore it.
 *
 * @param {number} sessionId
 * @returns {Object} Map of frame ID to compiled payload
 */
function buildSnapshot(sessionId) {
  const frames = getFrames(sessionId, { fromCompact: true });
  const compiled = compileFrames(frames);
  const snapshot = {};

  for (const frame of frames) {
    if (frame.type !== FrameType.MESSAGE) continue;

    const payload = compiled.get(frame.id);
    if (!payload) continue;
    if (payload.hidden) continue;

    snapshot[frame.id] = payload;
  }

  return snapshot;
}

/**
 * Perform the actual compaction.
 */
async function performCompaction(sessionId, userId, agent) {
  debug('Performing compaction', { sessionId });

  try {
    // Get conversation text for compaction
    let conversation = buildConversationForCompaction(sessionId);

    if (!conversation || conversation.length < 100) {
      debug('Not enough content to compact', { length: conversation?.length });
      return { success: false, reason: 'Not enough content' };
    }

    // Count messages for logging
    let messageCount = countMessagesSinceCompact(sessionId);

    // Build compaction prompt
    let prompt = buildCompactionPrompt(conversation);

    // Ask agent to summarize
    debug('Requesting summary from agent');
    let response = await agent.sendMessage([
      { role: 'user', content: prompt },
    ], { maxTokens: 1000 });

    // Extract summary content
    let summary;
    if (typeof response.content === 'string') {
      summary = response.content;
    } else if (Array.isArray(response.content)) {
      summary = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
    }

    if (!summary) {
      debug('No summary returned from agent');
      return { success: false, reason: 'No summary returned' };
    }

    // Build snapshot of visible message payloads for state restoration
    let snapshot = buildSnapshot(sessionId);

    // Store compact frame
    let compactFrame = createCompactFrame({
      sessionId: sessionId,
      userId:    userId,
      context:   summary,
      snapshot:  snapshot,
    });

    // Broadcast to user that compaction happened
    broadcastToSession(sessionId, {
      type:         'compaction_complete',
      sessionId:    sessionId,
      messageCount: messageCount,
      frameId:      compactFrame.id,
    });

    debug('Compaction complete', { sessionId, frameId: compactFrame.id, originalMessages: messageCount });

    return {
      success:        true,
      frameId:        compactFrame.id,
      compactedCount: messageCount,
      summaryLength:  summary.length,
    };

  } catch (error) {
    console.error('[Compaction] Error:', error);
    return { success: false, reason: error.message };
  }
}

/**
 * Check if compaction is needed and trigger if so.
 * This is the main entry point called after each message.
 */
export async function checkCompaction(sessionId, userId, agent, options = {}) {
  let settings = getCompactionSettings(agent);

  if (!settings.enabled) {
    return { triggered: false, reason: 'Compaction disabled' };
  }

  let messageCount = countMessagesSinceCompact(sessionId);
  debug('Checking compaction', { sessionId, messageCount, min: settings.minThreshold, max: settings.maxThreshold });

  // Below minimum - no action needed
  if (messageCount < settings.minThreshold) {
    // Clear any pending debounce
    if (debounceTimers.has(sessionId)) {
      clearTimeout(debounceTimers.get(sessionId));
      debounceTimers.delete(sessionId);
    }
    return { triggered: false, reason: 'Below threshold' };
  }

  // At or above maximum - force immediate compaction
  if (messageCount >= settings.maxThreshold || options.force) {
    debug('Max threshold reached or forced, compacting immediately');
    // Clear debounce timer
    if (debounceTimers.has(sessionId)) {
      clearTimeout(debounceTimers.get(sessionId));
      debounceTimers.delete(sessionId);
    }
    return await performCompaction(sessionId, userId, agent);
  }

  // Between min and max - debounce
  debug('Between thresholds, debouncing');

  // Clear existing timer
  if (debounceTimers.has(sessionId)) {
    clearTimeout(debounceTimers.get(sessionId));
  }

  // Set new debounce timer
  return new Promise((resolve) => {
    let timer = setTimeout(async () => {
      debounceTimers.delete(sessionId);
      debug('Debounce timer fired, compacting');
      let result = await performCompaction(sessionId, userId, agent);
      resolve(result);
    }, settings.debounceMs);

    debounceTimers.set(sessionId, timer);

    // Return immediately - compaction will happen later
    resolve({ triggered: true, debounced: true, reason: 'Debounce started' });
  });
}

/**
 * Force compaction for a session (used by /compact command).
 */
export async function forceCompaction(sessionId, userId, agent) {
  debug('Force compaction requested', { sessionId });

  // Clear any pending debounce
  if (debounceTimers.has(sessionId)) {
    clearTimeout(debounceTimers.get(sessionId));
    debounceTimers.delete(sessionId);
  }

  return await performCompaction(sessionId, userId, agent);
}

export { getCompactionSettings };

export default {
  checkCompaction,
  forceCompaction,
  getCompactionSettings,
};
