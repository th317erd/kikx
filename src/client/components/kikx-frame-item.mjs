'use strict';

import { elements, $, cleanupBindings } from '../lib/aeor-ui.mjs';
import { guardClientOperation } from '../lib/error-boundary.mjs';
import { renderMarkdownToElement } from '../lib/markdown-renderer.mjs';
import {
  frameDisplayLabel,
  frameTimestamp,
} from './frame-labels.mjs';
import { resolveFrameComponentDescriptor } from './frame-component-registry.mjs';
import { sessionReferenceFromFrame } from './kikx-sub-session-frame.mjs';
import { buildCompactFrameDisclosure, updateCompactSummary } from './compact-frame-view.mjs';
import {
  compactFrameHeader,
  frameMoodBand,
  frameStatus,
  frameStatusClass,
  isBotCommunicationFrame,
  isCompactFrame,
} from './tool-frame-summary.mjs';
import { setIcon } from '../lib/icons.mjs';
import { countRebuild } from './render-stats.mjs';
import { isFrameExpanded, setFrameExpanded } from '../state/frame-expansion.mjs';
import './kikx-typing-indicator.mjs';
import './kikx-sub-session-frame.mjs';

const { div, p, span, strong, time } = elements;

// Browsers expose element.tagName in UPPERCASE and element.localName in
// lowercase, while descriptors/specs use lowercase names. Normalize once so
// the reuse checks cannot drift apart.
function normalizeTagName(name) {
  return String(name ?? '').toLowerCase();
}

function hasTagName(element, expected) {
  if (!element)
    return false;
  return normalizeTagName(element.localName || element.tagName) === normalizeTagName(expected);
}

// The runtime replaces frame objects on every event, so object identity is not
// a stable key. Type + id identifies the logical frame and decides whether the
// item may be reconciled in place.
function frameKey(frame) {
  if (!frame)
    return null;
  return `${frame.type ?? ''}\u0000${frame.id ?? ''}`;
}

function streamText(frame) {
  return frame.content?.text || frame.content?.delta || '';
}

function thinkingText(frame) {
  return frame.content?.text || '';
}

function plainText(frame) {
  return frame.content?.text || frame.contentText || '';
}

function markdownText(frame) {
  return frame.content?.text || frame.contentText || '';
}

function typingAgentName(frame) {
  return frame.content?.agentName || frame.authorDisplayName || frame.authorID || 'Agent';
}

function typingThinkingText(frame) {
  return frame.content?.thinkingText || frame.content?.text || '';
}

// Describes the content subtree so reconciliation can tell when it may be
// reused (same kind + tag) versus replaced.
function frameContentDescriptor(frame, appState) {
  if (sessionReferenceFromFrame(frame))
    return { kind: 'sub-session', tagName: 'kikx-sub-session-frame' };

  let descriptor = resolveFrameComponentDescriptor(frame, appState);
  if (descriptor?.tagName)
    return { kind: 'custom', tagName: descriptor.tagName };

  if (frame.type === 'AgentMessageDelta')
    return { kind: 'stream', tagName: null };

  if (frame.type === 'AgentThinking')
    return { kind: 'thinking', tagName: null };

  if (frame.type === 'AgentMessage' || frame.type === 'AgentProgress' || frame.type === 'UserMessage')
    return { kind: frame.content?.status === 'streaming' ? 'stream' : 'markdown', tagName: null };

  return { kind: 'text', tagName: null };
}

function setTextIfChanged(node, next) {
  let value = next ?? '';
  if (node.textContent !== value)
    node.textContent = value;
}

function frameHeaderStatus(frame, compact) {
  if (compact)
    return compactFrameHeader(frame);

  let isMessage = frame?.type === 'AgentMessage'
    || frame?.type === 'AgentMessageDelta'
    || frame?.type === 'AgentProgress'
    || frame?.type === 'UserMessage';
  if (!isMessage)
    return null;

  let moodWord = typeof frame?.content?.moodWord === 'string' ? frame.content.moodWord.trim() : '';
  return { label: moodWord || 'Message', icon: 'chat' };
}

function buildHeaderStatus(frame, compact) {
  let data = frameHeaderStatus(frame, compact);
  if (!data)
    return null;

  let label = span.class('kikx-frame__meta-status-label')(data.label).build(document);
  let icon = span.class('kikx-frame__compact-icon').build(document);
  icon.setAttribute('aria-hidden', 'true');
  setIcon(icon, data.icon, { ownerDocument: document });

  return div.class('kikx-frame__meta-status')(label, icon).build(document);
}

export class KikxFrameItem extends HTMLElement {
  constructor() {
    super();
    this._frame = null;
    this._appState = null;
    this._frameKey = null;
    this._metaElement = null;
    this._contentElement = null;
    this._contentKind = null;
    this._contentTag = null;
    this._lastMarkdownText = null;
    this._compact = false;
    this._compactView = null;
    this._contentParent = null;
  }

  updateFrame(frame, appState = {}, options = {}) {
    let nextFrame = frame || null;
    let nextAppState = appState || {};
    let nextKey = frameKey(nextFrame);
    let keyChanged = this._frameKey !== nextKey;
    let appStateChanged = this._appState !== nextAppState;

    if (
      options.force !== true
      && !keyChanged
      && !appStateChanged
      && this._frame === nextFrame
    )
      return;

    this._frame = nextFrame;
    this._appState = nextAppState;
    this._frameKey = nextKey;

    // Object identity is only one rebuild trigger: a different key or app state
    // requires a wholesale rebuild, but a fresh frame object for the same logical
    // frame is reconciled in place so the subtree (and its animations) survive.
    if (options.force === true || keyChanged || appStateChanged)
      this._render();
    else
      this._reconcile();
  }

  connectedCallback() {
    if (!this._compactClickBound) {
      this._compactClickBound = true;
      this.addEventListener('click', this._onCompactClick);
    }

    if (this._frame && this.childNodes.length === 0)
      this._render();
  }

  // Compact frames toggle when clicked anywhere (not just the short summary
  // line), except while selecting text or interacting with a control.
  _onCompactClick(event) {
    let details = this._compactView?.element;
    if (!details)
      return;

    if (event.target?.closest?.('a, button, input, textarea, select, summary'))
      return;

    let selection = globalThis.getSelection?.();
    if (selection && selection.isCollapsed === false)
      return;

    details.open = !details.open;
  }

  disconnectedCallback() {
    cleanupBindings(this);
  }

  _render() {
    let frame = this._frame;
    if (!frame)
      return;

    countRebuild('frameItem');
    let previous = {
      contentKind: this._contentKind,
      contentTag: this._contentTag,
      lastMarkdownText: this._lastMarkdownText,
    };

    // Build the new subtree against a detached tree first, then swap it in. A
    // throwing renderer must leave the previous DOM (and its refs) untouched.
    let rendered = guardClientOperation('kikx-frame-item.render', () => {
      let compact = this._shouldCompact(frame);
      let meta = null;
      let content = null;
      if (frame.type === 'BeginTyping') {
        content = this._buildTypingIndicator(frame);
        this._contentKind = null;
        this._contentTag = null;
        this._lastMarkdownText = null;
      } else {
        meta = this._buildFrameMeta(frame, compact);
        // Compact frames keep only their summary and command preview in the DOM.
        // The tool card/output subtree is built on first expansion, not eagerly.
        if (!compact)
          content = this._buildFrameContent(frame);
      }

      cleanupBindings(this);
      $(this).empty();
      this._metaElement = meta;
      this._contentElement = content;
      this._compact = compact;
      this._compactView = null;
      this._contentParent = this;

      this._applyFrameState(frame, compact);

      if (compact) {
        this._compactView = buildCompactFrameDisclosure(frame, [], document);
        this._contentParent = this._compactView.body;
        // Rebuilding this item must not collapse a frame the user opened.
        // Expansion lives in a module-level store keyed by frame id, not in
        // the DOM, because `_render()` throws the whole subtree away. The
        // store never opens anything on its own: an id the user never
        // expanded reports false, so the default stays collapsed.
        this._compactView.element.open = isFrameExpanded(frame.id);
        // Keep the "{Name} {time}" header visible above the compact line.
        if (meta)
          this.appendChild(meta);
        // Expanding the compact row builds the details; nested output/arguments
        // disclosures stay lazy until the user opens them too. Collapsing removes
        // the whole details subtree again.
        this._compactView.element.addEventListener('toggle', () => this._onCompactToggle());
        this.appendChild(this._compactView.element);
        if (this._compactView.element.open)
          this._ensureCompactContent();
      } else {
        if (meta)
          this.appendChild(meta);
        if (content)
          this.appendChild(content);
      }

      return true;
    }, { frameID: frame.id, frameType: frame.type });

    if (!rendered) {
      this._contentKind = previous.contentKind;
      this._contentTag = previous.contentTag;
      this._lastMarkdownText = previous.lastMarkdownText;
    }
  }

  _applyFrameState(frame, compact) {
    let status = frameStatus(frame);
    let tinted = compact || isBotCommunicationFrame(frame);
    let className = `kikx-frame kikx-frame--${frame.type}`;
    if (compact)
      className += ' kikx-frame--compact';
    if (tinted)
      className += ` ${frameStatusClass(status)}`;

    this.className = className;
    this.setAttribute('role', 'listitem');
    this.dataset.frameId = frame.id || '';
    this.dataset.frameType = frame.type || '';
    this.dataset.toolName = frame.content?.toolName || '';
    let moodBand = frameMoodBand(frame);
    if (moodBand)
      this.dataset.moodBand = moodBand;
    else
      this.removeAttribute('data-mood-band');

    if (tinted)
      this.dataset.frameStatus = status;
    else
      this.removeAttribute('data-frame-status');
  }

  _shouldCompact(frame) {
    return isCompactFrame(frame) && !sessionReferenceFromFrame(frame);
  }

  _reconcile() {
    let frame = this._frame;
    if (!frame) {
      this._render();
      return;
    }

    let compact = this._shouldCompact(frame);
    if (compact !== this._compact || (compact && !this._compactView)) {
      this._render();
      return;
    }

    guardClientOperation('kikx-frame-item.reconcile', () => {
      this._applyFrameState(frame, compact);

      if (frame.type === 'BeginTyping') {
        this._reconcileTypingIndicator(frame);
        return;
      }

      if (!this._metaElement) {
        this._render();
        return;
      }

      if (compact) {
        updateCompactSummary(this._compactView, frame);
        this._reconcileFrameMeta(frame);
        if (this._compactView.element.open) {
          this._ensureCompactContent();
          if (this._contentElement)
            this._reconcileFrameContent(frame);
        } else {
          this._discardContentElement();
        }
        return;
      }

      this._reconcileFrameMeta(frame);
      this._reconcileFrameContent(frame);
    }, { frameID: frame.id, frameType: frame.type });
  }

  _onCompactToggle() {
    let details = this._compactView?.element;
    if (!details)
      return;

    // Record what the user just did so a later rebuild can restore it.
    setFrameExpanded(this._frame?.id, details.open);

    if (!details.open) {
      this._discardContentElement();
      return;
    }

    this._ensureCompactContent();
  }

  _ensureCompactContent() {
    if (this._contentElement || !this._compactView)
      return;

    let content = this._buildFrameContent(this._frame);
    if (!content)
      return;

    this._contentElement = content;
    this._contentParent = this._compactView.body;
    this._contentParent.appendChild(content);
  }

  _reconcileTypingIndicator(frame) {
    let indicator = this._contentElement;
    if (!hasTagName(indicator, 'kikx-typing-indicator')) {
      this._discardContentElement();
      this._contentElement = this._buildTypingIndicator(frame);
      this.appendChild(this._contentElement);
      return;
    }

    indicator.agentName = typingAgentName(frame);
    indicator.thinkingText = typingThinkingText(frame);
  }

  _reconcileFrameMeta(frame) {
    let main = this._metaElement.querySelector('.kikx-frame__meta-main');
    let label = main?.querySelector('strong');
    if (label)
      setTextIfChanged(label, frameDisplayLabel(frame, this._appState));

    let status = this._metaElement.querySelector('.kikx-frame__meta-status');
    let statusData = frameHeaderStatus(frame, this._compact);
    if (status && statusData) {
      let statusLabel = status.querySelector('.kikx-frame__meta-status-label');
      if (statusLabel)
        setTextIfChanged(statusLabel, statusData.label);

      let icon = status.querySelector('.kikx-frame__compact-icon');
      if (icon && icon.dataset.icon !== statusData.icon)
        setIcon(icon, statusData.icon, { ownerDocument: icon.ownerDocument || document });
    }

    let timestamp = frameTimestamp(frame);
    let timeElement = main?.querySelector('.kikx-frame__timestamp');
    if (timestamp) {
      if (!timeElement) {
        timeElement = time.class('kikx-frame__timestamp')
          .datetime(timestamp.dateTime)
          .title(timestamp.title)('')
          .build(document);
        main?.appendChild(timeElement);
      }
      if (timeElement.getAttribute('datetime') !== timestamp.dateTime)
        timeElement.setAttribute('datetime', timestamp.dateTime);
      if (timeElement.getAttribute('title') !== timestamp.title)
        timeElement.setAttribute('title', timestamp.title);
      setTextIfChanged(timeElement, timestamp.label);
    } else if (timeElement) {
      timeElement.remove();
    }
  }

  _reconcileFrameContent(frame) {
    let descriptor = frameContentDescriptor(frame, this._appState);
    if (
      !this._contentElement
      || this._contentKind !== descriptor.kind
      || normalizeTagName(this._contentTag) !== normalizeTagName(descriptor.tagName)
    ) {
      this._replaceContentElement(frame);
      return;
    }

    if (descriptor.kind === 'sub-session') {
      let child = this._contentElement.firstElementChild;
      if (hasTagName(child, descriptor.tagName)) {
        child.appState = this._appState;
        child.updateFrame(frame, this._appState);
        return;
      }
      this._replaceContentElement(frame);
      return;
    }

    if (descriptor.kind === 'custom') {
      let child = this._contentElement.firstElementChild;
      if (hasTagName(child, descriptor.tagName)) {
        child.appState = this._appState;
        if (typeof child.updateFrame === 'function')
          child.updateFrame(frame, this._appState);
        else
          child.frame = frame;
        return;
      }
      this._replaceContentElement(frame);
      return;
    }

    if (descriptor.kind === 'stream') {
      setTextIfChanged(this._contentElement, streamText(frame));
      return;
    }

    if (descriptor.kind === 'thinking') {
      setTextIfChanged(this._contentElement, thinkingText(frame));
      return;
    }

    if (descriptor.kind === 'text') {
      setTextIfChanged(this._contentElement, plainText(frame) || frame.id || '');
      return;
    }

    if (descriptor.kind === 'markdown')
      this._reconcileMarkdown(frame);
  }

  _reconcileMarkdown(frame) {
    let text = markdownText(frame);
    if (this._lastMarkdownText === text)
      return;

    let rendered = renderMarkdownToElement(document, text, {
      className: this._contentElement.className,
    });

    cleanupBindings(this._contentElement);
    while (this._contentElement.firstChild)
      this._contentElement.removeChild(this._contentElement.firstChild);

    for (let child of [ ...rendered.childNodes ])
      this._contentElement.appendChild(child);

    this._lastMarkdownText = text;
  }

  _replaceContentElement(frame) {
    this._discardContentElement();
    this._contentElement = this._buildFrameContent(frame);
    this._contentParent.appendChild(this._contentElement);
  }

  _discardContentElement() {
    if (!this._contentElement)
      return;

    cleanupBindings(this._contentElement);
    this._contentElement.remove();
    this._contentElement = null;
    this._contentKind = null;
    this._contentTag = null;
    this._lastMarkdownText = null;
  }

  _buildTypingIndicator(frame) {
    let indicator = document.createElement('kikx-typing-indicator');
    indicator.agentName = typingAgentName(frame);
    indicator.thinkingText = typingThinkingText(frame);
    return indicator;
  }

  _buildFrameMeta(frame, compact = false) {
    let timestamp = frameTimestamp(frame);
    let main = div.class('kikx-frame__meta-main')(
      strong(frameDisplayLabel(frame, this._appState)),
      timestamp
        ? time
          .class('kikx-frame__timestamp')
          .datetime(timestamp.dateTime)
          .title(timestamp.title)(timestamp.label)
        : null,
    ).build(document);

    return div.class('kikx-frame__meta')(
      main,
      buildHeaderStatus(frame, compact),
    ).build(document);
  }

  _buildFrameContent(frame) {
    let descriptor = frameContentDescriptor(frame, this._appState);
    this._contentKind = descriptor.kind;
    this._contentTag = descriptor.tagName;

    if (descriptor.kind === 'sub-session')
      return this._buildSubSessionCard(frame);

    if (descriptor.kind === 'custom')
      return this._buildCustomFrameContent(frame);

    if (descriptor.kind === 'stream')
      return div.class('kikx-frame__content kikx-frame__stream')(streamText(frame)).build(document);

    if (descriptor.kind === 'thinking')
      return p.class('kikx-frame__thinking')(thinkingText(frame)).build(document);

    if (descriptor.kind === 'markdown') {
      this._lastMarkdownText = markdownText(frame);
      return renderMarkdownToElement(document, markdownText(frame), {
        className: 'kikx-frame__content kikx-markdown',
      });
    }

    return p(plainText(frame) || frame.id || '').build(document);
  }

  _buildSubSessionCard(frame) {
    let element = document.createElement('kikx-sub-session-frame');
    element.appState = this._appState;
    element.updateFrame(frame, this._appState);
    return div.class('kikx-frame__content kikx-frame__content--sub-session')(element).build(document);
  }

  _buildCustomFrameContent(frame) {
    let descriptor = resolveFrameComponentDescriptor(frame, this._appState);
    if (!descriptor?.tagName)
      return null;

    let element = document.createElement(descriptor.tagName);
    element.appState = this._appState;
    if (typeof element.updateFrame === 'function')
      element.updateFrame(frame, this._appState);
    else
      element.frame = frame;

    return div.class('kikx-frame__content kikx-frame__content--custom')(element).build(document);
  }

}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-frame-item'))
  customElements.define('kikx-frame-item', KikxFrameItem);
