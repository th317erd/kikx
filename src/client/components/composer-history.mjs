'use strict';

export const HISTORY_DIRECTION_UP = 'up';
export const HISTORY_DIRECTION_DOWN = 'down';

export function createComposerHistoryState() {
  return { entries: [], cursor: -1, draft: '' };
}

export function composerHistoryEntriesFromFrames(frames) {
  if (!Array.isArray(frames))
    return [];

  let entries = [];
  for (let frame of frames) {
    if (!frame || frame.authorType !== 'user')
      continue;

    if (frame.hidden === true || frame.deleted === true)
      continue;

    let text = frame.content?.text ?? frame.contentText;
    let normalized = typeof text === 'string' ? text.trim() : '';
    if (normalized)
      entries.push(normalized);
  }

  return entries;
}

export function recordComposerHistoryEntry(history, text) {
  let normalized = typeof text === 'string' ? text.trim() : '';
  if (normalized)
    history.entries.push(normalized);

  resetComposerHistoryNavigation(history);
  return history;
}

export function resetComposerHistoryNavigation(history) {
  history.cursor = -1;
  history.draft = '';
  return history;
}

export function composerHistoryDirectionForKey(event) {
  if (!event || event.isComposing === true)
    return null;

  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')
    return null;

  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey)
    return null;

  return event.key === 'ArrowUp' ? HISTORY_DIRECTION_UP : HISTORY_DIRECTION_DOWN;
}

export function composerCaretAllowsHistory(direction, value, selectionStart) {
  let text = typeof value === 'string' ? value : '';
  let caret = Number.isInteger(selectionStart)
    ? Math.min(Math.max(selectionStart, 0), text.length)
    : text.length;

  if (direction === HISTORY_DIRECTION_UP)
    return text.lastIndexOf('\n', caret - 1) === -1;

  return text.indexOf('\n', caret) === -1;
}

export function navigateComposerHistory(history, direction, currentDraft) {
  let entries = history.entries;

  if (direction === HISTORY_DIRECTION_UP) {
    if (entries.length === 0)
      return { handled: false, value: null };

    if (history.cursor === -1) {
      history.draft = typeof currentDraft === 'string' ? currentDraft : '';
      history.cursor = entries.length - 1;
    } else if (history.cursor > 0) {
      history.cursor -= 1;
    }

    return { handled: true, value: entries[history.cursor] };
  }

  if (direction === HISTORY_DIRECTION_DOWN) {
    if (history.cursor === -1)
      return { handled: false, value: null };

    if (history.cursor < entries.length - 1) {
      history.cursor += 1;
      return { handled: true, value: entries[history.cursor] };
    }

    history.cursor = -1;
    let value = history.draft;
    history.draft = '';
    return { handled: true, value };
  }

  return { handled: false, value: null };
}
