'use strict';

// Revising a default answer after the fact.
//
// WHY THIS EXISTS
//
// An agent may ask with `defaultAnswer` + `timeoutSeconds`. When the deadline
// passes, the default is applied and the agent is woken with
// "No answer arrived in time, so the default you specified was applied". That
// is a real answer in every other respect: it is stored, it is delivered, and
// the question is terminal.
//
// What was missing is the user's right to disagree afterwards. Until now the
// answer box simply disappeared, and any POST against the question was a 409
// from `assertOpen`. So a default that fired while the user was away was the
// last word, even when the person it spoke for was right there and had a
// different answer.
//
// THE ONE RULE
//
// A revision is permitted only while the stored answer is still `default`
// provenance. Once a person has answered — by revising a default, or by
// answering before the deadline — the record is terminal again and this path
// refuses. That is deliberately narrower than "let terminal questions be
// edited", because `assertOpen` protects real invariants elsewhere: a
// double-click, a retried request, two concurrent POSTs. Loosening it globally
// to serve this one affordance would let any of those silently rewrite a
// human's answer. The gate here is on the DATA, not on a flag a caller passes,
// so a caller cannot opt in without first forging a default provenance.
//
// WHAT IS PRESERVED
//
// The delivered default is copied to `supersededDefaultAnswer` rather than
// overwritten. The agent was already told "declined to say"; a doc that just
// says "the answer is X" would erase the fact that a correction happened, and
// the wake path needs that fact to label the correction as a correction.
//
// `answeredAt` keeps its original value on purpose: the question WAS answered,
// at that time, by the default. `revisedAt` records when a person took it over.
// Both facts are true and a single timestamp cannot hold both.

import {
  DEFAULT_ANSWER_SOURCE,
  USER_ANSWER_SOURCE,
  normalizeAnswerText,
  normalizeOptionalString,
} from './question-fields.mjs';
import { normalizeRequiredString } from './question-doc.mjs';

/**
 * Is this question sitting on an answer that only a default supplied?
 *
 * Exported because three callers need the same answer and must not each
 * re-derive it: the revision write, the route that decides whether to accept a
 * second POST, and the client deciding whether to render an editable box or a
 * closed receipt.
 */
export function isRevisableDefaultAnswer(question) {
  return question?.deleted !== true
    && question?.status === 'answered'
    && question?.answerSource === DEFAULT_ANSWER_SOURCE;
}

/**
 * Replace a fired default with the user's actual answer.
 *
 * Returns `{ revised: false, reason, question }` for every state that is not a
 * revisable default — that is an ordinary "too late" outcome, not an error, the
 * same way `applyDefaultAnswer` treats "the user got there first". It only
 * throws for genuinely malformed input or a missing question.
 *
 * The lock is taken on the store's own per-question mutex, so a revision cannot
 * interleave with the deadline plugin applying a default or with a concurrent
 * answer. Re-reading INSIDE the lock is what makes that true; a check before
 * acquiring it would race.
 */
export async function reviseAnswer(store, questionID, input = {}) {
  let id = normalizeRequiredString(questionID, 'questionID');
  let answer = normalizeAnswerText(input.answer);

  return await store.withLock(id, async () => {
    let question = await store.getQuestion(id);

    if (!isRevisableDefaultAnswer(question))
      return { revised: false, reason: `not-a-default:${question.status}:${question.answerSource ?? 'null'}`, question };

    let now = Number(input.now ?? store.clock());
    let revised = {
      ...question,
      status: 'answered',
      answer,
      answerSource: USER_ANSWER_SOURCE,
      answeredByUserID: normalizeOptionalString(input.userID || input.user_id) || null,
      answerFrameID: normalizeOptionalString(input.answerFrameID || input.answer_frame_id) || null,
      // The record that a default was delivered, kept rather than overwritten.
      supersededDefaultAnswer: question.answer,
      supersededDefaultAt: question.answeredByDefaultAt ?? question.answeredAt ?? null,
      revisedAt: now,
      // A person answered, so this can never be a suppressed non-response and
      // must not inherit a dismissal marker from anywhere.
      wakeSuppressed: false,
      updatedAt: now,
    };

    await store.aeordb.putFile(store.questionPath(id), revised);
    await store.writeIndexes([ id ], [ question.agentID ]);

    return { revised: true, question: revised };
  });
}

export default reviseAnswer;
