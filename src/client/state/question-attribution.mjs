'use strict';

// Human-readable attribution for a question: which agent asked it, and in which
// session.
//
// Both surfaces used to print the raw ids — `99129d53-e678-4b3c-9b27-… ·
// cb551b14-5d2e-405d-99eb-…` — on the reasoning that a card with no lookup must
// never invent a prettified label. The reasoning was sound but the result was a
// row headed by two UUIDs, which the owner read as: "These ids do not help
// anyone at all... can you please maybe have a 'title' or 'short form'".
//
// The lookup does exist; it was simply never handed to the renderer. Both maps
// are populated by the same bootstrap responses that fill the rest of the shell:
//
//   state.agentDetailsByID[agentID]     -> { id, name, pluginID, ... }
//   state.sessionDetailsByID[sessionID] -> { id, title, ... }
//
// A missing entry is a real state, not an error: an agent can be disabled or
// deleted, and a question outlives the session that asked it. In that case this
// module degrades to the first segment of the id — still unambiguous, no longer
// most of the row — rather than guessing at a name it does not have.

// Long enough to stay distinct between ids that share a prefix, short enough to
// read as a token rather than as a wall of hex.
const SHORT_ID_LENGTH = 8;

const UNATTRIBUTED = 'Unattributed question';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function trimmed(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

// An id shortened for display.
//
// This truncates the WHOLE id rather than cutting at the first hyphen. Splitting
// on `-` looked equivalent for UUIDs — whose first group is already 8 characters
// — but collapsed every non-UUID id onto its shared prefix: `agent-1` and
// `agent-2` both became `agent`, so two different askers rendered the same
// label. A plain slice keeps them distinct and leaves short ids (`zav`, `ses_1`)
// untouched.
function shortID(id) {
  let text = trimmed(id);
  if (text === '')
    return '';

  return text.length > SHORT_ID_LENGTH ? text.slice(0, SHORT_ID_LENGTH) : text;
}

function agentDetails(state, agentID) {
  let map = asObject(asObject(state)?.agentDetailsByID);
  let details = map && agentID ? asObject(map[agentID]) : null;
  return details;
}

function sessionDetails(state, sessionID) {
  let map = asObject(asObject(state)?.sessionDetailsByID);
  let details = map && sessionID ? asObject(map[sessionID]) : null;
  return details;
}

function agentLabel(state, agentID) {
  let id = trimmed(agentID);
  if (id === '')
    return '';

  let name = trimmed(agentDetails(state, id)?.name);
  if (name !== '')
    return name;

  // No known name: say what kind of thing this is, then the short id. Bare hex
  // is what the owner objected to; "Agent 99129d53" at least tells them which
  // half of the pair is missing its name.
  let short = shortID(id);
  return short === '' ? 'Agent' : `Agent ${short}`;
}

function sessionLabel(state, sessionID) {
  let id = trimmed(sessionID);
  if (id === '')
    return '';

  let title = trimmed(sessionDetails(state, id)?.title);
  if (title !== '')
    return title;

  let short = shortID(id);
  return short === '' ? 'Session' : `Session ${short}`;
}

/**
 * Resolve a question's asking agent and session to display labels.
 *
 * Returns `{ agent, session, text }`. `agent` and `session` are '' when the
 * question carries no such id — a question written without a session, which
 * happens for questions asked outside a thread. `text` is the joined form both
 * surfaces render, and is `UNATTRIBUTED` when neither id is present (the same
 * string the card used before, so a call site that only wants one string keeps
 * working).
 *
 * `state` is the kikx state object (`app._state`), not the app itself: this
 * module is pure and must stay callable from a spec with a bare object.
 */
export function describeQuestionOrigin(state, question) {
  let agentID = trimmed(question?.agentID);
  let sessionID = trimmed(question?.sessionID);

  let agent = agentLabel(state, agentID);
  let session = sessionLabel(state, sessionID);

  let parts = [];
  if (agent !== '')
    parts.push(agent);
  if (session !== '')
    parts.push(session);

  return {
    agent,
    session,
    text: parts.length === 0 ? UNATTRIBUTED : parts.join(' \u00b7 '),
  };
}

export const QUESTION_UNATTRIBUTED_TEXT = UNATTRIBUTED;
