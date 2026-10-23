'use strict';

export async function suspendSessionAgents({ sessionID, target = null, frameRuntime, agentManager, processManager } = {}) {
  if (!sessionID)
    throw new TypeError('sessionID is required');

  if (!frameRuntime?.cancelAgentRuns)
    throw new Error('Agent cancellation requires a frame runtime');

  let reference = typeof target === 'string' ? target.trim() : '';
  let targetAgentID = null;
  if (reference !== '') {
    if (!agentManager?.resolveAgent)
      throw new Error('Targeted cancellation requires an agent manager');
    let agent = await agentManager.resolveAgent(reference);
    targetAgentID = agent?.id || null;
  }

  let entry = typeof frameRuntime.requireSessionEntry === 'function'
    ? frameRuntime.requireSessionEntry(sessionID)
    : await frameRuntime.ensureSessionEntry?.(sessionID, { loadFrames: false });
  let participantAgentIDs = Array.isArray(entry?.session?.participantAgentIDs)
    ? entry.session.participantAgentIDs
    : [];
  let suspendedAgentIDs = targetAgentID ? [ targetAgentID ] : participantAgentIDs;
  frameRuntime.suspendSession?.(sessionID, {
    agentIDs: suspendedAgentIDs,
    coordinatorAgentID: entry?.session?.coordinatorAgentID || null,
    userID: null,
    reason: 'user-suspend',
  });

  let cancelledAgentIDs = frameRuntime.cancelAgentRuns(sessionID, targetAgentID) || [];
  let suspendedCommandIDs = await processManager?.suspendSession?.(sessionID, {
    agentID: targetAgentID || null,
  }) || [];
  let suspensionFrame = await appendSuspensionNotice({
    frameRuntime,
    sessionID,
    target: reference || null,
    targetAgentID,
    cancelledAgentIDs,
    suspendedAgentIDs,
    suspendedCommandIDs,
  });

  return {
    cancelledAgentIDs,
    count: cancelledAgentIDs.length,
    suspendedAgentIDs: suspendedAgentIDs,
    suspendedCommandIDs,
    targetAgentID,
    target: reference || null,
    suspensionFrameID: suspensionFrame?.id || null,
  };
}

async function appendSuspensionNotice({ frameRuntime, sessionID, target, targetAgentID, cancelledAgentIDs, suspendedAgentIDs = [], suspendedCommandIDs = [] }) {
  let entry = typeof frameRuntime.requireSessionEntry === 'function'
    ? frameRuntime.requireSessionEntry(sessionID)
    : await frameRuntime.ensureSessionEntry?.(sessionID, { loadFrames: false });
  let engine = entry?.frameEngine;
  if (!engine?.merge || typeof engine.idGenerator !== 'function')
    return null;

  let now = Date.now();
  let frame = {
    id: engine.idGenerator(),
    type: 'AgentMessage',
    sessionID,
    interactionID: null,
    parentID: null,
    authorType: 'system',
    authorID: 'internal:user-suspend',
    authorDisplayName: 'System',
    timestamp: now,
    createdAt: now,
    updatedAt: now,
    hidden: false,
    deleted: false,
    content: {
      text: target
        ? `User Suspended ${target}\n\nThe user requested cancellation for this agent. ${process.platform === 'win32' ? 'Its in-flight commands were aborted' : 'Its in-flight commands are paused'} and it will remain suspended until the coordinator resumes it.`
        : `User Suspended the Session\n\nYou just suspended the session. All bots except the coordinator remain asleep until you decide what happens next. ${process.platform === 'win32' ? 'All in-flight commands were aborted.' : 'All in-flight commands are paused and remain suspended.'} The coordinator can still be interacted with and can help you recover.\n\nTell your coordinator what is wrong and what you want to have happen next. This session remains suspended until you instruct the coordinator how to resume it.`,
      status: 'error',
      kind: 'session-suspend',
      suspendedAgentIDs: suspendedAgentIDs,
      suspendedCommandIDs,
      coordinatorAgentID: entry?.session?.coordinatorAgentID || null,
      reason: 'user-suspend',
      commandsAborted: process.platform === 'win32',
      target: target || null,
      targetAgentID: targetAgentID || null,
    },
  };

  // A system-authored AgentMessage is visible in the transcript but is not
  // routed back into the agent graph (the router only routes agent-authored
  // AgentMessages). It is silent so this notice cannot wake another turn.
  engine.merge([ frame ], {
    authorType: 'system',
    authorID: 'internal:user-suspend',
    silent: true,
  });
  await frameRuntime.frameStore?.flush?.();
  await frameRuntime.persistSessionSuspension?.(sessionID);
  return frame;
}
