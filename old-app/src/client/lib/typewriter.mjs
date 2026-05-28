'use strict';

// =============================================================================
// Typewriter Effect — Generic HTML Reveal Utility
// =============================================================================
// Smoothly reveals HTML content character-by-character with a fade-in effect.
// Works with rich HTML — reveals text nodes while keeping tags intact.
//
// Usage:
//   let tw = new Typewriter(containerElement, { charsPerFrame: 3 });
//   tw.setTarget('<p>Hello <strong>world</strong></p>');
//   // Characters appear gradually with fade-in animation
//   tw.finish(); // Instantly reveal remaining content
//   tw.destroy(); // Clean up
// =============================================================================

const TYPEWRITER_CSS = `
  @keyframes kikx-char-fade {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  .kikx-tw-char {
    animation: kikx-char-fade 0.15s ease-out forwards;
    opacity: 0;
  }
`;

let cssInjected = false;

function injectCSS(doc) {
  if (cssInjected)
    return;

  let style = doc.createElement('style');
  style.textContent = TYPEWRITER_CSS;
  doc.head.appendChild(style);
  cssInjected = true;
}

export class Typewriter {
  constructor(container, options = {}) {
    this._container      = container;
    this._charsPerFrame  = options.charsPerFrame || 3;
    this._frameInterval  = options.frameInterval || 16; // ~60fps
    this._targetHTML      = '';
    this._revealedLength  = 0;
    this._textPositions   = []; // flat list of { node, charIndex } for each text character
    this._rafID           = null;
    this._active          = false;
    this._finished        = false;

    if (container && container.ownerDocument)
      injectCSS(container.ownerDocument);
  }

  // Set the target HTML to type toward. Can be called multiple times
  // as streaming content arrives — it diffs from current position.
  setTarget(html) {
    if (!html || html === this._targetHTML)
      return;

    this._targetHTML = html;
    this._finished   = false;

    // Parse the full HTML into the container (hidden chars)
    this._parseAndHide();

    // Start the reveal loop if not already running
    if (!this._active)
      this._startReveal();
  }

  // Instantly reveal all remaining content (e.g., when stream completes)
  finish() {
    this._finished = true;
    this._cancelRAF();

    // Show all remaining hidden chars
    for (let i = this._revealedLength; i < this._textPositions.length; i++) {
      let pos = this._textPositions[i];
      if (pos.span && pos.span.parentNode) {
        // Replace span with raw text for clean DOM
        pos.span.replaceWith(pos.char);
      }
    }

    this._revealedLength = this._textPositions.length;
    this._active = false;
  }

  destroy() {
    this._cancelRAF();
    this._active = false;
    this._textPositions = [];
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  _parseAndHide() {
    // Set the full HTML in the container
    this._container.innerHTML = this._targetHTML;

    // Walk text nodes and wrap un-revealed characters in hidden spans
    let positions = [];
    this._walkTextNodes(this._container, positions);

    // Hide characters beyond what's already revealed
    for (let i = this._revealedLength; i < positions.length; i++) {
      let pos = positions[i];
      let span = this._container.ownerDocument.createElement('span');
      span.className   = 'kikx-tw-char';
      span.textContent = pos.char;
      span.style.opacity = '0';
      span.style.animation = 'none'; // Will be set when revealed

      // Replace the character in the text node with the span
      pos.span = span;
    }

    // Now do the actual DOM manipulation — split text nodes
    this._wrapHiddenChars(positions);
    this._textPositions = positions;
  }

  _walkTextNodes(node, positions) {
    for (let child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        // Text node — register each character
        for (let i = 0; i < child.textContent.length; i++) {
          positions.push({
            node:  child,
            char:  child.textContent[i],
            index: i,
            span:  null,
          });
        }
      } else if (child.nodeType === 1) {
        // Element — recurse
        this._walkTextNodes(child, positions);
      }
    }
  }

  _wrapHiddenChars(positions) {
    // Group consecutive chars from the same text node for efficient splitting
    let groups = [];
    let currentNode = null;
    let currentGroup = null;

    for (let i = this._revealedLength; i < positions.length; i++) {
      let pos = positions[i];

      if (pos.node !== currentNode) {
        if (currentGroup)
          groups.push(currentGroup);

        currentNode  = pos.node;
        currentGroup = { node: currentNode, start: i, chars: [] };
      }

      currentGroup.chars.push(pos);
    }

    if (currentGroup)
      groups.push(currentGroup);

    // Process each group: replace text node content with mix of raw text + spans
    for (let group of groups) {
      let textNode = group.node;
      let fullText = textNode.textContent;
      let parent   = textNode.parentNode;

      if (!parent)
        continue;

      let doc  = this._container.ownerDocument;
      let frag = doc.createDocumentFragment();

      // Characters before the reveal point stay as plain text
      let firstUnrevealed = group.chars[0].index;
      if (firstUnrevealed > 0)
        frag.appendChild(doc.createTextNode(fullText.slice(0, firstUnrevealed)));

      // Unrevealed characters get wrapped in spans
      for (let pos of group.chars)
        frag.appendChild(pos.span);

      parent.replaceChild(frag, textNode);
    }
  }

  _startReveal() {
    this._active = true;
    this._scheduleFrame();
  }

  _scheduleFrame() {
    this._rafID = requestAnimationFrame(() => this._revealFrame());
  }

  _revealFrame() {
    if (!this._active || this._finished)
      return;

    let revealed = 0;

    while (revealed < this._charsPerFrame && this._revealedLength < this._textPositions.length) {
      let pos = this._textPositions[this._revealedLength];

      if (pos.span) {
        pos.span.style.opacity   = '';
        pos.span.style.animation = '';
      }

      this._revealedLength++;
      revealed++;
    }

    if (this._revealedLength >= this._textPositions.length) {
      this._active = false;
      return;
    }

    this._scheduleFrame();
  }

  _cancelRAF() {
    if (this._rafID) {
      cancelAnimationFrame(this._rafID);
      this._rafID = null;
    }
  }
}
