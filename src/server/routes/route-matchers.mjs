'use strict';

export function matchSessionUpdateRoute(pathname) {
  let match = /^\/api\/v1\/sessions\/([^/]+)$/.exec(pathname);
  if (!match)
    return null;

  return {
    sessionID: decodeURIComponent(match[1]),
  };
}

// POST /api/v1/sessions/:id/cancel cancels active agent turns. An optional
// `target` body field resolves an agent id/name; omitted means all active runs.
export function matchSessionCancelRoute(pathname) {
  let match = /^\/api\/v1\/sessions\/([^/]+)\/cancel$/.exec(pathname);
  if (!match)
    return null;

  return {
    sessionID: decodeURIComponent(match[1]),
  };
}

// DELETE /api/v1/sessions/:id soft-deletes a session (stamps deletedAt).
export function matchSessionDeleteRoute(pathname) {
  let match = /^\/api\/v1\/sessions\/([^/]+)$/.exec(pathname);
  if (!match)
    return null;

  return {
    sessionID: decodeURIComponent(match[1]),
  };
}

// POST /api/v1/sessions/:id/restore clears the soft-delete stamp, bringing a
// deleted session back to life (the "show deleted sessions" undo).
export function matchSessionRestoreRoute(pathname) {
  let match = /^\/api\/v1\/sessions\/([^/]+)\/restore$/.exec(pathname);
  if (!match)
    return null;

  return {
    sessionID: decodeURIComponent(match[1]),
  };
}

export function matchSessionRoute(pathname) {
  let match = /^\/api\/v1\/sessions\/([^/]+)\/(frames|messages)$/.exec(pathname);
  if (!match)
    return null;

  return {
    sessionID: decodeURIComponent(match[1]),
    resource: match[2],
  };
}

// POST /api/v1/sessions/:id/compaction/:frameID/retry re-runs compaction for the
// same boundary a prior compaction frame used, overwriting that frame in place.
export function matchSessionCompactionRetryRoute(pathname) {
  let match = /^\/api\/v1\/sessions\/([^/]+)\/compaction\/([^/]+)\/retry$/.exec(pathname);
  if (!match)
    return null;

  return {
    sessionID: decodeURIComponent(match[1]),
    frameID: decodeURIComponent(match[2]),
  };
}

export function matchAgentRoute(pathname) {
  let match = /^\/api\/v1\/agents\/([^/]+)$/.exec(pathname);
  if (!match)
    return null;

  return {
    agentID: decodeURIComponent(match[1]),
  };
}

// POST /api/v1/agents/:id/crown and .../uncrown toggle master-agent status.
export function matchAgentCrownRoute(pathname) {
  let match = /^\/api\/v1\/agents\/([^/]+)\/(crown|uncrown)$/.exec(pathname);
  if (!match)
    return null;

  return {
    agentID: decodeURIComponent(match[1]),
    crowned: match[2] === 'crown',
  };
}

// POST /api/v1/agents/:id/compact-crown and .../compact-uncrown toggle
// compaction-bot designation — the parallel, independent list to the crown.
export function matchAgentCompactionCrownRoute(pathname) {
  let match = /^\/api\/v1\/agents\/([^/]+)\/(compact-crown|compact-uncrown)$/.exec(pathname);
  if (!match)
    return null;

  return {
    agentID: decodeURIComponent(match[1]),
    crowned: match[2] === 'compact-crown',
  };
}

export function matchTeamRoute(pathname) {
  let match = /^\/api\/v1\/teams\/([^/]+)$/.exec(pathname);
  if (!match)
    return null;

  return {
    teamID: decodeURIComponent(match[1]),
  };
}

export function matchTeamMemberRoute(pathname) {
  let membersMatch = /^\/api\/v1\/teams\/([^/]+)\/members$/.exec(pathname);
  if (membersMatch) {
    return {
      teamID: decodeURIComponent(membersMatch[1]),
      resource: 'members',
    };
  }

  let memberMatch = /^\/api\/v1\/teams\/([^/]+)\/members\/([^/]+)$/.exec(pathname);
  if (!memberMatch)
    return null;

  return {
    teamID: decodeURIComponent(memberMatch[1]),
    actorID: decodeURIComponent(memberMatch[2]),
    resource: 'member',
  };
}

export function matchToolOutputRoute(pathname) {
  let match = /^\/api\/v1\/tool-outputs\/([^/]+)$/.exec(pathname);
  if (!match)
    return null;

  return {
    outputID: decodeURIComponent(match[1]),
  };
}

// POST /api/v1/questions/:id/answer stores the answer and wakes the asking
// agent. The question id is a UUID, but any opaque id is accepted here and
// validated by the store.
export function matchQuestionAnswerRoute(pathname) {
  let match = /^\/api\/v1\/questions\/([^/]+)\/answer$/.exec(pathname);
  if (!match)
    return null;

  return {
    questionID: decodeURIComponent(match[1]),
  };
}

// POST /api/v1/questions/:id/read clears the unread badge for one question.
export function matchQuestionReadRoute(pathname) {
  let match = /^\/api\/v1\/questions\/([^/]+)\/read$/.exec(pathname);
  if (!match)
    return null;

  return {
    questionID: decodeURIComponent(match[1]),
  };
}

// POST /api/v1/questions/:id/dismiss lets the asker withdraw an open question.
export function matchQuestionDismissRoute(pathname) {
  let match = /^\/api\/v1\/questions\/([^/]+)\/dismiss$/.exec(pathname);
  if (!match)
    return null;

  return {
    questionID: decodeURIComponent(match[1]),
  };
}

// Composer reverse-search and draft persistence. Drafts are hidden frames in
// the session log, so they survive reloads and follow the user across hosts.
export function matchSessionComposerRoute(pathname) {
  let match = /^\/api\/v1\/sessions\/([^/]+)\/composer\/(history|drafts)$/.exec(pathname);
  if (!match)
    return null;

  return {
    sessionID: decodeURIComponent(match[1]),
    resource: match[2],
  };
}

export function matchSessionComposerDraftRoute(pathname) {
  let match = /^\/api\/v1\/sessions\/([^/]+)\/composer\/drafts\/([^/]+)$/.exec(pathname);
  if (!match)
    return null;

  return {
    sessionID: decodeURIComponent(match[1]),
    draftID: decodeURIComponent(match[2]),
  };
}

export function matchSessionComposerHistoryItemRoute(pathname) {
  let match = /^\/api\/v1\/sessions\/([^/]+)\/composer\/history\/([^/]+)$/.exec(pathname);
  if (!match)
    return null;

  return {
    sessionID: decodeURIComponent(match[1]),
    frameID: decodeURIComponent(match[2]),
  };
}
