'use strict';

// =============================================================================
// kikx-compaction-frame — Renders a compaction frame as a horizontal divider.
//
// Compaction frames are system-level UI elements that display compressed session
// history. They are NOT wrapped in <kikx-interaction> — they render directly
// in the chat flow as a full-width divider.
//
// Attributes:
//   frame-id          — The compaction frame's ID (for lazy-loading summary)
//   session-id        — The session ID (needed for API fetch)
//   status            — 'started' | 'finished' | 'abandoned'
//   started-at        — ISO timestamp
//   frames-compacted  — integer (how many frames were compressed)
//   compactor-name    — name of the agent that did compaction
// =============================================================================

import { t } from '../../lib/i18n.mjs';
import { getFrame } from '../../lib/api.mjs';

const TEMPLATE_HTML = `
  <style>
    kikx-compaction-frame {
      display: block;
      width: 100%;
      padding: 8px 0;
    }

    kikx-compaction-frame .compaction-divider {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--spacing-sm, 8px);
      padding: 10px 16px;
      margin: 4px 24px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: var(--border-radius-medium, 8px);
      color: var(--text-muted, #606078);
      font-size: 0.85rem;
      user-select: none;
      transition: background 0.2s ease, border-color 0.2s ease;
    }

    kikx-compaction-frame .compaction-divider.clickable {
      cursor: pointer;
    }

    kikx-compaction-frame .compaction-divider.clickable:hover {
      background: var(--glass-hover, rgba(255, 255, 255, 0.05));
      border-color: var(--accent-dim, rgba(0, 229, 255, 0.15));
    }

    kikx-compaction-frame .compaction-divider.abandoned {
      border-color: rgba(255, 68, 68, 0.20);
      color: var(--error-color, #ff4444);
    }

    kikx-compaction-frame .compaction-divider.in-progress {
      border-color: var(--accent-dim, rgba(0, 229, 255, 0.15));
    }

    kikx-compaction-frame .compaction-icon {
      flex-shrink: 0;
      font-size: 1rem;
      line-height: 1;
    }

    kikx-compaction-frame .compaction-text {
      flex: 0 1 auto;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    kikx-compaction-frame .compaction-toggle {
      flex-shrink: 0;
      font-size: 0.75rem;
      transition: transform 0.2s ease;
    }

    kikx-compaction-frame .compaction-toggle.expanded {
      transform: rotate(90deg);
    }

    kikx-compaction-frame .compaction-summary {
      display: none;
      margin: 0 24px 4px 24px;
      padding: 12px 16px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-top: none;
      border-radius: 0 0 var(--border-radius-medium, 8px) var(--border-radius-medium, 8px);
      color: var(--text-secondary, #a0a0b8);
      font-size: 0.85rem;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
    }

    kikx-compaction-frame .compaction-summary.visible {
      display: block;
    }

    kikx-compaction-frame .compaction-spinner {
      display: inline-flex;
      gap: 3px;
      font-weight: 600;
      font-size: 1rem;
      line-height: 1;
    }

    kikx-compaction-frame .compaction-spinner span {
      animation: compaction-pulse 1.4s ease-in-out infinite;
      opacity: 0.3;
    }

    kikx-compaction-frame .compaction-spinner span:nth-child(2) {
      animation-delay: 0.2s;
    }

    kikx-compaction-frame .compaction-spinner span:nth-child(3) {
      animation-delay: 0.4s;
    }

    @keyframes compaction-pulse {
      0%, 80%, 100% { opacity: 0.3; }
      40%           { opacity: 1; }
    }
  </style>

  <div class="compaction-divider">
    <span class="compaction-icon"></span>
    <span class="compaction-text"></span>
    <span class="compaction-toggle"></span>
  </div>
  <div class="compaction-summary"></div>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

function formatRelativeTime(isoString) {
  if (!isoString)
    return '';

  let date = new Date(isoString);
  if (isNaN(date.getTime()))
    return '';

  let now  = Date.now();
  let diff = now - date.getTime();

  if (diff < 60_000)
    return t('chat.timestamp.justNow') || 'just now';

  if (diff < 3_600_000)
    return (t('chat.timestamp.minutesAgo') || '{n}m ago').replace('{n}', String(Math.floor(diff / 60_000)));

  if (diff < 86_400_000)
    return (t('chat.timestamp.hoursAgo') || '{n}h ago').replace('{n}', String(Math.floor(diff / 3_600_000)));

  if (diff < 604_800_000)
    return (t('chat.timestamp.daysAgo') || '{n}d ago').replace('{n}', String(Math.floor(diff / 86_400_000)));

  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

class KikxCompactionFrame extends HTMLElement {
  static get observedAttributes() {
    return ['frame-id', 'session-id', 'status', 'started-at', 'frames-compacted', 'compactor-name'];
  }

  constructor() {
    super();

    this._expanded     = false;
    this._summaryCache = null;
    this._loading      = false;

    this._onDividerClick = this._onDividerClick.bind(this);
  }

  connectedCallback() {
    if (!this._initialized) {
      this._initialized = true;
      this.appendChild(getTemplate().content.cloneNode(true));

      this._divider   = this.querySelector('.compaction-divider');
      this._icon      = this.querySelector('.compaction-icon');
      this._text      = this.querySelector('.compaction-text');
      this._toggle    = this.querySelector('.compaction-toggle');
      this._summary   = this.querySelector('.compaction-summary');
    }

    this._divider.addEventListener('click', this._onDividerClick);
    this._render();
  }

  disconnectedCallback() {
    if (this._divider)
      this._divider.removeEventListener('click', this._onDividerClick);
  }

  attributeChangedCallback() {
    if (this.isConnected)
      this._render();
  }

  _render() {
    if (!this._divider)
      return;

    let status         = this.getAttribute('status') || 'started';
    let startedAt      = this.getAttribute('started-at');
    let framesCompacted = parseInt(this.getAttribute('frames-compacted') || '0', 10);
    let relativeTime   = formatRelativeTime(startedAt);

    // Reset CSS state classes
    this._divider.classList.remove('clickable', 'abandoned', 'in-progress');

    switch (status) {
      case 'started': {
        this._divider.classList.add('in-progress');
        this._icon.innerHTML = '<span class="compaction-spinner"><span>.</span><span>.</span><span>.</span></span>';
        this._text.textContent = t('compaction.inProgress') || 'Compacting session history...';
        this._toggle.textContent = '';
        this._summary.classList.remove('visible');
        break;
      }

      case 'finished': {
        this._divider.classList.add('clickable');

        let messageTemplate = t('compaction.finished') || 'Compacted {n} messages';
        let messageText     = messageTemplate.replace('{n}', String(framesCompacted));

        if (relativeTime)
          messageText += ` \u2014 ${relativeTime}`;

        this._icon.textContent  = (this._expanded) ? '\u25BE' : '\u25B8';
        this._text.textContent  = messageText;
        this._toggle.textContent = '';

        if (this._expanded)
          this._summary.classList.add('visible');
        else
          this._summary.classList.remove('visible');

        break;
      }

      case 'abandoned': {
        this._divider.classList.add('abandoned');

        let failedText = t('compaction.abandoned') || 'Compaction failed';

        if (relativeTime)
          failedText += ` \u2014 ${relativeTime}`;

        this._icon.textContent  = '\u26A0';
        this._text.textContent  = failedText;
        this._toggle.textContent = '';
        this._summary.classList.remove('visible');
        break;
      }

      default: {
        this._text.textContent = '';
        this._icon.textContent = '';
        this._toggle.textContent = '';
        break;
      }
    }
  }

  _onDividerClick() {
    let status = this.getAttribute('status');
    if (status !== 'finished')
      return;

    this._expanded = !this._expanded;

    if (this._expanded)
      this._expand();
    else
      this._collapse();
  }

  _collapse() {
    this._expanded = false;
    this._render();
  }

  async _expand() {
    this._expanded = true;
    this._render();

    // If summary is already cached, display it immediately
    if (this._summaryCache !== null) {
      this._summary.textContent = this._summaryCache;
      this._summary.classList.add('visible');

      return;
    }

    // Show loading state
    this._loading = true;
    this._summary.textContent = t('compaction.loading') || 'Loading summary...';
    this._summary.classList.add('visible');

    let frameID   = this.getAttribute('frame-id');
    let sessionID = this.getAttribute('session-id');

    if (!frameID || !sessionID) {
      this._summary.textContent = t('compaction.errorLoading') || 'Unable to load summary.';
      this._loading = false;

      return;
    }

    try {
      let result  = await getFrame(sessionID, frameID);
      let data    = (result && result.data) ? result.data : result;
      let frame   = data.frame || data;
      let content = frame.content || {};
      let summary = content.summary;

      if (typeof content === 'string') {
        try {
          let parsed = JSON.parse(content);
          summary = parsed.summary;
        } catch (_e) {
          // Not JSON — use as-is
        }
      }

      if (summary) {
        this._summaryCache      = summary;
        this._summary.textContent = summary;
      } else {
        this._summary.textContent = t('compaction.noSummary') || 'No summary available.';
      }
    } catch (error) {
      this._summary.textContent = t('compaction.errorLoading') || 'Unable to load summary.';
    } finally {
      this._loading = false;
    }
  }

  // Public getters for testing
  get expanded() { return this._expanded; }
  get loading()  { return this._loading; }
  get summaryCache() { return this._summaryCache; }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-compaction-frame', KikxCompactionFrame);

export default KikxCompactionFrame;
