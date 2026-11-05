'use strict';

// Content build/reconcile for <kikx-frame-item>, extracted from
// kikx-frame-item.mjs so it stays under the 800-line hard cap. Each function
// takes the owning element as `item` and mutates exactly the fields the class
// methods did (_contentElement, _contentKind, _contentTag, _lastMarkdownText,
// _contentParent): a verbatim move, no behavior change.

import { elements, cleanupBindings } from '../lib/aeor-ui.mjs';
import { isMarkdownRawMode, renderMarkdownToElement } from '../lib/markdown-renderer.mjs';
import { resolveFrameComponentDescriptor } from './frame-component-registry.mjs';
import {
  frameContentDescriptor,
  hasTagName,
  markdownText,
  normalizeTagName,
  plainText,
  setTextIfChanged,
  streamText,
  thinkingText,
} from './kikx-frame-item-helpers.mjs';

const { div, p } = elements;

export function reconcileFrameContent(item, frame) {
    let descriptor = frameContentDescriptor(frame, item._appState);
    if (
      !item._contentElement
      || item._contentKind !== descriptor.kind
      || normalizeTagName(item._contentTag) !== normalizeTagName(descriptor.tagName)
    ) {
      replaceContentElement(item, frame);
      return;
    }

    if (descriptor.kind === 'user-message') {
      let child = item._contentElement.firstElementChild;
      if (hasTagName(child, descriptor.tagName)) {
        child.updateFrame(frame, item._appState);
        return;
      }
      replaceContentElement(item, frame);
      return;
    }

    if (descriptor.kind === 'sub-session') {
      let child = item._contentElement.firstElementChild;
      if (hasTagName(child, descriptor.tagName)) {
        child.appState = item._appState;
        child.updateFrame(frame, item._appState);
        return;
      }
      replaceContentElement(item, frame);
      return;
    }

    if (descriptor.kind === 'custom') {
      let child = item._contentElement.firstElementChild;
      if (hasTagName(child, descriptor.tagName)) {
        child.appState = item._appState;
        if (typeof child.updateFrame === 'function')
          child.updateFrame(frame, item._appState);
        else
          child.frame = frame;
        return;
      }
      replaceContentElement(item, frame);
      return;
    }

    if (descriptor.kind === 'stream') {
      setTextIfChanged(item._contentElement, streamText(frame));
      return;
    }

    if (descriptor.kind === 'thinking') {
      setTextIfChanged(item._contentElement, thinkingText(frame));
      return;
    }

    if (descriptor.kind === 'text') {
      setTextIfChanged(item._contentElement, plainText(frame) || frame.id || '');
      return;
    }

    if (descriptor.kind === 'markdown')
      reconcileMarkdown(item, frame);
    if (item._contentElement) {
      item._highlightSearch(item._contentElement);
      item._bindSearchObserver();
    }
  }

function reconcileMarkdown(item, frame) {
    let text = markdownText(frame);
    let raw = isMarkdownRawMode();
    // The mode is part of the cache key (raw and rendered share the TEXT), and
    // the base class must be CLEAN before handing it to the renderer —
    // otherwise a previous raw render's kikx-markdown--source sticks after
    // toggling back (owner, 2026-11-05).
    if (item._lastMarkdownText === text && item._lastMarkdownRaw === raw)
      return;

    let base = String(item._contentElement.className || '').replace(/\s*kikx-markdown--source\b/g, '');
    let rendered = renderMarkdownToElement(document, text, {
      className: base,
    });

    cleanupBindings(item._contentElement);
    while (item._contentElement.firstChild)
      item._contentElement.removeChild(item._contentElement.firstChild);

    for (let child of [ ...rendered.childNodes ])
      item._contentElement.appendChild(child);

    // Children-only move: mirror the wrapper's classes so the source flag
    // lands on the persistent element with the mode.
    item._contentElement.className = rendered.className;
    item._lastMarkdownRaw = raw;
    item._lastMarkdownText = text;
    item._highlightSearch(item._contentElement);
  }

function replaceContentElement(item, frame) {
    item._discardContentElement();
    item._contentElement = buildFrameContent(item, frame);
    item._contentParent.appendChild(item._contentElement);
    item._highlightSearch(item._contentElement);
    item._bindSearchObserver();
    // A replacement tree may carry disclosures the discarded one did not.
    item._syncQuickActionsToTree();
  }

export function buildFrameContent(item, frame) {
    let descriptor = frameContentDescriptor(frame, item._appState);
    item._contentKind = descriptor.kind;
    item._contentTag = descriptor.tagName;

    if (descriptor.kind === 'coordination') {
      let element = document.createElement('kikx-coordination-frame');
      element.updateFrame(frame, item._appState);
      return div.class('kikx-frame__content kikx-frame__content--coordination')(element).build(document);
    }

    if (descriptor.kind === 'user-message') {
      let element = document.createElement('kikx-user-message-frame');
      element.updateFrame(frame, item._appState);
      return div.class('kikx-frame__content kikx-frame__content--user-message')(element).build(document);
    }

    if (descriptor.kind === 'sub-session')
      return buildSubSessionCard(item, frame);

    if (descriptor.kind === 'custom')
      return buildCustomFrameContent(item, frame);

    if (descriptor.kind === 'stream')
      return div.class('kikx-frame__content kikx-frame__stream')(streamText(frame)).build(document);

    if (descriptor.kind === 'thinking')
      return p.class('kikx-frame__thinking')(thinkingText(frame)).build(document);

    if (descriptor.kind === 'markdown') {
      item._lastMarkdownText = markdownText(frame);
      item._lastMarkdownRaw = isMarkdownRawMode();
      return renderMarkdownToElement(document, markdownText(frame), {
        className: 'kikx-frame__content kikx-markdown',
      });
    }

    return p(plainText(frame) || frame.id || '').build(document);
  }

function buildSubSessionCard(item, frame) {
    let element = document.createElement('kikx-sub-session-frame');
    element.appState = item._appState;
    element.updateFrame(frame, item._appState);
    return div.class('kikx-frame__content kikx-frame__content--sub-session')(element).build(document);
  }

function buildCustomFrameContent(item, frame) {
    let descriptor = resolveFrameComponentDescriptor(frame, item._appState);
    if (!descriptor?.tagName)
      return null;

    let element = document.createElement(descriptor.tagName);
    element.appState = item._appState;
    if (typeof element.updateFrame === 'function')
      element.updateFrame(frame, item._appState);
    else
      element.frame = frame;

    return div.class('kikx-frame__content kikx-frame__content--custom')(element).build(document);
  }
