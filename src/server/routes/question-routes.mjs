'use strict';

import { cancelQuestionSchedule } from '../../core/questions/question-deadline-schedule.mjs';

import {
  getRequestAccount,
  httpError,
  parseNonNegativeInteger,
  parsePositiveInteger,
  readJSON,
  writeJSON,
} from '../http-helpers.mjs';
import {
  matchQuestionAnswerRoute,
  matchQuestionDismissRoute,
  matchQuestionReadRoute,
} from './route-matchers.mjs';
import {
  NO_RESPONSE_ANSWER_TEXT,
  REVISION_INTENT_CONFIRM,
  normalizeWakeSuppressed,
} from '../../core/questions/question-fields.mjs';

// Ask-user questions: the read side the Inbox renders, plus the answer loop's
// write side. The list route reads the store's open index (`listOpen`) and never
// scans the per-question docs — history must not make the inbox slower.
export async function handleQuestionRoutes({ request, response, url, context }) {
  if (request.method === 'GET' && url.pathname === '/api/v1/questions') {
    let limit = parsePositiveInteger(url.searchParams.get('limit'), 50);
    let offset = parseNonNegativeInteger(url.searchParams.get('offset'), 0);
    let status = url.searchParams.get('status');

    let questionsStore = context.require('questionsStore');
    let sessionID = url.searchParams.get('sessionID');
    let rootSessionID = url.searchParams.get('rootSessionID');
    let includeDescendants = Boolean(rootSessionID)
      || url.searchParams.get('includeDescendants') === '1';
    let open = await questionsStore.listOpen({
      sessionID,
      rootSessionID: includeDescendants ? (rootSessionID || sessionID) : null,
      includeDescendants,
      agentID: url.searchParams.get('agentID'),
      groupID: url.searchParams.get('groupID'),
      query: url.searchParams.get('q') || url.searchParams.get('query'),
      priority: url.searchParams.get('priority'),
    });

    let questions = Array.isArray(open.summaries) ? open.summaries : [];

    // The index only holds `open` questions, so `status` filters the summaries
    // rather than the store: `status=answered` correctly returns nothing instead
    // of implying the index carries history.
    if (status)
      questions = questions.filter((summary) => summary.status === status);

    // Counts describe the matching set, not the page, so they are computed
    // before limit/offset slice it.
    let counts = {
      open: questions.filter((summary) => summary.status === 'open').length,
    };

    writeJSON(response, 200, {
      data: {
        questions: questions.slice(offset, offset + limit),
        counts,
      },
    });
    return true;
  }

  // The answer loop: store the answer, then wake the asking agent. Delivery is
  // best-effort — `delivered: false` still means the answer is durable, which is
  // why a stored-but-undelivered answer stays a 200 rather than an error.
  let answerRoute = matchQuestionAnswerRoute(url.pathname);
  if (request.method === 'POST' && answerRoute) {
    let body = await readJSON(request);

    // `silent: true` is the Inbox "Dismiss" affordance: record the user's
    // non-response as an answer and suppress the wake. The ANSWER TEXT IS NOT
    // TAKEN FROM THE CLIENT in that case — the server writes its own literal, so
    // a stored dismissal can never be forged into arbitrary agent-visible text
    // and can never drift from the value the suppression logic is documented
    // against. A non-boolean `silent` is a client bug, not something to coerce.
    if (body.silent != null && typeof body.silent !== 'boolean')
      throw httpError(400, 'silent must be a boolean');

    let silent = normalizeWakeSuppressed(body.silent);

    // A CONFIRMATION carries no text on purpose: it affirms the default answer
    // the server already holds. It must NOT be waved through to `submitAnswer`
    // though — that would store an empty answer on a question that is still
    // open — so the check is relaxed only far enough to reach the revision path
    // below, which succeeds solely against a `default`-provenance answer.
    let declaringConfirmation = !silent && body.intent === REVISION_INTENT_CONFIRM;

    if (!declaringConfirmation && !silent && (typeof body.answer !== 'string' || body.answer.trim() === ''))
      throw httpError(400, 'answer must be a non-empty string');

    // Identity is optional, matching POST /api/v1/sessions/:id/messages: the
    // answer is attributed when someone is signed in, but a local request
    // without an account is not rejected.
    let account = await getRequestAccount(context, request);
    let answerService = context.require('questionAnswerService');

    // A stored answer is normally terminal: a second POST is a 409. The one
    // exception is an answer that only a DEFAULT supplied — the agent's own
    // fallback fired while the user was away, and the person it spoke for is
    // entitled to replace it with what they actually meant. The gate for that
    // lives in the store (`answerSource === 'default'`), not here, so this
    // branch cannot widen the 409 for a genuine human answer.
    let revise = async () => {
      if (typeof answerService.reviseDefaultAnswer !== 'function' || silent)
        return null;

      return await answerService.reviseDefaultAnswer(answerRoute.questionID, {
        answer: silent ? NO_RESPONSE_ANSWER_TEXT : body.answer,
        // Declared by the client, never inferred from the text: "ok" and
        // "Postgres 16" are both strings, and only the caller knows whether the
        // default was affirmed or corrected. An absent/garbage value normalizes
        // to 'change', the branch that wakes the agent.
        intent: body.intent,
        userID: account?.id || body.userID || null,
      });
    };

    // A confirmation never travels through `submitAnswer`: there is nothing to
    // write until the revision does it, and an open question has no default to
    // affirm.
    if (declaringConfirmation) {
      let confirmed = await revise();

      if (!confirmed?.revised)
        throw httpError(409, 'No delivered default answer to confirm');

      writeJSON(response, 200, {
        data: {
          question: confirmed.question,
          delivered: false,
          pending: false,
          suppressed: false,
          revised: true,
          acknowledged: true,
          frameID: null,
        },
      });
      return true;
    }

    let result;
    try {
      result = await answerService.submitAnswer(answerRoute.questionID, {
        answer: silent ? NO_RESPONSE_ANSWER_TEXT : body.answer,
        userID: account?.id || body.userID || null,
        wakeSuppressed: silent,
      });
    } catch (error) {
      if (error?.status === 409) {
        let revised = await revise();

        // `revised:false` means the question is terminal for a real reason: a
        // person already answered, it was dismissed, or delivery failed. That
        // is the original 409, unchanged.
        if (!revised?.revised)
          throw httpError(409, 'Question already answered');

        writeJSON(response, 200, {
          data: {
            question: revised.question,
            delivered: revised.delivered === true,
            pending: false,
            suppressed: false,
            revised: true,
            // Reported so the client can say "confirmed, nothing sent to the
            // agent" rather than "Answer sent", which would be a lie: an
            // acknowledgement deliberately wakes nobody.
            acknowledged: revised.acknowledged === true,
            frameID: revised.frameID ?? null,
          },
        });
        return true;
      }

      if (error?.status === 404)
        throw httpError(404, `Question not found: ${answerRoute.questionID}`);

      throw error;
    }

    // `pending` means the answer is stored and the wake is queued, but the
    // agent's turn has not started yet. It is a third state, not a failure:
    // without it the client had to call an unrouted answer "saved" and a routable
    // one "sent", and could not tell the user which of the two it was.
    writeJSON(response, 200, {
      data: {
        question: result.question,
        delivered: result.delivered === true,
        pending: result.pending === true,
        // Stored, but deliberately not delivered: the user dismissed the
        // question. Distinct from `delivered: false`, which means "we tried and
        // the agent could not be reached".
        suppressed: result.suppressed === true,
        frameID: result.frameID ?? null,
      },
    });
    return true;
  }

  // Clear the unread badge for one question. Idempotent in the store: an
  // already-read question is returned unchanged.
  let readRoute = matchQuestionReadRoute(url.pathname);
  if (request.method === 'POST' && readRoute) {
    let questionsStore = context.require('questionsStore');
    let question = await questionsStore.markRead(readRoute.questionID);

    writeJSON(response, 200, {
      data: {
        question,
      },
    });
    return true;
  }

  // The asker withdrawing its own question. The reason is free-form and
  // optional; a non-string reason is a client bug, not something to coerce.
  let dismissRoute = matchQuestionDismissRoute(url.pathname);
  if (request.method === 'POST' && dismissRoute) {
    let body = await readJSON(request);
    if (body.reason != null && typeof body.reason !== 'string')
      throw httpError(400, 'reason must be a string');

    let questionsStore = context.require('questionsStore');
    let question = await questionsStore.dismissQuestion(dismissRoute.questionID, {
      reason: body.reason,
    });

    // Dismissing is terminal, so a pending default-answer deadline must not
    // survive it. Same primary guard as answering: cancel the scheduled frame
    // so the queue drops it instead of waking the asker about a default for a
    // question the user explicitly closed.
    let frameRuntime = context.has('frameRuntime') ? context.require('frameRuntime') : null;
    if (frameRuntime) {
      try {
        await cancelQuestionSchedule({ frameRuntime, questionID: question.id });
      } catch (_error) {
        // A failed cancel is not worth failing the dismiss: the fire-time
        // plugin re-checks `status === 'open'` and will no-op.
      }
    }

    writeJSON(response, 200, {
      data: {
        question,
      },
    });
    return true;
  }

  return false;
}
