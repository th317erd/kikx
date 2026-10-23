'use strict';

import crypto from 'node:crypto';

/**
 * Duplicate-question prevention.
 *
 * The problem this solves: an agent that cannot see what it already asked will
 * happily ask again — after a compaction, after a restart, or when a batch was
 * only partially answered. `ask-user` used to have no way to look, so the only
 * defence was the agent remembering, which is precisely what a fresh or
 * compacted turn cannot do.
 *
 * The mechanism is optimistic concurrency, the same shape `write-file` uses for
 * content hashes: the read tool (`question-list`) returns a digest of the set
 * the agent is allowed to see, and `ask-user` refuses to write unless the agent
 * presents that exact digest. A matching digest proves the agent's view of the
 * pending set was current at ask time.
 *
 * Two properties are deliberate:
 *
 * 1. The digest is a PURE function of the visible pending questions. It is not
 *    persisted, so there is no new state to keep consistent, no migration, and
 *    no risk of a stale stored digest shadowing reality after a restart. It is
 *    content-addressed, exactly like an ETag.
 *
 * 2. It changes the moment ANY question in scope is added, answered, dismissed,
 *    or times out. That is what makes a replayed digest worthless: an agent that
 *    copies a digest without re-reading fails on its very next ask, so the
 *    "token" cannot degrade into a ritual.
 *
 * Scope is the agent's visible set — its own session plus that session's
 * descendants — never sibling or unrelated sessions. Two reasons: it is the set
 * the user can actually act on, and it keeps both the dump and the hash small
 * instead of growing with global history.
 */

/** Statuses a question can occupy and still be visible in the open index. */
export const VISIBLE_QUESTION_STATUSES = [ 'open' ];

/**
 * Normalise question text for duplicate comparison.
 *
 * Intentionally conservative: case, whitespace runs, surrounding quotes, and
 * trailing terminal punctuation carry no meaning for "did I already ask this".
 * Word order and wording DO carry meaning and are left alone, so a deliberate
 * rephrase is still allowed. Catching semantic duplicates would need embeddings
 * and is out of scope; this catches the retry-loop and post-compaction cases,
 * which are what actually produce visible duplicates.
 */
export function questionTextKey(value) {
  if (typeof value !== 'string')
    return '';

  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'`\u2018\u2019\u201c\u201d]+/, '')
    .replace(/[\s"'`\u2018\u2019\u201c\u201d]+$/, '')
    .replace(/[.?!,;:]+$/, '')
    .trim()
    .toLowerCase();
}

/**
 * Stable canonical projection of the visible pending set.
 *
 * `id` alone would be enough to detect add/remove, but normalised text is
 * included so that a re-ask of an existing question is also a digest change:
 * the agent cannot satisfy the precondition by re-reading a set that shifted
 * underneath it.
 */
export function canonicalVisibleQuestions(summaries = []) {
  let rows = [];

  for (let summary of Array.isArray(summaries) ? summaries : []) {
    if (!summary?.id)
      continue;

    let status = summary.status || 'open';
    if (!VISIBLE_QUESTION_STATUSES.includes(status))
      continue;

    rows.push([
      summary.id,
      status,
      summary.sessionID || '',
      questionTextKey(summary.text),
      String(summary.askedAt ?? ''),
    ].join('\u0000'));
  }

  return rows.sort();
}

/**
 * sha256 over the canonical projection. Empty set hashes too — a defined value
 * is what lets "I looked and there was nothing pending" be a valid, provable
 * state rather than an absent one.
 */
export function visibleQuestionDigest(summaries = []) {
  let canonical = canonicalVisibleQuestions(summaries);
  let payload = canonical.length === 0 ? '' : `${canonical.join('\n')}\n`;

  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * The session plus all of its descendants.
 *
 * A child session is created by an agent working inside a parent, and the user
 * sees both in the same Inbox, so "have I already asked this?" is only
 * answerable over the whole tree. Sibling and unrelated sessions are excluded
 * on purpose: their questions are not visible in the same place, and folding
 * them in would grow both the dump and the hash with history the agent cannot
 * act on.
 *
 * Iterative on purpose — a cycle in corrupted data must not hang the ask path.
 */
export function resolveVisibleSessionIDs(rootSessionID, sessions = []) {
  let root = typeof rootSessionID === 'string' ? rootSessionID.trim() : '';
  if (!root)
    return [];

  let childrenByParent = new Map();

  for (let session of Array.isArray(sessions) ? sessions : []) {
    let id = typeof session?.id === 'string' ? session.id.trim() : '';
    if (!id)
      continue;

    let parent = typeof session.parentSessionID === 'string' ? session.parentSessionID.trim() : '';
    if (!parent)
      continue;

    if (!childrenByParent.has(parent))
      childrenByParent.set(parent, []);

    childrenByParent.get(parent).push(id);
  }

  let visible = new Set([ root ]);
  let queue = [ root ];

  while (queue.length > 0) {
    let current = queue.shift();
    for (let childID of childrenByParent.get(current) || []) {
      if (visible.has(childID))
        continue;

      visible.add(childID);
      queue.push(childID);
    }
  }

  return [ ...visible ];
}

/**
 * Filter open-index summaries down to the sessions the agent may see.
 */
export function selectVisiblePendingQuestions(summaries = [], sessionIDs = []) {
  let allowed = new Set(Array.isArray(sessionIDs) ? sessionIDs : []);

  return (Array.isArray(summaries) ? summaries : []).filter((summary) => {
    if (!summary?.id)
      return false;

    if ((summary.status || 'open') !== 'open')
      return false;

    return allowed.has(summary.sessionID);
  });
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Duplicates of `questions` already present in `summaries`.
 *
 * Returns one entry per offending question, carrying the existing question it
 * collides with so the error can name it. Reporting every collision at once
 * matters: a five-question batch that re-asks two of them should be fixable in
 * one retry, not two.
 */
export function findDuplicateQuestions({ summaries = [], questions = [] } = {}) {
  let seen = new Map();

  for (let summary of Array.isArray(summaries) ? summaries : []) {
    if (!summary?.id)
      continue;

    let key = questionTextKey(summary.text);
    if (!key || seen.has(key))
      continue;

    seen.set(key, summary);
  }

  let duplicates = [];
  let proposed = Array.isArray(questions) ? questions : [];

  for (let [ index, question ] of proposed.entries()) {
    let text = typeof question === 'string' ? question : question?.text;
    let key = questionTextKey(text);
    if (!key)
      continue;

    let existing = seen.get(key);
    if (!existing)
      continue;

    duplicates.push({
      index,
      text: String(text ?? ''),
      existingQuestionID: existing.id,
      existingStatus: existing.status || 'open',
      existingAskedAt: existing.askedAt ?? null,
    });
  }

  return duplicates;
}

/**
 * The look-before-you-write gate.
 *
 * Three failures, each with its own message because the remedy differs. The
 * first is the one that carries the weight: it is what makes `question-list`
 * a step the agent cannot skip.
 */
export function assertAskPrecondition({ sessionID, expectedDigest, actualDigest, duplicates = [] }) {
  let provided = normalizeOptionalDigest(expectedDigest);

  if (!provided) {
    throw new Error(
      'ask-user requires observedQuestionDigest. Call question-list first to see the '
      + 'questions already pending in this session (and its child sessions), then pass '
      + 'the openDigest it returns. This check exists so you do not ask the user '
      + 'something they have already been asked.',
    );
  }

  if (provided !== actualDigest) {
    throw new Error(
      'The pending question set has changed since you listed it. Call question-list '
      + 'again, re-read the questions, and pass the current openDigest before asking.',
    );
  }

  if (duplicates.length > 0) {
    let described = duplicates
      .map((duplicate) => {
        let label = duplicate.existingAskedAt == null ? '' : ` (asked at ${duplicate.existingAskedAt})`;
        return `"${truncate(duplicate.text, 120)}" duplicates existing question ${duplicate.existingQuestionID}${label}`;
      })
      .join('; ');

    throw new Error(
      `ask-user refused: ${described}. That question is already pending in session `
      + `${sessionID}, so the user has already been asked and re-asking would duplicate it. `
      + 'Wait for the existing answer, or ask something materially different.',
    );
  }
}

function normalizeOptionalDigest(value) {
  if (value == null || value === '')
    return null;

  if (typeof value !== 'string')
    throw new TypeError('observedQuestionDigest must be a string');

  let normalized = value.trim().toLowerCase();
  if (!DIGEST_PATTERN.test(normalized))
    throw new TypeError('observedQuestionDigest must be a 64-character sha256 hex digest, as returned by question-list');

  return normalized;
}

function truncate(value, max) {
  let text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
}
