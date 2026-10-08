'use strict';

import { elements, $ } from '../lib/aeor-ui.mjs';
import { guardClientOperation } from '../lib/error-boundary.mjs';
import { renderMarkdownToElement } from '../lib/markdown-renderer.mjs';
import {
  frameDisplayLabel,
  frameSecondaryLabel,
  frameTimestamp,
} from './frame-labels.mjs';
import { resolveFrameComponentDescriptor } from './frame-component-registry.mjs';
import { sessionReferenceFromFrame } from './kikx-sub-session-frame.mjs';
import { countRebuild } from './render-stats.mjs';
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

  if (frame.type === 'AgentMessage')
    return { kind: frame.content?.status === 'streaming' ? 'stream' : 'markdown', tagName: null };

  return { kind: 'text', tagName: null };
}

function setTextIfChanged(node, next) {
  let value = next ?? '';
  if (node.textContent !== value)
    node.textContent = value;
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
    if (this._frame && this.childNodes.length === 0)
      this._render();
  }

  disconnectedCallback() {
    this._cleanupReactiveBindings();
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
      let meta = null;
      let content = null;
      if (frame.type === 'BeginTyping') {
        content = this._buildTypingIndicator(frame);
        this._contentKind = null;
        this._contentTag = null;
        this._lastMarkdownText = null;
      } else {
        meta = this._buildFrameMeta(frame);
        content = this._buildFrameContent(frame);
      }

      this._cleanupReactiveBindings();
      $(this).empty();
      this._metaElement = meta;
      this._contentElement = content;

      this.className = `kikx-frame kikx-frame--${frame.type}`;
      this.setAttribute('role', 'listitem');
      this.dataset.frameId = frame.id || '';
      this.dataset.frameType = frame.type || '';

      if (meta)
        this.appendChild(meta);
      if (content)
        this.appendChild(content);

      return true;
    }, { frameID: frame.id, frameType: frame.type });

    if (!rendered) {
      this._contentKind = previous.contentKind;
      this._contentTag = previous.contentTag;
      this._lastMarkdownText = previous.lastMarkdownText;
    }
  }

  _reconcile() {
    let frame = this._frame;
    if (!frame) {
      this._render();
      return;
    }

    guardClientOperation('kikx-frame-item.reconcile', () => {
      this.className = `kikx-frame kikx-frame--${frame.type}`;
      this.dataset.frameId = frame.id || '';
      this.dataset.frameType = frame.type || '';

      if (frame.type === 'BeginTyping') {
        this._reconcileTypingIndicator(frame);
        return;
      }

      if (!this._metaElement) {
        this._render();
        return;
      }

      this._reconcileFrameMeta(frame);
      this._reconcileFrameContent(frame);
    }, { frameID: frame.id, frameType: frame.type });
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

    let secondary = this._metaElement.querySelector('.kikx-frame__secondary');
    if (secondary)
      setTextIfChanged(secondary, frameSecondaryLabel(frame));
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

    this._cleanupReactiveBindings(this._contentElement);
    while (this._contentElement.firstChild)
      this._contentElement.removeChild(this._contentElement.firstChild);

    for (let child of [ ...rendered.childNodes ])
      this._contentElement.appendChild(child);

    this._lastMarkdownText = text;
  }

  _replaceContentElement(frame) {
    this._discardContentElement();
    this._contentElement = this._buildFrameContent(frame);
    this.appendChild(this._contentElement);
  }

  _discardContentElement() {
    if (!this._contentElement)
      return;

    this._cleanupReactiveBindings(this._contentElement);
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

  _buildFrameMeta(frame) {
    let timestamp = frameTimestamp(frame);

    return div.class('kikx-frame__meta')(
      div.class('kikx-frame__meta-main')(
        strong(frameDisplayLabel(frame, this._appState)),
        timestamp
          ? time
            .class('kikx-frame__timestamp')
            .datetime(timestamp.dateTime)
            .title(timestamp.title)(timestamp.label)
          : null,
      ),
      span.class('kikx-frame__secondary')(frameSecondaryLabel(frame)),
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

  _cleanupReactiveBindings(root = this) {
    let nodes = [ root, ...root.querySelectorAll('*') ];
    for (let node of nodes) {
      if (!Array.isArray(node.__bindings))
        continue;

      for (let cleanup of node.__bindings)
        cleanup?.();

      node.__bindings = [];
    }
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-frame-item'))
  customElements.define('kikx-frame-item', KikxFrameItem);
