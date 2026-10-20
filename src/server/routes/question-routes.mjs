'use strict';

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

// Ask-user questions: the read side the Inbox renders, plus the answer loop's
// write side. The list route reads the store's open index (`listOpen`) and never
// scans the per-question docs — history must not make the inbox slower.
export async function handleQuestionRoutes({ request, response, url, context }) {
  if (request.method === 'GET' && url.pathname === '/api/v1/questions') {
    let limit = parsePositiveInteger(url.searchParams.get('limit'), 50);
    let offset = parseNonNegativeInteger(url.searchParams.get('offset'), 0);
    let status = url.searchParams.get('status');

    let questionsStore = context.require('questionsStore');
    let open = await questionsStore.listOpen({
      sessionID: url.searchParams.get('sessionID'),
      agentID: url.searchParams.get('agentID'),
      groupID: url.searchParams.get('groupID'),
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
    if (typeof body.answer !== 'string' || body.answer.trim() === '')
      throw httpError(400, 'answer must be a non-empty string');

    // Identity is optional, matching POST /api/v1/sessions/:id/messages: the
    // answer is attributed when someone is signed in, but a local request
    // without an account is not rejected.
    let account = await getRequestAccount(context, request);
    let answerService = context.require('questionAnswerService');

    let result;
    try {
      result = await answerService.submitAnswer(answerRoute.questionID, {
        answer: body.answer,
        userID: account?.id || body.userID || null,
      });
    } catch (error) {
      if (error?.status === 409)
        throw httpError(409, 'Question already answered');

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

    writeJSON(response, 200, {
      data: {
        question,
      },
    });
    return true;
  }

  return false;
}
