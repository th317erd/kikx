'use strict';

import './kikx-user-message-frame.mjs';
import './kikx-coordination-frame.mjs';
import { isCoordinationWakeFrame } from '../../shared/coordination-visibility.mjs';
import { buildFrameQuickActions } from './kikx-frame-quick-actions.mjs';
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
import { isFrameExpanded, isFrameRevealed, revealFrame, setFrameExpanded, setFrameRevealed } from '../state/frame-expansion.mjs';
import './kikx-typing-indicator.mjs';
import './kikx-sub-session-frame.mjs';

const { div, p, span, strong, time } = elements;

const MINIMIZED_EXCEPTIONS = new Set([
  'read-file',
  'write-file',
  'web-search',
  'web-fetch',
]);

function isToolFrame(frame) {
  if (!frame?.type)
    return false;
  return frame.type === 'ToolCall'
    || frame.type === 'ToolResult'
    || /ToolFrame$/.test(frame.type);
}

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

  // A coordination wake is persisted as a UserMessage but is not chat: it is the
  // system telling one bot what to do. It gets its own card so a person can tell
  // "the system woke this bot" apart from "a human said this".
  if (isCoordinationWakeFrame(frame))
    return { kind: 'coordination', tagName: 'kikx-coordination-frame' };

  if (frame.type === 'UserMessage')
    return { kind: 'user-message', tagName: 'kikx-user-message-frame' };

  if (frame.type === 'AgentMessage' || frame.type === 'AgentProgress')
    return { kind: frame.content?.status === 'streaming' ? 'stream' : 'markdown', tagName: null };

  return { kind: 'text', tagName: null };
}

function setTextIfChanged(node, next) {
  let value = next ?? '';
  if (node.textContent !== value)
    node.textContent = value;
}

function frameDebugClass(frame) {
  return frame?.type ? `kikx-frame--${frame.type}` : '';
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

function renderHeaderStatusLabel(label, data = {}) {
  label.textContent = '';
  if (data.code === true) {
    let code = document.createElement('code');
    code.textContent = data.label || '';
    label.appendChild(code);
    return;
  }

  label.textContent = data.label || '';
}

function buildHeaderStatus(frame, compact) {
  let data = frameHeaderStatus(frame, compact);
  if (!data)
    return null;

  let label = span.class('kikx-frame__meta-status-label').build(document);
  renderHeaderStatusLabel(label, data);
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
    this._minimized = false;
    this._compactView = null;
    this._contentParent = null;
    this._quickActions = null;
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

    if (this._quickActions)
      this._quickActions._frame = nextFrame;
  }

  connectedCallback() {
    if (!this._compactClickBound) {
      this._compactClickBound = true;
      this.addEventListener('click', this._onCompactClick);
      this.addEventListener('keydown', this._onCompactKeydown);
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

    // Clicking inside expanded content is selection/scroll interaction, not a
    // request to collapse the row. In particular, the horizontal scrollbar on
    // a <pre> must not close the disclosure under the pointer.
    if (event.target?.closest?.('a, button, input, textarea, select, summary, pre, code, .kikx-frame__compact-body'))
      return;

    let selection = globalThis.getSelection?.();
    if (selection && selection.isCollapsed === false)
      return;

    if (this._minimized) {
      this._revealMinimized();
      return;
    }

    details.open = !details.open;
  }

  _onCompactKeydown(event) {
    if (!this._minimized || (event.key !== 'Enter' && event.key !== ' '))
      return;
    if (event.target?.closest?.('a, button, input, textarea, select, summary'))
      return;

    event.preventDefault();
    this._revealMinimized();
  }

  _revealMinimized() {
    let frameID = this._frame?.id;
    if (frameID)
      revealFrame(frameID);
    this._minimized = false;
    this.classList.remove('kikx-frame--minimized');
    if (this._compactView) {
      this._compactView.element.hidden = false;
      this._compactView.element.open = false;
    }
    this._syncMinimizedAccessibility();
  }

  _syncMinimizedAccessibility() {
    if (!this._metaElement)
      return;

    if (this._minimized) {
      this._metaElement.setAttribute('role', 'button');
      this._metaElement.setAttribute('tabindex', '0');
      this._metaElement.setAttribute('aria-expanded', 'false');
      this._metaElement.setAttribute('aria-label', 'Expand message');
    } else {
      this._metaElement.removeAttribute('role');
      this._metaElement.removeAttribute('tabindex');
      this._metaElement.removeAttribute('aria-expanded');
      this._metaElement.removeAttribute('aria-label');
    }
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
      this._appendHoverTarget();
      this._metaElement = meta;
      this._contentElement = content;
      this._compact = compact;
      this._compactView = null;
      this._contentParent = this;
      this._minimized = compact
        && this._shouldMinimize(frame)
        && !isFrameRevealed(frame.id)
        && !isFrameExpanded(frame.id);

      this._applyFrameState(frame, compact);

      if (compact) {
        this._compactView = buildCompactFrameDisclosure(frame, [], document);
        this._contentParent = this._compactView.body;
        // Rebuilding this item must not collapse a frame the user opened.
        // Expansion lives in a module-level store keyed by frame id, not in
        // the DOM, because `_render()` throws the whole subtree away. The
        // store never opens anything on its own: an id the user never
        // expanded reports false, so the default stays collapsed.
        this._compactView.element.open = !this._minimized && isFrameExpanded(frame.id);
        // Keep the "{Name} {time}" header visible above the compact line.
        if (meta)
          this.appendChild(meta);
        this._syncMinimizedAccessibility();
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

      this._quickActions = buildFrameQuickActions(frame, document);
      this.appendChild(this._quickActions);

      return true;
    }, { frameID: frame.id, frameType: frame.type });

    if (!rendered) {
      this._contentKind = previous.contentKind;
      this._contentTag = previous.contentTag;
      this._lastMarkdownText = previous.lastMarkdownText;
    }
  }

  _appendHoverTarget() {
    let target = document.createElement('div');
    target.className = 'kikx-frame__hover-target';
    target.setAttribute('aria-hidden', 'true');
    this.appendChild(target);
  }

  _applyFrameState(frame, compact) {
    let status = frameStatus(frame);
    let tinted = compact || isBotCommunicationFrame(frame) || frame.type === 'Question';
    let className = `kikx-frame kikx-frame--${frame.type}`;
    // A coordination wake is persisted as a UserMessage, and `.kikx-frame--
    // UserMessage` right-aligns the frame for owner chat (app.css:678). The wake
    // is a system event, not a message from a person, so it carries a modifier
    // that resets that alignment and the bubble treatment.
    if (isCoordinationWakeFrame(frame))
      className += ' kikx-frame--coordination';
    if (compact)
      className += ' kikx-frame--compact';
    if (this._minimized)
      className += ' kikx-frame--minimized';
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

  _shouldMinimize(frame) {
    if (!isToolFrame(frame) || sessionReferenceFromFrame(frame))
      return false;

    let toolName = String(frame?.content?.toolName || '');
    return !MINIMIZED_EXCEPTIONS.has(toolName);
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
      if (this._shouldMinimize(this._frame)) {
        this._minimizeFrame();
        return;
      }
      return;
    }

    this._ensureCompactContent();
  }

  _minimizeFrame() {
    let frameID = this._frame?.id;
    if (frameID)
      setFrameRevealed(frameID, false);
    this._minimized = true;
    this.classList.add('kikx-frame--minimized');
    this._discardContentElement();
    if (this._compactView) {
      this._compactView.element.open = false;
      this._compactView.body.replaceChildren();
    }
    this._syncMinimizedAccessibility();
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
        renderHeaderStatusLabel(statusLabel, statusData);

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

    let debugClass = main?.querySelector('.kikx-frame__debug-class');
    let debugLabel = frameDebugClass(frame);
    if (!debugClass && main) {
      debugClass = span.class('kikx-frame__debug-class')(debugLabel).build(document);
      main.appendChild(debugClass);
    } else if (debugClass) {
      setTextIfChanged(debugClass, debugLabel);
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

    if (descriptor.kind === 'user-message') {
      let child = this._contentElement.firstElementChild;
      if (hasTagName(child, descriptor.tagName)) {
        child.updateFrame(frame, this._appState);
        return;
      }
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
      span.class('kikx-frame__debug-class')(frameDebugClass(frame)),
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

    if (descriptor.kind === 'coordination') {
      let element = document.createElement('kikx-coordination-frame');
      element.updateFrame(frame, this._appState);
      return div.class('kikx-frame__content kikx-frame__content--coordination')(element).build(document);
    }

    if (descriptor.kind === 'user-message') {
      let element = document.createElement('kikx-user-message-frame');
      element.updateFrame(frame, this._appState);
      return div.class('kikx-frame__content kikx-frame__content--user-message')(element).build(document);
    }

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
