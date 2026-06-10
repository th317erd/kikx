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

export function frameTimestamp(frame, options = {}) {
  let source = normalizeTimestamp(firstTimestampValue(
    frame?.createdAt,
    frame?.timestamp,
    frame?.updatedAt,
  ));
  if (!source)
    return null;

  let label = formatTimestampLabel(source.date, options);
  return {
    label,
    title: source.dateTime,
    dateTime: source.dateTime,
  };
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

function firstTimestampValue(...values) {
  for (let value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0)
      return value;

    if (typeof value === 'string' && value.trim() !== '') {
      let number = Number(value);
      if (Number.isFinite(number) && number > 0)
        return number;
    }
  }

  return null;
}

function normalizeTimestamp(value) {
  if (value == null)
    return null;

  let microsecondInput = value >= 100_000_000_000_000;
  let microseconds = microsecondInput ? Math.trunc(value) : null;
  let milliseconds = microsecondInput ? Math.floor(microseconds / 1000) : Math.trunc(value);
  let date = new Date(milliseconds);
  if (Number.isNaN(date.getTime()))
    return null;

  return {
    date,
    dateTime: microsecondInput ? microsecondISOString(date, microseconds) : date.toISOString(),
  };
}

function microsecondISOString(date, microseconds) {
  let iso = date.toISOString();
  let prefix = iso.slice(0, 19);
  let millisecondPart = Math.floor((microseconds % 1_000_000) / 1000);
  let microsecondPart = microseconds % 1000;
  return `${prefix}.${String(millisecondPart).padStart(3, '0')}${String(microsecondPart).padStart(3, '0')}Z`;
}

function formatTimestampLabel(date, options = {}) {
  let formatter = new Intl.DateTimeFormat(options.locale || undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  });

  return formatter.format(date);
}
