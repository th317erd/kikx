'use strict';

export function frameDisplayLabel(frame, state = {}) {
  if (!frame)
    return 'Frame';

  if (isAgentAuthoredFrame(frame)) {
    return firstNonEmpty(
      frame.authorDisplayName,
      state.agentDetailsByID?.[frame.authorID]?.name,
      frame.content?.agentName,
      frame.authorID,
      'Agent',
    );
  }

  return firstNonEmpty(frame.authorDisplayName, frame.type, 'Frame');
}

export function frameSecondaryLabel(frame) {
  if (!frame)
    return 'system';

  if (isAgentAuthoredFrame(frame))
    return firstNonEmpty(frame.type, frame.authorID, 'agent');

  return firstNonEmpty(frame.authorID, frame.authorType, 'system');
}

function isAgentAuthoredFrame(frame) {
  return frame?.authorType === 'agent'
    || frame?.type === 'AgentMessage'
    || frame?.type === 'AgentMessageDelta'
    || frame?.type === 'AgentThinking'
    || frame?.type === 'AgentError'
    || frame?.type === 'BeginTyping'
    || frame?.type === 'EndTyping';
}

function firstNonEmpty(...values) {
  for (let value of values) {
    if (typeof value === 'string' && value.trim() !== '')
      return value.trim();
  }

  return '';
}
