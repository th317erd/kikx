'use strict';

/**
 * SessionStore - Unified interface for session message operations
 *
 * This is the ONLY way to interact with conversation messages.
 * Do NOT access state.messages directly - use this store.
 *
 * Features:
 * - Multi-session support (keyed by session ID)
 * - ID coercion (string/number handled transparently)
 * - Content format handling (string vs Claude API array)
 * - Prompt operations (answer, find unanswered)
 * - Optimistic updates (pending server confirmation)
 * - Subscriptions for reactivity
 *
 * Usage:
 *   import { sessionStore } from './stores/session-store.mjs';
 *
 *   const session = sessionStore.getSession(123);
 *   session.add({ role: 'user', content: 'Hello' });
 *   session.answerPrompt(msgId, promptId, answer);
 */

// =============================================================================
// Event Types
// =============================================================================

export const SessionStoreEvents = {
  INIT:    'init',
  CLEAR:   'clear',
  ADD:     'add',
  UPDATE:  'update',
  REMOVE:  'remove',
  REPLACE: 'replace',
};

// =============================================================================
// SessionMessages - Messages for a single session
// =============================================================================

export class SessionMessages {
  #sessionId;
  #messages = [];
  #subscribers = new Set();
  #optimisticCounter = 0;

  constructor(sessionId) {
    this.#sessionId = sessionId;
  }

  // ---------------------------------------------------------------------------
  // Read Operations
  // ---------------------------------------------------------------------------

  /**
   * Get all messages (respects hidden filter)
   * @param {Object} options
   * @param {boolean} options.includeHidden - Include hidden messages
   * @returns {Array<Message>}
   */
  getAll(options = {}) {
    const { includeHidden = false } = options;

    if (includeHidden) {
      return [...this.#messages];
    }

    return this.#messages.filter((m) => !m.hidden);
  }

  /**
   * Find message by ID (handles string/number coercion)
   * @param {string|number} id
   * @returns {Message|null}
   */
  findById(id) {
    return this.#messages.find((m) => this.#idsMatch(m.id, id)) || null;
  }

  /**
   * Find message by predicate
   * @param {Function} predicate
   * @returns {Message|null}
   */
  find(predicate) {
    return this.#messages.find(predicate) || null;
  }

  /**
   * Check if message exists
   * @param {string|number} id
   * @returns {boolean}
   */
  has(id) {
    return this.findById(id) !== null;
  }

  /**
   * Get message count
   * @returns {number}
   */
  get count() {
    return this.#messages.length;
  }

  /**
   * Get session ID
   * @returns {string|number}
   */
  get sessionId() {
    return this.#sessionId;
  }

  // ---------------------------------------------------------------------------
  // Write Operations
  // ---------------------------------------------------------------------------

  /**
   * Initialize with messages (replaces existing)
   * @param {Array<Message>} messages
   */
  init(messages) {
    this.#messages = messages.map((m) => ({ ...m }));
    this.#notify({ type: SessionStoreEvents.INIT, messages: this.#messages });
  }

  /**
   * Clear all messages
   */
  clear() {
    this.#messages = [];
    this.#notify({ type: SessionStoreEvents.CLEAR });
  }

  /**
   * Add a new message
   * @param {Message} message
   * @returns {Message} - The added message (may have generated ID)
   */
  add(message) {
    const msg = {
      ...message,
      id:        message.id ?? this.#generateId(),
      createdAt: message.createdAt ?? new Date().toISOString(),
    };

    this.#messages.push(msg);
    this.#notify({ type: SessionStoreEvents.ADD, message: msg });

    return msg;
  }

  /**
   * Update an existing message
   * @param {string|number} id
   * @param {Partial<Message>} updates
   * @returns {Message|null}
   */
  update(id, updates) {
    const index = this.#findIndex(id);
    if (index === -1) return null;

    this.#messages[index] = { ...this.#messages[index], ...updates };
    this.#notify({ type: SessionStoreEvents.UPDATE, message: this.#messages[index] });

    return this.#messages[index];
  }

  /**
   * Update message content (handles string vs array format)
   * @param {string|number} id
   * @param {Function} contentUpdater - (contentString) => newContentString
   * @returns {boolean} - Success
   */
  updateContent(id, contentUpdater) {
    const msg = this.findById(id);
    if (!msg) return false;

    const { contentStr, isArrayFormat, textBlockIndex } = this.#extractContentString(msg.content);
    if (contentStr === null) return false;

    const updatedStr = contentUpdater(contentStr);

    // Put the updated content back in the correct format
    if (isArrayFormat && textBlockIndex >= 0) {
      msg.content[textBlockIndex].text = updatedStr;
    } else {
      msg.content = updatedStr;
    }

    this.#notify({ type: SessionStoreEvents.UPDATE, message: msg });
    return true;
  }

  /**
   * Remove a message
   * @param {string|number} id
   * @returns {boolean}
   */
  remove(id) {
    const index = this.#findIndex(id);
    if (index === -1) return false;

    const removed = this.#messages.splice(index, 1)[0];
    this.#notify({ type: SessionStoreEvents.REMOVE, message: removed });

    return true;
  }

  /**
   * Replace a message (e.g., optimistic → real)
   * @param {string|number} oldId
   * @param {Message} newMessage
   * @returns {boolean}
   */
  replace(oldId, newMessage) {
    const index = this.#findIndex(oldId);
    if (index === -1) return false;

    this.#messages[index] = { ...newMessage };
    this.#notify({ type: SessionStoreEvents.REPLACE, message: this.#messages[index] });

    return true;
  }

  // ---------------------------------------------------------------------------
  // Prompt Operations
  // ---------------------------------------------------------------------------

  /**
   * Mark a prompt as answered within a message
   * @param {string|number} messageId
   * @param {string} promptId
   * @param {string} answer
   * @returns {boolean}
   */
  answerPrompt(messageId, promptId, answer) {
    const msg = this.findById(messageId);
    if (!msg) return false;

    const { contentStr, isArrayFormat, textBlockIndex } = this.#extractContentString(msg.content);
    if (contentStr === null) return false;

    // Escape XML special characters in the answer
    const escapedAnswer = this.#escapeXml(answer);

    // Pattern matches: <hml-prompt id="prompt-id" ...>content</hml-prompt>
    const pattern = new RegExp(
      `(<hml-prompt[^>]*\\bid=["']${this.#escapeRegex(promptId)}["'][^>]*)>([\\s\\S]*?)</hml-prompt>`,
      'gi'
    );

    const updatedStr = contentStr.replace(
      pattern,
      (match, openTag, content) => {
        // Remove any existing answered attribute
        const cleanedTag = openTag.replace(/\s+answered=["'][^"']*["']/gi, '');
        // Remove any existing <response> element
        const cleanedContent = content.replace(/<response>[\s\S]*?<\/response>/gi, '').trim();
        return `${cleanedTag} answered="true">${cleanedContent}<response>${escapedAnswer}</response></hml-prompt>`;
      }
    );

    // Check if pattern matched
    if (updatedStr === contentStr) {
      return false;
    }

    // Put the updated content back
    if (isArrayFormat && textBlockIndex >= 0) {
      msg.content[textBlockIndex].text = updatedStr;
    } else {
      msg.content = updatedStr;
    }

    this.#notify({ type: SessionStoreEvents.UPDATE, message: msg });
    return true;
  }

  /**
   * Find unanswered prompts across all messages
   * @returns {Array<{messageId, promptId, question}>}
   */
  findUnansweredPrompts() {
    const unanswered = [];

    for (const msg of this.#messages) {
      if (msg.role !== 'assistant') continue;

      const { contentStr } = this.#extractContentString(msg.content);
      if (!contentStr) continue;

      // Find all hml-prompt elements
      const promptPattern = /<hml-prompt\s+id=["']([^"']+)["'][^>]*(?:\s+answered(?:=["']true["'])?)?[^>]*>([^<]*)/gi;
      let match;

      while ((match = promptPattern.exec(contentStr)) !== null) {
        const fullMatch = match[0];
        const promptId = match[1];
        const question = match[2].trim();

        // Check if this prompt is answered
        const isAnswered = /answered(?:=["']true["'])?/.test(fullMatch);

        if (!isAnswered) {
          unanswered.push({
            messageId: msg.id,
            promptId:  promptId,
            question:  question,
          });
        }
      }
    }

    return unanswered;
  }

  // ---------------------------------------------------------------------------
  // Optimistic Updates
  // ---------------------------------------------------------------------------

  /**
   * Add an optimistic message (not yet confirmed by server)
   * @param {Message} message
   * @returns {string} - Temporary ID
   */
  addOptimistic(message) {
    const tempId = `optimistic-${Date.now()}-${++this.#optimisticCounter}`;

    const msg = {
      ...message,
      id:         tempId,
      createdAt:  message.createdAt ?? new Date().toISOString(),
      optimistic: true,
    };

    this.#messages.push(msg);
    this.#notify({ type: SessionStoreEvents.ADD, message: msg });

    return tempId;
  }

  /**
   * Confirm an optimistic message with real ID
   * @param {string} tempId
   * @param {Message} realMessage
   */
  confirmOptimistic(tempId, realMessage) {
    const index = this.#findIndex(tempId);
    if (index === -1) return;

    // Replace optimistic with real message
    this.#messages[index] = { ...realMessage };
    this.#notify({ type: SessionStoreEvents.REPLACE, message: this.#messages[index] });
  }

  /**
   * Remove a failed optimistic message
   * @param {string} tempId
   */
  rejectOptimistic(tempId) {
    this.remove(tempId);
  }

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to store changes
   * @param {Function} callback - (event) => void
   * @returns {Function} - Unsubscribe function
   */
  subscribe(callback) {
    this.#subscribers.add(callback);
    return () => this.#subscribers.delete(callback);
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  #notify(event) {
    for (const callback of this.#subscribers) {
      try {
        callback(event);
      } catch (e) {
        console.error('[SessionMessages] Subscriber error:', e);
      }
    }
  }

  #findIndex(id) {
    return this.#messages.findIndex((m) => this.#idsMatch(m.id, id));
  }

  #idsMatch(id1, id2) {
    // Handle string/number coercion
    if (id1 === id2) return true;
    if (String(id1) === String(id2)) return true;
    return false;
  }

  #generateId() {
    return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  #extractContentString(content) {
    if (typeof content === 'string') {
      return { contentStr: content, isArrayFormat: false, textBlockIndex: -1 };
    }

    if (Array.isArray(content)) {
      const textBlockIndex = content.findIndex(
        (block) => block.type === 'text' && typeof block.text === 'string'
      );

      if (textBlockIndex >= 0) {
        return {
          contentStr:     content[textBlockIndex].text,
          isArrayFormat:  true,
          textBlockIndex: textBlockIndex,
        };
      }
    }

    return { contentStr: null, isArrayFormat: false, textBlockIndex: -1 };
  }

  #escapeXml(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  #escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

// =============================================================================
// SessionStore - Multi-session container
// =============================================================================

export class SessionStore {
  #sessions = new Map();

  /**
   * Get or create a session by ID
   * @param {string|number} sessionId
   * @returns {SessionMessages}
   */
  getSession(sessionId) {
    // Normalize to string for consistent Map keys
    const key = String(sessionId);

    if (!this.#sessions.has(key)) {
      this.#sessions.set(key, new SessionMessages(sessionId));
    }

    return this.#sessions.get(key);
  }

  /**
   * Check if session exists
   * @param {string|number} sessionId
   * @returns {boolean}
   */
  hasSession(sessionId) {
    return this.#sessions.has(String(sessionId));
  }

  /**
   * Remove a session
   * @param {string|number} sessionId
   * @returns {boolean}
   */
  removeSession(sessionId) {
    return this.#sessions.delete(String(sessionId));
  }

  /**
   * Clear all sessions
   */
  clearAll() {
    this.#sessions.clear();
  }

  /**
   * Get all active session IDs
   * @returns {string[]}
   */
  getSessionIds() {
    return Array.from(this.#sessions.keys());
  }
}

// =============================================================================
// Singleton Export
// =============================================================================

/**
 * Create a new SessionStore instance
 * @returns {SessionStore}
 */
export function createSessionStore() {
  return new SessionStore();
}

// Default singleton for app-wide use
export const sessionStore = createSessionStore();

// Export for browser global access
if (typeof window !== 'undefined') {
  window.sessionStore = sessionStore;
}

export default sessionStore;
