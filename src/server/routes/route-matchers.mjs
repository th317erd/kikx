'use strict';

export function matchSessionUpdateRoute(pathname) {
  let match = /^\/api\/v1\/sessions\/([^/]+)$/.exec(pathname);
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
