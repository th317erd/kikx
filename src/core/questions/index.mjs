'use strict';

// The store keeps only the I/O; the pure document layer moved to
// ./question-doc.mjs so questions-store.mjs could fall back under the 800-line
// hard limit in AGENTS.md. Both are re-exported here so the public surface is
// unchanged.
export { QuestionsStore } from './questions-store.mjs';

export {
  QUESTION_MAX_PER_CALL,
  QUESTION_STATUSES,
  QUESTION_TERMINAL_STATUSES,
  normalizeQuestionDoc,
  summarizeQuestion,
} from './question-doc.mjs';

export {
  listDocPaths,
  repairQuestionIndex,
} from './question-index-repair.mjs';

export {
  DEFAULT_ANSWER_SOURCE,
  USER_ANSWER_SOURCE,
} from './question-fields.mjs';

export {
  VISIBLE_QUESTION_STATUSES,
  assertAskPrecondition,
  canonicalVisibleQuestions,
  findDuplicateQuestions,
  questionTextKey,
  resolveVisibleSessionIDs,
  selectVisiblePendingQuestions,
  visibleQuestionDigest,
} from './question-dedupe.mjs';

export {
  DELIVERY_RETRY_DELAYS_MS,
  applyDefaultAnswer,
  findRetryableDeliveries,
  markRedelivered,
  recordDeliveryFailure,
} from './question-maintenance.mjs';

export {
  QUESTION_DEADLINE_KIND,
  QUESTION_RETRY_KIND,
  QUESTION_SCHEDULE_KINDS,
  armQuestionDeadline,
  armQuestionRetry,
  armQuestionSchedule,
  buildQuestionScheduleFrame,
  cancelQuestionSchedule,
  toScheduledAt,
} from './question-deadline-schedule.mjs';

export {
  QuestionScheduleFramePlugin,
  registerQuestionScheduleRouting,
} from './question-schedule-plugin.mjs';

export {
  QuestionAnswerService,
  QuestionUndeliverableError,
  buildAnswerPromptText,
} from './question-wake.mjs';
