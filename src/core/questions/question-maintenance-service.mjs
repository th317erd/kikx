'use strict';

import {
  applyDefaultAnswer,
  findDueDefaults,
  findRetryableDeliveries,
  markRedelivered,
  recordDeliveryFailure,
} from './question-maintenance.mjs';

/**
 * Periodic maintenance for the ask-user lifecycle.
 *
 * Two jobs, both owner decisions:
 *
 * - **Retry**: an answer that was persisted but never delivered is retried with
 *   exponential backoff, bounded by `DELIVERY_RETRY_DELAYS_MS`. Without this the
 *   answer was durable but unreachable forever.
 * - **Defaults**: an agent-specified default whose deadline has passed is applied
 *   and delivered, so an agent is not blocked indefinitely on an unanswered
 *   question.
 *
 * Ordering matters. Defaults are applied before retries so a question that was
 * already undeliverable does not get its default applied late; and a default is
 * only applied to a question that is still `open`, so a real answer always wins.
 *
 * The timer is unref'd and stopped on shutdown, matching the memory sampler: a
 * maintenance loop must never be the reason a process refuses to exit.
 */
export class QuestionMaintenanceService {
  constructor(options = {}) {
    let {
      questionsStore,
      questionAnswerService = null,
      intervalMs = 60_000,
      logger = console,
      clock = null,
      // Injectable for tests: the real thing would otherwise have to wait out
      // the backoff schedule.
      retryDelaysMs = null,
    } = options;

    if (!questionsStore)
      throw new TypeError('QuestionMaintenanceService requires questionsStore');

    this.questionsStore = questionsStore;
    this.questionAnswerService = questionAnswerService;
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.clock = clock;
    this.retryDelaysMs = retryDelaysMs;
    this.timer = null;
    this.running = false;
  }

  now() {
    if (typeof this.clock === 'function')
      return Number(this.clock());

    return Number(this.questionsStore.clock?.() ?? Date.now());
  }

  start() {
    if (this.timer || this.intervalMs <= 0)
      return false;

    this.timer = setInterval(() => {
      this.runOnce().catch((error) => {
        this.logger?.error?.('ask-user maintenance tick failed', error?.message || error);
      });
    }, this.intervalMs);

    // Never hold the process open for maintenance.
    this.timer.unref?.();
    return true;
  }

  stop() {
    if (!this.timer)
      return false;

    clearInterval(this.timer);
    this.timer = null;
    return true;
  }

  /**
   * One pass. Returns a summary rather than throwing, so a scheduler tick and a
   * test can both inspect what happened.
   */
  async runOnce(options = {}) {
    if (this.running)
      return { skipped: 'already-running' };

    this.running = true;
    try {
      let defaults = await this.applyDueDefaults(options);
      let retries = await this.retryUndelivered(options);
      return { defaults, retries };
    } finally {
      this.running = false;
    }
  }

  async applyDueDefaults(options = {}) {
    let now = Number(options.now ?? this.now());
    let due = await findDueDefaults(this.questionsStore, { now, limit: options.limit });
    let applied = [];
    let failed = [];

    for (let question of due) {
      try {
        let result = await applyDefaultAnswer(this.questionsStore, question.id, { now });

        // A no-op means the user answered (or dismissed) between the scan and
        // the write. That is a win, not an error — record nothing.
        if (!result.applied)
          continue;

        applied.push(result.question.id);

        if (this.questionAnswerService?.deliverAnswer)
          await this.deliverDefault(result.question);
      } catch (error) {
        failed.push({ questionID: question.id, error: error?.message || String(error) });
        this.logger?.error?.('ask-user: failed to apply default answer', error?.message || error);
      }
    }

    return { applied, failed };
  }

  /**
   * Deliver a defaulted answer. Delivery failure is recorded for retry exactly
   * like a user answer: the agent still needs to hear about it.
   */
  async deliverDefault(question) {
    let delivery = await this.questionAnswerService.deliverAnswer(question, {
      authorDisplayName: 'Default answer',
    });

    if (delivery?.delivered)
      return delivery;

    await recordDeliveryFailure(this.questionsStore, question.id, {
      reason: delivery?.reason || 'undeliverable',
      now: this.now(),
    });

    return delivery;
  }

  async retryUndelivered(options = {}) {
    if (!this.questionAnswerService?.deliverAnswer)
      return { skipped: 'no-answer-service', retried: [], failed: [] };

    let now = Number(options.now ?? this.now());
    let candidates = await findRetryableDeliveries(this.questionsStore, { now, limit: options.limit });
    let retried = [];
    let failed = [];

    for (let question of candidates) {
      try {
        let delivery = await this.questionAnswerService.deliverAnswer(question);

        if (delivery?.delivered) {
          await markRedelivered(this.questionsStore, question.id, { now });
          retried.push(question.id);
          this.logger?.warn?.('ask-user: redelivered a previously undeliverable answer', {
            questionID: question.id,
          });
          continue;
        }

        // Still undeliverable: extend the backoff, or exhaust it. Exhaustion is
        // recorded rather than retried forever — the answer stays visible on
        // the terminal `undeliverable` status either way.
        let updated = await recordDeliveryFailure(this.questionsStore, question.id, {
          reason: delivery?.reason || 'undeliverable',
          now,
        });

        if (updated.nextDeliveryAt == null)
          this.logger?.warn?.('ask-user: giving up delivering an answer', {
            questionID: question.id,
            attempts: updated.deliveryAttempts,
            reason: updated.deliveryLastReason,
          });

        failed.push(question.id);
      } catch (error) {
        failed.push(question.id);
        this.logger?.error?.('ask-user: delivery retry failed', error?.message || error);
      }
    }

    return { retried, failed };
  }
}
