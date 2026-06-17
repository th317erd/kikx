'use strict';

import { elements, $ } from '../lib/aeor-ui.mjs';
import { renderMarkdownToElement } from '../lib/markdown-renderer.mjs';
import {
  frameDisplayLabel,
  frameSecondaryLabel,
  frameTimestamp,
} from './frame-labels.mjs';
import { resolveFrameComponentDescriptor } from './frame-component-registry.mjs';
import './kikx-typing-indicator.mjs';

const { div, p, span, strong, time } = elements;

export class KikxFrameItem extends HTMLElement {
  constructor() {
    super();
    this._frame = null;
    this._appState = null;
  }

  updateFrame(frame, appState = {}, options = {}) {
    if (options.force !== true && this._frame === frame && this._appState === appState)
      return;

    this._frame = frame || null;
    this._appState = appState || {};
    this._render();
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

    this._cleanupReactiveBindings();
    $(this).empty();
    this.className = `kikx-frame kikx-frame--${frame.type}`;
    this.setAttribute('role', 'listitem');
    this.dataset.frameId = frame.id || '';
    this.dataset.frameType = frame.type || '';

    if (frame.type === 'BeginTyping') {
      this.appendChild(this._buildTypingIndicator(frame));
      return;
    }

    this.append(
      this._buildFrameMeta(frame),
      this._buildFrameContent(frame),
    );
  }

  _buildTypingIndicator(frame) {
    let indicator = document.createElement('kikx-typing-indicator');
    indicator.agentName = frame.content?.agentName || frame.authorDisplayName || frame.authorID || 'Agent';
    indicator.thinkingText = frame.content?.thinkingText || frame.content?.text || '';
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
    let customContent = this._buildCustomFrameContent(frame);
    if (customContent)
      return customContent;

    if (frame.type === 'AgentMessageDelta')
      return div.class('kikx-frame__content kikx-frame__stream')(frame.content?.text || frame.content?.delta || '').build(document);

    if (frame.type === 'AgentThinking')
      return p.class('kikx-frame__thinking')(frame.content?.text || '').build(document);

    if (frame.type === 'AgentMessage') {
      if (frame.content?.status === 'streaming')
        return div.class('kikx-frame__content kikx-frame__stream')(frame.content?.text || frame.contentText || '').build(document);

      return renderMarkdownToElement(document, frame.content?.text || frame.contentText || '', {
        className: 'kikx-frame__content kikx-markdown',
      });
    }

    return p(frame.content?.text || frame.contentText || frame.id || '').build(document);
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
