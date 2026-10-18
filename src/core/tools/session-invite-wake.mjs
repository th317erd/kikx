'use strict';

// A newly invited agent should not sit invisible until someone remembers to
// mention it. The invite itself is a wake signal: the frame is hidden (it is
// coordination, not chat) and targetAgentID bypasses the normal coordinator
// routing so that exact agent starts a turn with the session context.

export function inviteWakeText({ session, agent, inviter } = {}) {
  let title = session?.title || session?.id || 'this session';
  let agentName = agent?.name || agent?.id || 'there';
  let inviterName = inviter?.name || inviter?.id || 'the coordinator';

  return `You have been invited to "${title}" by ${inviterName}. ${agentName}, review the session context now and wait for the coordinator's assignment before changing files.`;
}

export async function wakeInvitedAgent(runtime, {
  sessionID,
  session = null,
  agent = null,
  inviter = null,
} = {}) {
  if (!runtime || typeof runtime.wakeAgentInSession !== 'function' || !sessionID || !agent?.id)
    return null;

  return await runtime.wakeAgentInSession(sessionID, {
    agentID: agent.id,
    agentName: agent.name || agent.id,
    text: inviteWakeText({ session, agent, inviter }),
  });
}
