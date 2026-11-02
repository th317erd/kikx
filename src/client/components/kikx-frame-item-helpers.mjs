'use strict';

// Pure frame-item helpers: identity, content descriptors, header status, and
// search-highlight visibility. Kept separate so the custom-element controller
// stays under the hard source cap.

import { isCoordinationWakeFrame } from '../../shared/coordination-visibility.mjs';
import { elements } from '../lib/aeor-ui.mjs';
import { setIcon } from '../lib/icons.mjs';
import { resolveFrameComponentDescriptor } from './frame-component-registry.mjs';
import { sessionReferenceFromFrame } from './kikx-sub-session-frame.mjs';
import { compactFrameHeader } from './tool-frame-summary.mjs';

const { div, span } = elements;

export const MINIMIZED_EXCEPTIONS = new Set([
  'read-file',
  'write-file',
  'web-search',
  'web-fetch',
]);

export function isToolFrame(frame) {
  if (!frame?.type)
    return false;
  return frame.type === 'ToolCall'
    || frame.type === 'ToolResult'
    || /ToolFrame$/.test(frame.type);
}

// Browsers expose element.tagName in UPPERCASE and element.localName in
// lowercase, while descriptors/specs use lowercase names. Normalize once so
// the reuse checks cannot drift apart.
export function normalizeTagName(name) {
  return String(name ?? '').toLowerCase();
}

export function hasTagName(element, expected) {
  if (!element)
    return false;
  return normalizeTagName(element.localName || element.tagName) === normalizeTagName(expected);
}

export function visibleSearchHighlightCount(root) {
  let count = 0;
  for (let mark of root?.querySelectorAll?.('mark.kikx-search-highlight') || []) {
    // A summary is visible even when its parent <details> is closed. Any other
    // mark inside a closed disclosure is hidden and must not suppress the
    // "Match inside" explanation.
    if (!mark.closest?.('summary') && mark.closest?.('details:not([open])'))
      continue;
    count++;
  }
  return count;
}

// The runtime replaces frame objects on every event, so object identity is not
// a stable key. Type + id identifies the logical frame and decides whether the
// item may be reconciled in place.
export function frameKey(frame) {
  if (!frame)
    return null;
  return `${frame.type ?? ''}\u0000${frame.id ?? ''}`;
}

export function streamText(frame) {
  return frame.content?.text || frame.content?.delta || '';
}

export function thinkingText(frame) {
  return frame.content?.text || '';
}

export function plainText(frame) {
  return frame.content?.text || frame.contentText || '';
}

export function markdownText(frame) {
  return frame.content?.text || frame.contentText || '';
}

export function typingAgentName(frame) {
  return frame.content?.agentName || frame.authorDisplayName || frame.authorID || 'Agent';
}

export function typingThinkingText(frame) {
  return frame.content?.thinkingText || frame.content?.text || '';
}

// Describes the content subtree so reconciliation can tell when it may be
// reused (same kind + tag) versus replaced.
export function frameContentDescriptor(frame, appState) {
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

export function setTextIfChanged(node, next) {
  let value = next ?? '';
  if (node.textContent !== value)
    node.textContent = value;
}

export function frameDebugClass(frame) {
  return frame?.type ? `kikx-frame--${frame.type}` : '';
}

// A plugin that registers a frame component may also declare how its frame type
// should be labelled in the header: `{ label, icon }` on the descriptor that
// registerFrameComponent() accepted. normalizeComponentDescriptor() spreads the
// input, so those fields survive registration -- but nothing read them for
// frames, even though the same fields are honoured for sidebar, settings-panel
// and topbar surfaces. A transport plugin could therefore ship a working
// renderer and still have its collapsed frame call itself by its raw type name
// ("DiscordFrame") in a chip with no author and no body.
function declaredFrameHeaderStatus(frame, state) {
  let type = frame?.type;
  if (typeof type !== 'string' || type === '')
    return null;

  let descriptor = state?.clientFrameComponentsByType?.[type];
  if (!descriptor)
    return null;

  let label = typeof descriptor.label === 'string' ? descriptor.label.trim() : '';
  if (label === '')
    return null;

  // Only the icon is allowed to be decorative. A missing label means the plugin
  // did not declare one, and a guess would be worse than the type name.
  let icon = typeof descriptor.icon === 'string' && descriptor.icon.trim() !== ''
    ? descriptor.icon.trim()
    : 'diamond';

  return { label, icon };
}

export function frameHeaderStatus(frame, compact, state = {}) {
  // Built-ins first, in BOTH modes: a plugin must not be able to relabel the
  // owner's own turn or an agent's reply, because the mood word there is
  // different information. This check has to run before the descriptor lookup in
  // the compact path too -- hoisting the lookup above it was a real regression,
  // caught by the negative-control spec rather than reasoned about.
  let isMessage = frame?.type === 'AgentMessage'
    || frame?.type === 'AgentMessageDelta'
    || frame?.type === 'AgentProgress'
    || frame?.type === 'UserMessage';

  if (compact) {
    // Compact mode has deliberately more specific wording for tool frames (a
    // shell command's focus word, todo verbs, file names). A descriptor may only
    // step in where that path would otherwise fall back to a raw type name --
    // which is the exact failure the descriptor path exists to prevent, and it
    // used to apply to compact mode as well.
    if (isMessage || isToolFrame(frame))
      return compactFrameHeader(frame);
    return declaredFrameHeaderStatus(frame, state) ?? compactFrameHeader(frame);
  }

  if (!isMessage)
    return declaredFrameHeaderStatus(frame, state);

  let moodWord = typeof frame?.content?.moodWord === 'string' ? frame.content.moodWord.trim() : '';
  return { label: moodWord || 'Message', icon: 'chat' };
}

export function renderHeaderStatusLabel(label, data = {}) {
  label.textContent = '';
  if (data.code === true) {
    let code = document.createElement('code');
    code.textContent = data.label || '';
    label.appendChild(code);
    return;
  }

  label.textContent = data.label || '';
}

export function buildHeaderStatus(frame, compact, state = {}) {
  let data = frameHeaderStatus(frame, compact, state);
  if (!data)
    return null;

  let label = span.class('kikx-frame__meta-status-label').build(document);
  renderHeaderStatusLabel(label, data);
  let icon = span.class('kikx-frame__compact-icon').build(document);
  icon.setAttribute('aria-hidden', 'true');
  setIcon(icon, data.icon, { ownerDocument: document });

  return div.class('kikx-frame__meta-status')(label, icon).build(document);
}
