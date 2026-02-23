'use strict';

// ============================================================================
// Prompt Update Function
// ============================================================================
// Updates a user_prompt element in a message with the user's answer.
// Used when a user responds to an inline prompt in the chat.

import { InteractionFunction, PERMISSION } from '../function.mjs';
import { getDatabase } from '../../../database.mjs';
import { broadcastToSession } from '../../websocket.mjs';
import { isPermissionPrompt, handlePermissionResponse } from '../../permissions/prompt.mjs';

/**
 * PromptUpdate Function class.
 * Updates a user_prompt element with the user's answer.
 */
export class PromptUpdateFunction extends InteractionFunction {
  /**
   * Register the update_prompt function with the interaction system.
   */
  static register() {
    return {
      name:        'update_prompt',
      description: 'Update a user_prompt element with an answer',
      target:      '@system',
      permission:  PERMISSION.ALWAYS,
      schema: {
        type:       'object',
        properties: {
          message_id: {
            type:        'number',
            description: 'ID of the message containing the prompt',
          },
          prompt_id: {
            type:        'string',
            description: 'ID of the user_prompt element',
          },
          answer: {
            type:        'string',
            description: 'The user\'s answer to the prompt',
          },
          question: {
            type:        'string',
            description: 'The question text (used for fallback matching when prompt has no ID)',
          },
        },
        required: ['message_id', 'prompt_id', 'answer'],
      },
      examples: [
        {
          description: 'Update a prompt with user answer',
          payload: {
            message_id: 123,
            prompt_id:  'prompt-abc123',
            answer:     'Blue, because it reminds me of the ocean.',
          },
        },
      ],
    };
  }

  constructor(context = {}) {
    super('update_prompt', context);
  }

  /**
   * Check if the prompt update is allowed.
   */
  async allowed(payload, context = {}) {
    if (!payload) {
      return { allowed: false, reason: 'Payload is required' };
    }

    if (!payload.message_id) {
      return { allowed: false, reason: 'message_id is required' };
    }

    if (!payload.prompt_id) {
      return { allowed: false, reason: 'prompt_id is required' };
    }

    if (!payload.answer) {
      return { allowed: false, reason: 'answer is required' };
    }

    return { allowed: true };
  }

  /**
   * Execute the prompt update.
   *
   * @param {Object} payload - The interaction payload
   * @param {number} payload.message_id - ID of the message containing the prompt
   * @param {string} payload.prompt_id - ID of the user_prompt element
   * @param {string} payload.answer - The user's answer
   * @returns {Promise<Object>} Result of the update
   */
  async execute(payload) {
    let { message_id, prompt_id, answer, question } = payload;

    let db = getDatabase();

    // Get the frame (message_id is now a frame ID)
    let frame = db.prepare('SELECT id, session_id, payload FROM frames WHERE id = ?').get(message_id);

    if (!frame) {
      return {
        success: false,
        error:   'Frame not found',
      };
    }

    // Parse payload JSON (stored as JSON string in database)
    let framePayload;
    try {
      framePayload = JSON.parse(frame.payload);
    } catch {
      return {
        success: false,
        error:   'Invalid frame payload',
      };
    }

    // Handle both string and Claude API array format for content
    // Claude API format: [{type: 'text', text: '...'}]
    let contentStr;
    let isArrayFormat = false;
    let textBlockIndex = -1;

    if (typeof framePayload.content === 'string') {
      contentStr = framePayload.content;
    } else if (Array.isArray(framePayload.content)) {
      isArrayFormat = true;
      textBlockIndex = framePayload.content.findIndex(
        (block) => block.type === 'text' && typeof block.text === 'string'
      );
      if (textBlockIndex >= 0) {
        contentStr = framePayload.content[textBlockIndex].text;
      }
    }

    if (!contentStr) {
      return {
        success: false,
        error:   'Could not extract content string from frame payload',
      };
    }

    // Escape XML special characters in the answer
    let escapedAnswer = escapeXml(answer);

    // Update content: find prompt by ID and add answer
    // Pattern matches: <hml-prompt id="prompt-id" ...>question</hml-prompt>
    // Also handles legacy <user-prompt> and <user_prompt> for backwards compatibility
    let pattern = new RegExp(
      `(<(?:hml-|user[-_])prompt\\s+id=["']${escapeRegex(prompt_id)}["'][^>]*)>([\\s\\S]*?)<\\/(?:hml-|user[-_])prompt>`,
      'gi'
    );

    let updated = contentStr.replace(
      pattern,
      (match, openTag, content) => {
        // Determine tag name from the match
        let tagName = 'hml-prompt';
        if (match.includes('user-prompt')) tagName = 'user-prompt';
        else if (match.includes('user_prompt')) tagName = 'user_prompt';
        // Remove any existing answered attribute before adding the new one
        let cleanedTag = openTag.replace(/\s+answered=["'][^"']*["']/gi, '');
        // Remove any existing <response> element from content
        let cleanedContent = content.replace(/<response>[\s\S]*?<\/response>/gi, '').trim();
        return `${cleanedTag} answered="true">${cleanedContent}<response>${escapedAnswer}</response></${tagName}>`;
      }
    );

    // Check if the pattern matched
    if (updated === contentStr) {
      // Try alternate pattern with different attribute order
      let altPattern = new RegExp(
        `(<(?:hml-|user[-_])prompt[^>]*\\bid=["']${escapeRegex(prompt_id)}["'][^>]*)>([\\s\\S]*?)<\\/(?:hml-|user[-_])prompt>`,
        'gi'
      );

      updated = contentStr.replace(
        altPattern,
        (match, openTag, content) => {
          let tagName = 'hml-prompt';
          if (match.includes('user-prompt')) tagName = 'user-prompt';
          else if (match.includes('user_prompt')) tagName = 'user_prompt';
          // Remove any existing answered attribute before adding the new one
          let cleanedTag = openTag.replace(/\s+answered=["'][^"']*["']/gi, '');
          // Remove any existing <response> element from content
          let cleanedContent = content.replace(/<response>[\s\S]*?<\/response>/gi, '').trim();
          return `${cleanedTag} answered="true">${cleanedContent}<response>${escapedAnswer}</response></${tagName}>`;
        }
      );
    }

    // Fallback: match by question text when prompt has no id attribute
    if (updated === contentStr && question) {
      let escapedQuestion = escapeRegex(question);
      let questionPattern = new RegExp(
        `(<(?:hml-|user[-_])prompt\\b[^>]*?)>([\\s\\S]*?${escapedQuestion}[\\s\\S]*?)<\\/(?:hml-|user[-_])prompt>`,
        'i'
      );

      let matched = false;
      updated = contentStr.replace(questionPattern, (match, openTag, content) => {
        // Skip if already answered
        if (/\banswered\s*=/.test(openTag)) return match;
        matched = true;

        let tagName = 'hml-prompt';
        if (match.includes('user-prompt')) tagName = 'user-prompt';
        else if (match.includes('user_prompt')) tagName = 'user_prompt';

        // Add the id attribute so future matches work by id
        let tagWithId = openTag;
        if (!/\bid\s*=/.test(openTag)) {
          tagWithId = openTag.replace(/<(?:hml-|user[-_])prompt/i, `$& id="${prompt_id}"`);
        }

        let cleanedContent = content.replace(/<response>[\s\S]*?<\/response>/gi, '').trim();
        return `${tagWithId} answered="true">${cleanedContent}<response>${escapedAnswer}</response></${tagName}>`;
      });

      if (!matched) updated = contentStr;
    }

    if (updated === contentStr) {
      return {
        success:  false,
        error:    'Prompt not found in message',
        promptId: prompt_id,
      };
    }

    // Update the frame payload in the database
    // Put the updated content back in the correct format (string or array)
    if (isArrayFormat && textBlockIndex >= 0) {
      framePayload.content[textBlockIndex].text = updated;
    } else {
      framePayload.content = updated;
    }
    db.prepare('UPDATE frames SET payload = ? WHERE id = ?').run(JSON.stringify(framePayload), message_id);

    // Broadcast the frame update to all session participants via WebSocket
    if (frame.session_id) {
      broadcastToSession(frame.session_id, {
        type:          'frame_update',
        sessionId:     frame.session_id,
        targetFrameId: message_id,
        payload:       framePayload,
      });
    }

    // If this is a permission prompt, resolve the pending permission request
    // and create the appropriate permission rule.
    if (isPermissionPrompt(prompt_id)) {
      handlePermissionResponse(prompt_id, answer);
    }

    return {
      success:   true,
      promptId:  prompt_id,
      messageId: message_id,
      updated:   true,
    };
  }
}

/**
 * Escape XML special characters.
 */
function escapeXml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default PromptUpdateFunction;
