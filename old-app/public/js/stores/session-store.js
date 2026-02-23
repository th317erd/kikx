'use strict';

/**
 * SessionStore - Unified interface for session message operations
 *
 * Browser-compatible version (no ES module syntax).
 * Exposes window.sessionStore for use by other scripts.
 *
 * This is the ONLY way to interact with conversation messages.
 * Do NOT access state.messages directly - use this store.
 */

// =============================================================================
// Event Types
// =============================================================================

const SessionStoreEvents = {
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

class SessionMessages {
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

  getAll(options = {}) {
    const { includeHidden = false } = options;
    if (includeHidden) {
      return [...this.#messages];
    }
    return this.#messages.filter((m) => !m.hidden);
  }

  findById(id) {
    return this.#messages.find((m) => this.#idsMatch(m.id, id)) || null;
  }

  find(predicate) {
    return this.#messages.find(predicate) || null;
  }

  has(id) {
    return this.findById(id) !== null;
  }

  get count() {
    return this.#messages.length;
  }

  get sessionId() {
    return this.#sessionId;
  }

  // ---------------------------------------------------------------------------
  // Write Operations
  // ---------------------------------------------------------------------------

  init(messages) {
    this.#messages = messages.map((m) => ({ ...m }));
    this.#notify({ type: SessionStoreEvents.INIT, messages: this.#messages });
  }

  clear() {
    this.#messages = [];
    this.#notify({ type: SessionStoreEvents.CLEAR });
  }

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

  update(id, updates) {
    const index = this.#findIndex(id);
    if (index === -1) return null;
    this.#messages[index] = { ...this.#messages[index], ...updates };
    this.#notify({ type: SessionStoreEvents.UPDATE, message: this.#messages[index] });
    return this.#messages[index];
  }

  updateContent(id, contentUpdater) {
    const msg = this.findById(id);
    if (!msg) return false;

    const { contentStr, isArrayFormat, textBlockIndex } = this.#extractContentString(msg.content);
    if (contentStr === null) return false;

    const updatedStr = contentUpdater(contentStr);

    if (isArrayFormat && textBlockIndex >= 0) {
      msg.content[textBlockIndex].text = updatedStr;
    } else {
      msg.content = updatedStr;
    }

    this.#notify({ type: SessionStoreEvents.UPDATE, message: msg });
    return true;
  }

  remove(id) {
    const index = this.#findIndex(id);
    if (index === -1) return false;
    const removed = this.#messages.splice(index, 1)[0];
    this.#notify({ type: SessionStoreEvents.REMOVE, message: removed });
    return true;
  }

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

  answerPrompt(messageId, promptId, answer) {
    const msg = this.findById(messageId);
    if (!msg) return false;

    const { contentStr, isArrayFormat, textBlockIndex } = this.#extractContentString(msg.content);
    if (contentStr === null) return false;

    const escapedAnswer = this.#escapeXml(answer);
    const pattern = new RegExp(
      `(<hml-prompt[^>]*\\bid=["']${this.#escapeRegex(promptId)}["'][^>]*)>([\\s\\S]*?)</hml-prompt>`,
      'gi'
    );

    const updatedStr = contentStr.replace(
      pattern,
      (match, openTag, content) => {
        const cleanedTag = openTag.replace(/\s+answered=["'][^"']*["']/gi, '');
        const cleanedContent = content.replace(/<response>[\s\S]*?<\/response>/gi, '').trim();
        return `${cleanedTag} answered="true">${cleanedContent}<response>${escapedAnswer}</response></hml-prompt>`;
      }
    );

    if (updatedStr === contentStr) return false;

    if (isArrayFormat && textBlockIndex >= 0) {
      msg.content[textBlockIndex].text = updatedStr;
    } else {
      msg.content = updatedStr;
    }

    this.#notify({ type: SessionStoreEvents.UPDATE, message: msg });
    return true;
  }

  findUnansweredPrompts() {
    const unanswered = [];
    for (const msg of this.#messages) {
      if (msg.role !== 'assistant') continue;
      const { contentStr } = this.#extractContentString(msg.content);
      if (!contentStr) continue;

      const promptPattern = /<hml-prompt\s+id=["']([^"']+)["'][^>]*(?:\s+answered(?:=["']true["'])?)?[^>]*>([^<]*)/gi;
      let match;
      while ((match = promptPattern.exec(contentStr)) !== null) {
        const fullMatch = match[0];
        const promptId = match[1];
        const question = match[2].trim();
        const isAnswered = /answered(?:=["']true["'])?/.test(fullMatch);
        if (!isAnswered) {
          unanswered.push({ messageId: msg.id, promptId, question });
        }
      }
    }
    return unanswered;
  }

  // ---------------------------------------------------------------------------
  // Optimistic Updates
  // ---------------------------------------------------------------------------

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

  confirmOptimistic(tempId, realMessage) {
    const index = this.#findIndex(tempId);
    if (index === -1) return;
    this.#messages[index] = { ...realMessage };
    this.#notify({ type: SessionStoreEvents.REPLACE, message: this.#messages[index] });
  }

  rejectOptimistic(tempId) {
    this.remove(tempId);
  }

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------

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
        return { contentStr: content[textBlockIndex].text, isArrayFormat: true, textBlockIndex };
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

class SessionStore {
  #sessions = new Map();

  getSession(sessionId) {
    const key = String(sessionId);
    if (!this.#sessions.has(key)) {
      this.#sessions.set(key, new SessionMessages(sessionId));
    }
    return this.#sessions.get(key);
  }

  hasSession(sessionId) {
    return this.#sessions.has(String(sessionId));
  }

  removeSession(sessionId) {
    return this.#sessions.delete(String(sessionId));
  }

  clearAll() {
    this.#sessions.clear();
  }

  getSessionIds() {
    return Array.from(this.#sessions.keys());
  }
}

// =============================================================================
// Global Export
// =============================================================================

const sessionStore = new SessionStore();

// Expose globally for all scripts
window.SessionStore = SessionStore;
window.SessionMessages = SessionMessages;
window.SessionStoreEvents = SessionStoreEvents;
window.sessionStore = sessionStore;
