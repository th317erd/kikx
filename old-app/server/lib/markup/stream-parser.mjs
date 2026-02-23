'use strict';

// ============================================================================
// Hero Markup Language (HML) - Streaming Parser
// ============================================================================
// Processes HML elements progressively as text streams in, emitting events
// for element lifecycle: start, update, complete.

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

// Elements that trigger server-side execution
export const EXECUTABLE_ELEMENTS = ['websearch', 'bash', 'ask'];

// All recognized HML elements (executable + display)
export const ALL_ELEMENTS = [
  'websearch', 'bash', 'ask',            // Executable
  'thinking', 'todo', 'progress',        // Display
  'link', 'copy', 'result',              // Display
  'item',                                 // Nested (inside todo)
  'hml-prompt', 'response',              // User prompt Web Component with nested response
];

/**
 * Streaming HML Parser
 *
 * Emits events as elements are detected in streaming text:
 * - 'text' - Plain text chunk (not inside an element)
 * - 'element_start' - Opening tag detected
 * - 'element_update' - Content accumulating inside element
 * - 'element_complete' - Closing tag found, element ready
 * - 'done' - Stream finished
 *
 * @extends EventEmitter
 */
export class StreamingHMLParser extends EventEmitter {
  constructor(options = {}) {
    super();

    this.buffer = '';
    this.elementStack = [];      // Stack of open elements
    this.pendingElements = [];   // Completed elements awaiting execution
    this.textBuffer = '';        // Accumulated plain text
    this.options = options;

    // Pattern to detect element tags
    this.tagPattern = new RegExp(
      `<(/?)(${ALL_ELEMENTS.join('|')})([^>]*)>`,
      'gi'
    );
  }

  /**
   * Process a chunk of streaming text.
   *
   * @param {string} chunk - Text chunk from stream
   */
  write(chunk) {
    this.buffer += chunk;
    this.processBuffer();
  }

  /**
   * Signal end of stream.
   */
  end() {
    // Note: text is already emitted in chunks during streaming,
    // so we don't re-emit the accumulated textBuffer here.
    // Just clear it.
    this.textBuffer = '';

    // Check for unclosed elements
    for (let element of this.elementStack) {
      this.emit('element_error', {
        id: element.id,
        type: element.type,
        error: 'Unclosed element at end of stream',
      });
    }

    this.emit('done', { pendingElements: this.pendingElements });
  }

  /**
   * Process accumulated buffer looking for elements.
   */
  processBuffer() {
    let lastIndex = 0;
    this.tagPattern.lastIndex = 0;

    // Debug: log if buffer contains websearch
    if (this.buffer.includes('<websearch>')) {
      console.log('[Parser] Buffer contains <websearch>, pattern:', this.tagPattern.source);
    }

    let match;
    while ((match = this.tagPattern.exec(this.buffer)) !== null) {
      console.log('[Parser] Tag match:', match[0], 'closing:', match[1] === '/');
      let [fullMatch, isClosing, tagName, attrString] = match;
      tagName = tagName.toLowerCase();
      isClosing = isClosing === '/';

      // Text before this tag
      let textBefore = this.buffer.slice(lastIndex, match.index);

      if (textBefore) {
        if (this.elementStack.length > 0) {
          // Inside an element - accumulate as element content
          let currentElement = this.elementStack[this.elementStack.length - 1];
          currentElement.content += textBefore;

          this.emit('element_update', {
            id: currentElement.id,
            type: currentElement.type,
            content: currentElement.content,
            delta: textBefore,
          });
        } else {
          // Plain text outside elements
          this.textBuffer += textBefore;
          this.emit('text', { text: textBefore });
        }
      }

      if (isClosing) {
        // Closing tag
        this.handleClosingTag(tagName);
      } else {
        // Opening tag
        this.handleOpeningTag(tagName, attrString);
      }

      lastIndex = match.index + fullMatch.length;
    }

    // Keep unprocessed portion in buffer
    // But only if we might be in the middle of a tag
    let potentialTagStart = this.buffer.lastIndexOf('<', this.buffer.length - 1);

    if (potentialTagStart > lastIndex) {
      // There's a potential incomplete tag at the end
      let textBefore = this.buffer.slice(lastIndex, potentialTagStart);

      if (textBefore) {
        if (this.elementStack.length > 0) {
          let currentElement = this.elementStack[this.elementStack.length - 1];
          currentElement.content += textBefore;

          this.emit('element_update', {
            id: currentElement.id,
            type: currentElement.type,
            content: currentElement.content,
            delta: textBefore,
          });
        } else {
          this.textBuffer += textBefore;
          this.emit('text', { text: textBefore });
        }
      }

      this.buffer = this.buffer.slice(potentialTagStart);
    } else {
      // No incomplete tag, process remaining text
      let remaining = this.buffer.slice(lastIndex);

      if (remaining) {
        if (this.elementStack.length > 0) {
          let currentElement = this.elementStack[this.elementStack.length - 1];
          currentElement.content += remaining;

          this.emit('element_update', {
            id: currentElement.id,
            type: currentElement.type,
            content: currentElement.content,
            delta: remaining,
          });
        } else {
          this.textBuffer += remaining;
          this.emit('text', { text: remaining });
        }
      }

      this.buffer = '';
    }
  }

  /**
   * Handle an opening tag.
   */
  handleOpeningTag(tagName, attrString) {
    let id = uuidv4();
    let attributes = this.parseAttributes(attrString);

    // Check for self-closing (empty content elements)
    let isSelfClosing = attrString.trim().endsWith('/');

    let element = {
      id,
      type: tagName,
      attributes,
      content: '',
      executable: EXECUTABLE_ELEMENTS.includes(tagName),
      startTime: Date.now(),
    };

    this.emit('element_start', {
      id: element.id,
      type: element.type,
      attributes: element.attributes,
      executable: element.executable,
    });

    if (isSelfClosing) {
      // Self-closing element, complete immediately
      this.completeElement(element);
    } else {
      // Push onto stack
      this.elementStack.push(element);
    }
  }

  /**
   * Handle a closing tag.
   */
  handleClosingTag(tagName) {
    // Find matching opening tag (should be on top of stack)
    let elementIndex = -1;

    for (let i = this.elementStack.length - 1; i >= 0; i--) {
      if (this.elementStack[i].type === tagName) {
        elementIndex = i;
        break;
      }
    }

    if (elementIndex === -1) {
      // No matching opening tag - emit warning but continue
      this.emit('element_error', {
        type: tagName,
        error: `Closing tag </${tagName}> without matching opening tag`,
      });
      return;
    }

    // Pop element and any unclosed nested elements
    let closedElements = this.elementStack.splice(elementIndex);
    let element = closedElements[0];

    // Warn about any improperly nested elements
    for (let i = 1; i < closedElements.length; i++) {
      this.emit('element_error', {
        id: closedElements[i].id,
        type: closedElements[i].type,
        error: `Element <${closedElements[i].type}> implicitly closed by </${tagName}>`,
      });
    }

    this.completeElement(element);
  }

  /**
   * Mark an element as complete.
   */
  completeElement(element) {
    element.endTime = Date.now();
    element.content = element.content.trim();

    this.emit('element_complete', {
      id: element.id,
      type: element.type,
      attributes: element.attributes,
      content: element.content,
      executable: element.executable,
      duration: element.endTime - element.startTime,
    });

    if (element.executable) {
      this.pendingElements.push(element);
    }
  }

  /**
   * Parse attributes from tag attribute string.
   */
  parseAttributes(attrString) {
    if (!attrString || !attrString.trim()) return {};

    let attrs = {};
    let pattern = /(\w+)=["']([^"']*)["']/g;
    let match;

    while ((match = pattern.exec(attrString)) !== null) {
      attrs[match[1]] = match[2];
    }

    return attrs;
  }

  /**
   * Get all pending executable elements.
   */
  getPendingElements() {
    return this.pendingElements;
  }

  /**
   * Clear pending elements after execution.
   */
  clearPendingElements() {
    this.pendingElements = [];
  }
}

/**
 * Create a streaming parser instance.
 */
export function createStreamParser(options = {}) {
  return new StreamingHMLParser(options);
}

export default {
  StreamingHMLParser,
  createStreamParser,
  EXECUTABLE_ELEMENTS,
  ALL_ELEMENTS,
};
