'use strict';

export function normalizeProviderContent(output, existingResponseFrame) {
  let content = {
    ...(output.content || {}),
  };

  if (output.phantom || output.type !== 'AgentMessage')
    return content;

  let existingThinking = existingResponseFrame?.content?.thinking || {};
  content.status = content.status || 'complete';
  content.thinking = {
    ...existingThinking,
    ...(content.thinking || {}),
    status: content.thinking?.status || 'complete',
  };

  return content;
}

export function normalizeClosingFrame(frame, { now }) {
  if (!isClosingAgentMessageFrame(frame))
    return frame;

  return {
    ...frame,
    state: {
      ...(frame.state || {}),
      lifecycle: {
        ...(frame.state?.lifecycle || {}),
        status: 'closed',
        closedAt: frame.state?.lifecycle?.closedAt || now,
        reason: frame.content?.status || 'complete',
      },
    },
  };
}

export function createMessageDoneFrame({ agent, frame, responseFrameID, responseFrame, now }) {
  return {
    id: `${responseFrameID}:done`,
    type: 'MessageDone',
    sessionID: frame.sessionID,
    interactionID: frame.interactionID,
    parentID: responseFrameID,
    authorType: 'agent',
    authorID: agent.id,
    authorDisplayName: agent.name || agent.id,
    timestamp: now,
    createdAt: now,
    updatedAt: now,
    hidden: true,
    deleted: false,
    content: {
      frameID: responseFrameID,
      frameType: responseFrame?.type || 'AgentMessage',
      status: responseFrame?.content?.status || 'complete',
      agentID: agent.id,
      agentName: agent.name || agent.id,
      text: '',
    },
    state: {
      lifecycle: {
        status: 'closed',
        closedAt: now,
        reason: responseFrame?.content?.status || 'complete',
      },
    },
  };
}

export function isClosingAgentMessageFrame(frame) {
  return frame?.phantom !== true
    && frame?.type === 'AgentMessage'
    && frame.content?.status === 'complete';
}

export function isClosedFrame(frame) {
  return frame?.state?.lifecycle?.status === 'closed'
    || frame?.content?.status === 'complete';
}

export function shouldSuppressBlankAgentMessage(output, content = {}) {
  if (output?.phantom || output?.type !== 'AgentMessage')
    return false;

  return !hasVisibleText(content.text)
    && !hasVisibleText(content.html)
    && !hasVisibleText(content.markdown);
}

function hasVisibleText(value) {
  return typeof value === 'string' && value.trim() !== '';
}
