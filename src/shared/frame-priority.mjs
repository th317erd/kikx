'use strict';

// Delivery priority for a frame commit. Lower numbers run first. Human and
// agent messages are the conversation; command/tool frames are work that can
// wait behind one another. The numbers are intentionally small but spaced so
// another tier can be inserted later without renumbering.
export const FRAME_PRIORITY = Object.freeze({
  message: 10,
  activity: 20,
  unknown: 25,
  command: 30,
  maintenance: 40,
  hidden: 60,
});

export function framePriority(frameOrType = {}) {
  let frame = frameOrType && typeof frameOrType === 'object'
    ? frameOrType
    : { type: String(frameOrType || '') };
  let type = typeof frame.type === 'string' ? frame.type : '';

  if (frame.hidden === true)
    return FRAME_PRIORITY.hidden;

  if (type === 'UserMessage')
    return frame.authorType === 'user' ? FRAME_PRIORITY.message : FRAME_PRIORITY.command;

  if (type === 'AgentMessage'
    || type === 'Question'
    || type === 'AgentError'
    || type === 'SystemNotice')
    return FRAME_PRIORITY.message;

  if (type === 'AgentProgress'
    || type === 'AgentThinking'
    || type === 'BeginTyping'
    || type === 'EndTyping')
    return FRAME_PRIORITY.activity;

  if (type === 'CompactionFrame'
    || type === 'MessageDone')
    return FRAME_PRIORITY.maintenance;

  if (type === 'ToolCall'
    || type === 'ToolResult'
    || type === 'OcrFrame'
    || type.endsWith('ToolFrame'))
    return FRAME_PRIORITY.command;

  if (type === 'UserDraft')
    return FRAME_PRIORITY.hidden;

  return FRAME_PRIORITY.unknown;
}

// Insert with stable FIFO ordering inside a priority tier. Re-scanning from the
// tail keeps the common case (append, or a high-priority message jumping ahead
// of commands) cheap; the queue is small relative to the frame window.
export function insertByFramePriority(queue, item, { minIndex = 0 } = {}) {
  let index = queue.length;
  while (index > minIndex && framePriorityOrder(queue[index - 1]) > framePriorityOrder(item))
    index--;
  queue.splice(index, 0, item);
  return item;
}

export function framePriorityOrder(item = {}) {
  return Number.isFinite(item.priority) ? item.priority : FRAME_PRIORITY.unknown;
}
