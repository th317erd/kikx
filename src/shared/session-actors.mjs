'use strict';

// Per-session actor scope. Agents and teams are assigned to a session, and a
// child sees its own assignments plus every ancestor's assignments. This is the
// same ownership direction as src/shared/session-ancestry.mjs: a parent never
// inherits from a child, and siblings never share.

import { ancestryChain, normalizeSessionID } from './session-ancestry.mjs';

function uniqueStrings(values) {
  let seen = new Set();
  let output = [];
  for (let value of Array.isArray(values) ? values : []) {
    let id = normalizeSessionID(value);
    if (!id || seen.has(id))
      continue;
    seen.add(id);
    output.push(id);
  }
  return output;
}

export function effectiveSessionAgentIDs(sessionID, getSession) {
  let chain = ancestryChain(sessionID, getSession);
  let ids = [];
  // Own assignment first, then inherited assignments. Callers that need
  // stable ordering can use the array as returned; set membership is what the
  // permission checks care about.
  for (let id of chain) {
    let session = typeof getSession === 'function' ? getSession(id) : null;
    ids.push(...(Array.isArray(session?.participantAgentIDs) ? session.participantAgentIDs : []));
  }
  return uniqueStrings(ids);
}

export function effectiveSessionTeamIDs(sessionID, getSession) {
  let chain = ancestryChain(sessionID, getSession);
  let ids = [];
  for (let id of chain) {
    let session = typeof getSession === 'function' ? getSession(id) : null;
    ids.push(...(Array.isArray(session?.teamIDs) ? session.teamIDs : []));
  }
  return uniqueStrings(ids);
}
