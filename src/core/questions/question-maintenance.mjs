'use strict';

import { DEFAULT_ANSWER_SOURCE } from './question-fields.mjs';
import { listDocPaths } from './question-index-repair.mjs';

/**
 * Maintenance for the ask-user lifecycle: delivery retry and agent-specified
 * default answers.
 *
 * Two gaps this closes, both product decisions from the owner:
 *
 * 1. An answer can be persisted and then never delivered — a crash between
 *    persist and deliver, or a delivery failure that lands the question on the
 *    terminal `undeliverable` status. Until now that was final: the user's
 *    answer existed but the asking agent would never see it. Retry is now
 *    automatic, with exponential backoff and a bounded attempt count.
 *
 * 2. An agent can name a default answer up front and a deadline. If the user
 *    does not answer in time, the default is applied so the agent is not
 *    blocked forever on a question nobody answered.
 *
 * Invariants that outrank both features:
 *
 * - A real user answer always wins. If the user answered before the default
 *   fired, the default is discarded silently; if the user answers after a
 *   default was applied, the second answer is rejected by the store's existing
 *   terminal guard (409) rather than silently overwriting the record.
 * - A default never fires on a question that is no longer open.
 * - A default is recorded as a default. `answerSource` says `default` and the
 *   wake text says so, because a model that mistakes a default for a human
 *   instruction is a worse failure than waiting.
 *
 * This lives outside `questions-store.mjs` deliberately: that file is already
 * at its size budget. Everything here goes through the store's public surface,
 * and every mutation takes the store's own per-question mutex.
 */

// Bounded retry: 5 attempts at 30s, 2m, 8m, 32m, 2h. Past that the answer stays
// on `undeliverable` with its reason recorded — visible, never silent — and the
// user can re-answer.
export const DELIVERY_RETRY_DELAYS_MS = [ 30_000, 120_000, 480_000, 1_920_000, 7_200_000 ];

/**
 * Apply an agent-specified default answer because its deadline passed.
 *
 * Returns `{ applied, reason?, question }`. Never throws for the ordinary
 * "the user got there first" case: that is a successful no-op, not an error.
 */
export async function applyDefaultAnswer(store, questionID, options = {}) {
  let now = Number(options.now ?? store.clock());

  return await store.withLock(questionID, async () => {
    let question = await store.getQuestion(questionID);

    if (question.status !== 'open')
      return { applied: false, reason: `not-open:${question.status}`, question };

    if (!question.defaultAnswer)
      return { applied: false, reason: 'no-default', question };

    if (question.defaultDueAt == null || Number(question.defaultDueAt) > now)
      return { applied: false, reason: 'not-due', question };

    let updated = {
      ...question,
      status: 'answered',
      answer: question.defaultAnswer,
      answerSource: DEFAULT_ANSWER_SOURCE,
      answeredAt: question.defaultDueAt,
      answeredByUserID: null,
      answeredByDefaultAt: now,
      updatedAt: now,
    };

    await store.aeordb.putFile(store.questionPath(question.id), updated);
    await store.writeIndexes([ question.id ], [ question.agentID ]);

    return { applied: true, question: updated };
  });
}

/**
 * Record a failed delivery attempt and schedule the next one.
 *
 * The question keeps its `undeliverable` status — that status is what makes the
 * failure visible — and gains retry metadata. Once the schedule is exhausted,
 * `nextDeliveryAt` is cleared so nothing retries forever.
 */
export async function recordDeliveryFailure(store, questionID, options = {}) {
  let now = Number(options.now ?? store.clock());
  let reason = options.reason || 'undeliverable';

  return await store.withLock(questionID, async () => {
    let question = await store.getQuestion(questionID);
    let attempts = Number.isInteger(question.deliveryAttempts) ? question.deliveryAttempts : 0;
    let nextDelay = DELIVERY_RETRY_DELAYS_MS[attempts] ?? null;

    let updated = {
      ...question,
      status: 'undeliverable',
      deliveryAttempts: attempts + 1,
      deliveryFailedAt: now,
      deliveryLastReason: reason,
      nextDeliveryAt: nextDelay == null ? null : now + nextDelay,
      updatedAt: now,
    };

    await store.aeordb.putFile(store.questionPath(question.id), updated);
    await store.writeIndexes([ question.id ], [ question.agentID ]);

    return updated;
  });
}

/**
 * Questions awaiting another delivery attempt, oldest first.
 *
 * These are answered (or defaulted) questions whose wake never landed. Read by
 * scanning the question docs: the open index deliberately holds only open
 * questions, so it cannot answer this question.
 */
export async function findRetryableDeliveries(store, options = {}) {
  let now = Number(options.now ?? store.clock());
  let limit = Number.isInteger(options.limit) ? options.limit : 25;
  let paths = await listCandidatePaths(store);
  let due = [];

  for (let path of paths) {
    if (due.length >= limit)
      break;

    let doc = null;
    try {
      doc = await store.aeordb.getFile(path);
    } catch (_error) {
      continue;
    }

    if (!doc || doc.status !== 'undeliverable')
      continue;

    if (doc.nextDeliveryAt == null || Number(doc.nextDeliveryAt) > now)
      continue;

    let question = null;
    try {
      question = await store.getQuestion(doc.id);
    } catch (_error) {
      continue;
    }

    due.push(question);
  }

  due.sort((left, right) => Number(left.nextDeliveryAt) - Number(right.nextDeliveryAt));
  return due;
}

/**
 * Mark a question answered again after a successful retry, clearing the retry
 * schedule. Admits `undeliverable` because that is the state a retry starts
 * from; every other terminal status still refuses.
 */
export async function markRedelivered(store, questionID, options = {}) {
  let now = Number(options.now ?? store.clock());

  return await store.withLock(questionID, async () => {
    let question = await store.getQuestion(questionID);

    if (question.status !== 'undeliverable')
      return { redelivered: false, reason: `not-undeliverable:${question.status}`, question };

    let updated = {
      ...question,
      status: 'answered',
      deliveryFailureReason: null,
      nextDeliveryAt: null,
      redeliveredAt: now,
      updatedAt: now,
    };

    await store.aeordb.putFile(store.questionPath(question.id), updated);
    await store.writeIndexes([ question.id ], [ question.agentID ]);

    return { redelivered: true, question: updated };
  });
}

async function listCandidatePaths(store) {
  let items = await listDocPaths(store.aeordb, `${store.rootPath}/questions`, { glob: '*.json' });
  return items.map((item) => item.path);
}
