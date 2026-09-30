'use strict';

export function addTouchedFrameIDs(target, sessionID, frameIDs) {
  if (!sessionID || !frameIDs || frameIDs.size === 0)
    return;

  let existing = target.get(sessionID);
  if (!existing) {
    existing = new Set();
    target.set(sessionID, existing);
  }

  for (let frameID of frameIDs)
    existing.add(frameID);
}

export function addFrameToBatch(target, sessionID, frame) {
  if (!sessionID || !frame)
    return;

  let frames = target.get(sessionID);
  if (!frames) {
    frames = [];
    target.set(sessionID, frames);
  }

  frames.push(frame);
}

export function renderedFrameIDsFor(frame) {
  let ids = new Set();
  if (!frame)
    return ids;

  if (typeof frame.id === 'string' && frame.id)
    ids.add(frame.id);

  if (
    frame.phantom === true
    && typeof frame.responseFrameID === 'string'
    && frame.responseFrameID.trim() !== ''
    && (frame.type === 'AgentThinking' || frame.type === 'AgentMessageDelta')
  ) {
    ids.add(frame.responseFrameID.trim());
  }

  if (frame.type === 'BeginTyping' || frame.type === 'EndTyping') {
    let agentID = frame.authorID || frame.content?.agentID || 'default';
    ids.add(`typing:${agentID}`);
  }

  return ids;
}
