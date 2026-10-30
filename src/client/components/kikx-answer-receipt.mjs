'use strict';

// The answer receipt, rendered once for every surface that shows an answered
// question.
//
// There used to be two answers to "what did I say?", and only one of them told
// the truth. The inline `Question` frame rendered the answer text with its
// provenance; the Inbox row said "You replied." and nothing else. So the one
// place you go to look across all your questions was the one place that would
// not show you the answers — the owner's screenshot is that gap.
//
// Extracting this is not cosmetic. The frame's branch order encodes three
// separate corrections that were each hard-won, and a second copy would let them
// drift apart again:
//
//   1. A default answer is the AGENT's words, applied because nobody replied. It
//      is never labelled as the user's. (A receipt reading "Your answer:
//      declined to say" is a lie about who spoke.)
//   2. When a person overrides a delivered default, BOTH answers are shown,
//      because the agent was already told the default and may have acted on it.
//      A receipt that silently replaced it would hide the correction.
//   3. Provenance is written only when it is actually known. An answer from
//      before `answerSource` existed carries no marker at all, rather than
//      claiming to be a human reply.
//
// The class names differ per surface — the Inbox row has to stay addressable by
// the selectors its list reconciler and the browser specs already use — so
// callers pass the class map. Everything else here is shared.

import {
  AGENT_ANSWER_SOURCE,
  DEFAULT_ANSWER_SOURCE,
  isAcknowledgedDefaultAnswer,
  isRevisableDefaultAnswer,
  USER_ANSWER_SOURCE,
} from '../state/questions-state.mjs';

// Labels. `USER_ANSWER_LABEL` is the line above the words a person typed. The
// owner's wording for it is exactly "You replied" (2026-10-24 review: the Inbox
// and the session must feel the same), replacing the earlier "Your answer".
//
// It is a RECEIPT marker, not a form label: the answer box still says "Your
// answer..." as its placeholder, because there it is a question being asked.
// One constant drives both surfaces, so the Inbox row and the thread cannot
// drift into disagreeing about who spoke.
export const USER_ANSWER_LABEL = 'You replied';
export const AGENT_ANSWER_LABEL = 'Answer provided by a coordinator agent';
export const AGENT_ANSWER_NOTE = 'A coordinator agent answered this on the user\'s behalf.';
export const DEFAULT_ANSWER_LABEL = 'Default answer \u2014 applied automatically';
export const DEFAULT_ANSWER_NOTE = 'Nobody answered in time, so this answer was applied for you. You can replace it below.';
// The same fact without the promise. A closed Inbox row renders no answer box
// at all, so "you can replace it below" there would point at nothing. Two
// strings beat one sentence that is only true on one surface.
export const DEFAULT_ANSWER_NOTE_PLAIN = 'Nobody answered in time, so this answer was applied automatically.';
export const REVISED_BY_USER_NOTE = 'Sent after the default above.';
// Deliberately promises the correction path, because the revision gate keeps it
// open. A note that said "settled" here would be a lie the UI then contradicts
// by rendering an editable box underneath it.
export const ACKNOWLEDGED_BY_USER_NOTE = 'You confirmed this was right, so nobody was notified. You can still replace it below.';
export const ACKNOWLEDGED_BY_USER_NOTE_PLAIN = 'You confirmed this was right, so nobody was notified.';

// The Inbox row's own status line, when it is not showing a receipt.
export const SETTLED_ANSWERED_NOTE = 'You replied.';
export const SETTLED_DISMISSED_NOTE = 'Dismissed \u2014 you chose not to respond. The agent was not woken.';

/**
 * Class names for the two surfaces.
 *
 * The suffixes are deliberately different on the Inbox row: `__answer-label`
 * there is already the <label> of the answer FORM, and reusing it for a receipt
 * would make `querySelector('.kikx-question-card__answer-label')` return the
 * wrong node — the exact class of bug this refactor exists to prevent.
 */
export const RECEIPT_CLASSES = {
  frame: {
    group: 'kikx-question-frame__answers',
    block: 'kikx-question-frame__answer-given',
    label: 'kikx-question-frame__answer-label',
    text: 'kikx-question-frame__answer-text',
    note: 'kikx-question-frame__answer-note',
  },
  card: {
    group: 'kikx-question-card__receipts',
    block: 'kikx-question-card__receipt',
    label: 'kikx-question-card__receipt-label',
    text: 'kikx-question-card__receipt-text',
    note: 'kikx-question-card__receipt-note',
  },
};

function element(ownerDocument, tagName, className, text) {
  let node = ownerDocument.createElement(tagName);
  if (className)
    node.className = className;
  if (text !== undefined)
    node.textContent = text;

  return node;
}

/**
 * One answer: a label, the words, and an optional explanatory line.
 *
 * `options.source` is written to `data-answer-source` ONLY when supplied, so the
 * stylesheet and the specs can tell a delivered default from a human reply
 * without matching on prose that is meant to be reworded. Defaulting to 'user'
 * here would brand every pre-provenance answer as a human reply — the same lie
 * as labelling a default "Your answer".
 */
export function buildAnswerBlock(ownerDocument, answerText, options = {}, classes = RECEIPT_CLASSES.frame) {
  let block = element(ownerDocument, 'div', classes.block);

  block.appendChild(element(ownerDocument, 'span', classes.label, options.label || USER_ANSWER_LABEL));
  block.appendChild(element(ownerDocument, 'div', classes.text, String(answerText ?? '')));

  if (typeof options.note === 'string' && options.note !== '')
    block.appendChild(element(ownerDocument, 'p', classes.note, options.note));

  if (options.source)
    block.setAttribute('data-answer-source', options.source);

  return block;
}

/**
 * The receipt for an answered question, or null when there are no words to show.
 *
 * Returning null is meaningful and NOT a failure: a question can be terminal
 * without an answer (a dismissal, or an asker withdrawing it), and those want a
 * status line rather than an empty receipt. Callers keep owning that sentence.
 *
 * Branch order is load-bearing. A revision is checked before an acknowledgement,
 * and both before a live default, because a question that was revised can also
 * still carry `acknowledgedAt` from an earlier confirmation — and showing only
 * the confirmation would erase the correction that followed it.
 */
export function buildAnswerReceipt(ownerDocument, question, classes = RECEIPT_CLASSES.frame, options = {}) {
  if (!ownerDocument || !question)
    return null;

  // Does this surface actually offer a box to replace the answer with? The
  // frame does when the default is still revisable; an Inbox row never does,
  // because reaching `closed` means the form is gone. Defaults to true so the
  // frame's existing call sites keep their wording.
  let canReplace = options.canReplace !== false;

  let answer = typeof question.answer === 'string' ? question.answer.trim() : '';
  if (answer === '')
    return null;

  let superseded = typeof question.supersededDefaultAnswer === 'string'
    ? question.supersededDefaultAnswer.trim()
    : '';

  // A person overrode a delivered default. Both answers, oldest first.
  if (superseded !== '') {
    let group = element(ownerDocument, 'div', classes.group);
    group.appendChild(buildAnswerBlock(ownerDocument, superseded, {
      label: DEFAULT_ANSWER_LABEL,
      source: DEFAULT_ANSWER_SOURCE,
    }, classes));
    group.appendChild(buildAnswerBlock(ownerDocument, answer, {
      label: USER_ANSWER_LABEL,
      source: USER_ANSWER_SOURCE,
      note: REVISED_BY_USER_NOTE,
    }, classes));

    return group;
  }

  // A default this person confirmed. Still labelled a default, because it still
  // is one — confirming says the words were right, not that the person wrote
  // them.
  if (isAcknowledgedDefaultAnswer(question)) {
    return buildAnswerBlock(ownerDocument, answer, {
      label: DEFAULT_ANSWER_LABEL,
      source: DEFAULT_ANSWER_SOURCE,
      note: canReplace ? ACKNOWLEDGED_BY_USER_NOTE : ACKNOWLEDGED_BY_USER_NOTE_PLAIN,
    }, classes);
  }

  // Still the agent's own fallback. Say that it can be replaced — unless it
  // cannot, in which case the note would be a promise the server does not keep.
  if (question.answerSource === DEFAULT_ANSWER_SOURCE) {
    return buildAnswerBlock(ownerDocument, answer, {
      label: DEFAULT_ANSWER_LABEL,
      source: DEFAULT_ANSWER_SOURCE,
      note: isRevisableDefaultAnswer(question)
        ? (canReplace ? DEFAULT_ANSWER_NOTE : DEFAULT_ANSWER_NOTE_PLAIN)
        : '',
    }, classes);
  }

  if (question.answerSource === AGENT_ANSWER_SOURCE) {
    return buildAnswerBlock(ownerDocument, answer, {
      label: AGENT_ANSWER_LABEL,
      source: AGENT_ANSWER_SOURCE,
      note: AGENT_ANSWER_NOTE,
    }, classes);
  }

  // A real human answer is labelled as one; an answer of unknown provenance
  // carries no source marker rather than a guess.
  return buildAnswerBlock(ownerDocument, answer, {
    source: question.answerSource || undefined,
  }, classes);
}
