'use strict';

import { thinkingLines } from '../state/thinking-state.mjs';

const MAX_RENDERED_LINES = 200;
const CURSOR_OFFSET = 16;

// One agent's live "thinking" affordance: a 🧠 icon that giggles while the agent
// thinks. Hovering it reveals the live thinking text in a cursor-following tooltip
// (newest line pinned to the bottom; older lines fade out the top). The tooltip is
// attached to document.body and positioned `fixed`, so no ancestor's overflow or
// transform can clip it.
const TEMPLATE_HTML = `
  <button type="button" class="kikx-thinking-brain" aria-label="Agent is thinking">🧠</button>
`;

const TIP_HTML = `
  <header class="kikx-thinking-tip__head">
    <span class="kikx-thinking-tip__name"></span><span class="kikx-thinking-tip__dots"><span>.</span><span>.</span><span>.</span></span>
  </header>
  <div class="kikx-thinking-tip__window">
    <div class="kikx-thinking-tip__lines"></div>
  </div>
`;

export class KikxThinkingPanel extends HTMLElement {
  constructor() {
    super();
    this._entry = null;
    this._lines = [];
    this._tip = null;
    this._onPointerMove = (event) => this._positionTip(event.clientX, event.clientY);
    this._onPointerLeave = () => this._hideTip();
  }

  connectedCallback() {
    if (!this._initialized) {
      this._initialized = true;
      this.innerHTML = TEMPLATE_HTML;
      this._brainElement = this.querySelector('.kikx-thinking-brain');
      this._brainElement.addEventListener('mouseenter', this._onPointerMove);
      this._brainElement.addEventListener('mousemove', this._onPointerMove);
      this._brainElement.addEventListener('mouseleave', this._onPointerLeave);
      this._brainElement.addEventListener('blur', this._onPointerLeave);
    }

    if (this._entry)
      this._applyEntry();
  }

  disconnectedCallback() {
    this._tip?.remove();
    this._tip = null;
    this._tipName = null;
    this._tipLines = null;
  }

  setEntry(entry = {}) {
    this._entry = entry;
    if (this.isConnected)
      this._applyEntry();
  }

  _ensureTip() {
    if (this._tip)
      return this._tip;

    let tip = document.createElement('div');
    tip.className = 'kikx-thinking-tip';
    tip.hidden = true;
    tip.innerHTML = TIP_HTML;
    document.body.appendChild(tip);
    this._tip = tip;
    this._tipName = tip.querySelector('.kikx-thinking-tip__name');
    this._tipLines = tip.querySelector('.kikx-thinking-tip__lines');
    return tip;
  }

  _applyEntry() {
    this._applyName(this._entry?.name || 'Agent');
    this._applyLines(thinkingLines(this._entry?.text || '', MAX_RENDERED_LINES));
  }

  _applyName(name) {
    let tip = this._ensureTip();
    if (this._tipName && this._tipName.textContent !== name)
      this._tipName.textContent = name;
    return tip;
  }

  _applyLines(next) {
    this._ensureTip();
    let container = this._tipLines;
    if (!container)
      return;

    let children = container.children;
    for (let index = 0; index < next.length; index++) {
      let line = children[index];
      if (!line) {
        line = document.createElement('div');
        line.className = 'kikx-thinking-tip__line';
        container.appendChild(line);
      }

      if (line.textContent !== next[index])
        line.textContent = next[index];
    }

    while (container.children.length > next.length)
      container.removeChild(container.lastElementChild);

    while (container.children.length > MAX_RENDERED_LINES)
      container.removeChild(container.firstElementChild);

    this._lines = next;
  }

  _positionTip(x, y) {
    let tip = this._ensureTip();
    tip.hidden = false;
    let rect = tip.getBoundingClientRect();
    let left = x + CURSOR_OFFSET;
    let top = y + CURSOR_OFFSET;

    if (left + rect.width > window.innerWidth - 8)
      left = Math.max(8, x - rect.width - CURSOR_OFFSET);
    if (top + rect.height > window.innerHeight - 8)
      top = Math.max(8, y - rect.height - CURSOR_OFFSET);

    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  _hideTip() {
    if (this._tip)
      this._tip.hidden = true;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-thinking-panel'))
  customElements.define('kikx-thinking-panel', KikxThinkingPanel);
