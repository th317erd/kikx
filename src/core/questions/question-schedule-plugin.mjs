'use strict';

import { BaseFramePlugin } from '../routing/index.mjs';
import { applyDefaultAnswer, markRedelivered, recordDeliveryFailure } from './question-maintenance.mjs';
import { patchQuestionFrameContent } from './question-frame-patch.mjs';
import {
  QUESTION_DEADLINE_KIND,
  QUESTION_RETRY_KIND,
  QUESTION_SCHEDULE_KINDS,
  armQuestionRetry,
} from './question-deadline-schedule.mjs';

const DEFAULT_ANSWER_AUTHOR = 'Default answer';

/**
 * Handles a question's scheduled frame when the queue fires it.
 *
 * This is the half that makes the queue approach real rather than cosmetic: a
 * fired frame must *do the work* (apply the default, retry the delivery), not
 * merely wake the asking agent and hope the model remembers what it scheduled.
 *
 * It is also the answer to "what happens when the timer fires but the question
 * was already answered". Cancelling the schedule at answer time is the primary
 * guard, but it cannot be sufficient on its own: `ScheduledFrameQueue.dispatch`
 * awaits a session lookup and a flush between choosing a due entry and routing
 * it, and again around the route itself. An answer landing inside either window
 * would arrive after the cancel and before the dispatch. So the status is
 * re-read here, from the store, at the last possible moment — and a question
 * that is no longer open causes `done()` WITHOUT `next()`, which stops the
 * router chain before `AgentRouteFramePlugin` can start a turn. The agent is not
 * woken; it is not told a default fired; nothing is appended to the transcript.
 *
 * Registration order matters for exactly that reason: this plugin must be
 * registered before agent routing, or `done()` arrives too late to matter.
 */
export class QuestionScheduleFramePlugin extends BaseFramePlugin {
  static pluginID = 'internal:question-deadline';

  async process(next, done) {
    let frame = this.context.newFrame;
    let kind = frame?.continuation?.kind;

    if (!QUESTION_SCHEDULE_KINDS.includes(kind)) {
      await next(this.context);
      return;
    }

    // A scheduled frame only ever belongs to the queue's own dispatch. Seeing
    // one on any other commit means it is still pending or was cancelled; the
    // queue owns that decision, so stay silent rather than acting early.
    if (this.context.commit?.scheduledDispatch !== true) {
      done();
      return;
    }

    let services = this.context.services || {};
    let store = services.questionsStore || services.context?.require?.('questionsStore') || null;
    let answerService = services.questionAnswerService
      || services.context?.require?.('questionAnswerService')
      || null;
    let frameRuntime = services.frameRuntime || services.context?.require?.('frameRuntime') || null;
    let questionID = frame?.continuation?.questionID;

    if (!store || !questionID || typeof store.getQuestion !== 'function') {
      done();
      return;
    }

    let question = null;
    try {
      question = await store.getQuestion(questionID);
    } catch (_error) {
      // The question doc is gone (deleted). Nothing to apply, nothing to wake.
      done();
      return;
    }

    let now = Number(services.clock?.() || frameRuntime?.clock?.() || Date.now());

    if (kind === QUESTION_DEADLINE_KIND) {
      // The backstop: somebody answered or dismissed after the schedule was
      // armed. Drop it silently — a default must never overwrite a real answer,
      // and the agent must not be woken for a decision it already has.
      if (question?.status !== 'open' || question?.deleted === true) {
        done();
        return;
      }

      await this.applyDeadline({ store, answerService, frameRuntime, question, now });
      done();
      return;
    }

    if (kind === QUESTION_RETRY_KIND) {
      if (question?.status !== 'undeliverable') {
        done();
        return;
      }

      await this.retryDelivery({ store, answerService, frameRuntime, question, now });
      done();
      return;
    }

    await next(this.context);
  }

  async applyDeadline({ store, answerService, frameRuntime, question, now }) {
    let result = null;
    try {
      result = await applyDefaultAnswer(store, question.id, { now });
    } catch (error) {
      this.context.services?.logger?.error?.('ask-user: scheduled default failed', error);
      return;
    }

    if (!result?.applied)
      return;

    // Update the stored Question frame so the transcript stops rendering an
    // open form for a question that has resolved.
    try {
      await patchQuestionFrameContent({ frameRuntime }, result.question, { frameRuntime });
    } catch (error) {
      this.context.services?.logger?.warn?.('ask-user: could not patch the question frame', error);
    }

    if (!answerService?.deliverAnswer)
      return;

    let delivery = null;
    try {
      delivery = await answerService.deliverAnswer(result.question, {
        authorDisplayName: DEFAULT_ANSWER_AUTHOR,
      });
    } catch (error) {
      this.context.services?.logger?.error?.('ask-user: default answer delivery threw', error);
    }

    if (delivery?.delivered)
      return;

    // The default is applied and durable but the agent could not be reached.
    // Record it exactly like a failed user-answer delivery, and schedule the
    // retry as its own frame instead of a poller tick.
    try {
      let updated = await recordDeliveryFailure(store, result.question.id, {
        reason: delivery?.reason || 'undeliverable',
        now,
      });

      if (updated?.nextDeliveryAt != null)
        await armQuestionRetry({ frameRuntime, question: updated, now });
    } catch (error) {
      this.context.services?.logger?.error?.('ask-user: could not record default delivery failure', error);
    }
  }

  async retryDelivery({ store, answerService, frameRuntime, question, now }) {
    if (!answerService?.deliverAnswer)
      return;

    let delivery = null;
    try {
      delivery = await answerService.deliverAnswer(question);
    } catch (error) {
      this.context.services?.logger?.error?.('ask-user: scheduled delivery retry threw', error);
    }

    if (delivery?.delivered) {
      try {
        await markRedelivered(store, question.id, { now });
      } catch (error) {
        this.context.services?.logger?.error?.('ask-user: could not mark redelivered', error);
      }
      return;
    }

    // Still unreachable: extend the backoff, or give up. Giving up clears
    // `nextDeliveryAt`, which is what stops the chain from re-arming.
    try {
      let updated = await recordDeliveryFailure(store, question.id, {
        reason: delivery?.reason || 'undeliverable',
        now,
      });

      if (updated?.nextDeliveryAt != null)
        await armQuestionRetry({ frameRuntime, question: updated, now });
    } catch (error) {
      this.context.services?.logger?.error?.('ask-user: could not extend the delivery backoff', error);
    }
  }
}

export function registerQuestionScheduleRouting(frameRouter) {
  if (!frameRouter?.registerSelector)
    throw new TypeError('registerQuestionScheduleRouting() requires a FrameRouter');

  frameRouter.registerSelector(
    'Type:UserMessage',
    QuestionScheduleFramePlugin,
    QuestionScheduleFramePlugin.pluginID,
  );
}
