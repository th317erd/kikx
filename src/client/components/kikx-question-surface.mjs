'use strict';

// The class vocabulary of a Question surface, and the Inbox row adapter.
//
// Split out of `kikx-question-frame.mjs` when that file crossed the repo's
// 800-line hard limit. The seam is a real responsibility boundary, not a line
// count: everything here is about which CSS names a surface speaks, while the
// frame module is about the answer interaction itself.

import {
  normalizeQuestionSummary,
} from '../state/questions-state.mjs';
import { RECEIPT_CLASSES } from './kikx-answer-receipt.mjs';

// --- Surface vocabulary ------------------------------------------------------
//
// One renderer, two surfaces. What differs between the Inbox row and the
// in-thread frame is the VOCABULARY of class names they emit, never the
// behaviour: the Inbox list reconciler and three Playwright specs address rows
// by the Inbox card's names (`data-question-id`, `.kikx-question-card__input`,
// `.kikx-question-card__receipt`), while the thread addresses frames by the
// frame module's.
//
// Keeping two renderers to serve two vocabularies is what let the surfaces drift
// apart in the first place — an answer the frame showed and the Inbox row did
// not. So the renderer is shared and only the names are chosen per surface.
//
// This is not a prefix swap. The two vocabularies disagree about what a name
// MEANS: on the frame `__answer` is the textarea and `__card` is the form; on
// the Inbox row `__answer` is the form, `__input` is the textarea, and `__card`
// is the outer element (an <article>, supplied by the row wrapper). Mapping them
// name-by-name is the point, and getting it wrong would put a textarea where a
// spec expects a form.

export const FRAME_ROOT_CLASS = 'kikx-question-frame';
export const INBOX_ROOT_CLASS = 'kikx-question-card';
export const INBOX_MODIFIER_CLASS = `${FRAME_ROOT_CLASS}--inbox`;

export const FRAME_VOCAB = {
  form: `${FRAME_ROOT_CLASS}__card`,
  meta: `${FRAME_ROOT_CLASS}__meta`,
  agent: `${FRAME_ROOT_CLASS}__agent`,
  age: `${FRAME_ROOT_CLASS}__age`,
  priority: `${FRAME_ROOT_CLASS}__priority`,
  position: `${FRAME_ROOT_CLASS}__position`,
  text: `${FRAME_ROOT_CLASS}__text`,
  refs: `${FRAME_ROOT_CLASS}__refs`,
  ref: `${FRAME_ROOT_CLASS}__ref`,
  input: `${FRAME_ROOT_CLASS}__answer`,
  actions: `${FRAME_ROOT_CLASS}__actions`,
  hint: `${FRAME_ROOT_CLASS}__hint`,
  submit: `${FRAME_ROOT_CLASS}__submit`,
  confirm: `${FRAME_ROOT_CLASS}__confirm`,
  answered: `${FRAME_ROOT_CLASS}__answered`,
  answerText: `${FRAME_ROOT_CLASS}__answer-text`,
  missing: `${FRAME_ROOT_CLASS}__missing`,
  settle: `${FRAME_ROOT_CLASS}__settle`,
  receipts: RECEIPT_CLASSES.frame,
};

export const INBOX_VOCAB = {
  form: `${INBOX_ROOT_CLASS}__answer`,
  meta: `${INBOX_ROOT_CLASS}__header`,
  agent: `${INBOX_ROOT_CLASS}__agent`,
  age: `${INBOX_ROOT_CLASS}__age`,
  priority: `${INBOX_ROOT_CLASS}__priority`,
  position: `${INBOX_ROOT_CLASS}__position`,
  text: `${INBOX_ROOT_CLASS}__text`,
  refs: `${INBOX_ROOT_CLASS}__refs`,
  ref: `${INBOX_ROOT_CLASS}__ref`,
  input: `${INBOX_ROOT_CLASS}__input`,
  actions: `${INBOX_ROOT_CLASS}__actions`,
  hint: `${INBOX_ROOT_CLASS}__hint`,
  submit: `${INBOX_ROOT_CLASS}__submit`,
  // The Inbox row has no separate confirm control; a confirmation there is the
  // same submit affordance, so it keeps that name rather than inventing a class
  // no stylesheet knows.
  confirm: `${INBOX_ROOT_CLASS}__submit`,
  answered: `${INBOX_ROOT_CLASS}__closed`,
  answerText: `${INBOX_ROOT_CLASS}__receipt-text`,
  missing: `${INBOX_ROOT_CLASS}__missing`,
  // The base name AND the modifier. Every rule that sizes, colours or places
  // this control is keyed on `.kikx-question-card__dismiss-close`, and a BEM
  // modifier is meant to accompany its block, not replace it. Emitting the
  // modifier alone dropped `margin-left: auto` from the header row, which is
  // exactly why the close button slid away from the end of the row.
  settle: `${INBOX_ROOT_CLASS}__dismiss-close ${INBOX_ROOT_CLASS}__dismiss-close--settle`,
  receipts: RECEIPT_CLASSES.card,
};

export function vocabularyFor(inboxChrome) {
  return inboxChrome ? INBOX_VOCAB : FRAME_VOCAB;
}

// The fuse that retires an Inbox row once its receipt window runs out. In the
// thread the equivalent moment MINIMISES instead of disappearing, which is why
// this exists only for the Inbox: the same question settles the same way, and
// the one surface that can afford to keep it on screen is the one the user asked
// to keep watching.
//
// A press cancels the countdown; the NEXT press fires it immediately, which is
// `duration="0"`.
export function buildSettleControl(ownerDocument, settleAfter, className) {
  let node = ownerDocument.createElement('aeor-progress-button');
  node.className = className;
  node.setAttribute('icon', 'close');
  node.setAttribute('label', 'Close now');
  node.setAttribute('title', 'Close now');
  node.setAttribute('size', '1.75rem');
  node.setAttribute('duration', '0');
  node.setAttribute('auto-complete-after', String(settleAfter));

  return node;
}

/**
 * Build one Inbox row: the approved adapter.
 *
 * The row keeps the `<article class="kikx-question-card" data-question-id>` shape
 * that the list reconciler and the Playwright lane address, and the question is
 * rendered by `kikx-question-frame` rather than by a second card renderer. The
 * frame is handed `inboxChrome: true`, which switches its class vocabulary to
 * the Inbox's and adds the three things only an aggregate row shows: batch
 * position, context references, and the settle fuse.
 *
 * The `<article>` is not decoration. A custom element cannot BE an `article`, so
 * a row that was itself the frame element could never match
 * `article.kikx-question-card[data-question-id=...]`. The frame deliberately does
 * not carry `.kikx-question-card` either: the reconciler collects rows with
 * `querySelectorAll('.kikx-question-card')` and would then count every row twice.
 */
export function renderInboxQuestionRow(app, question, options = {}) {
  let model = normalizeQuestionSummary(question);
  if (!model)
    return null;

  let ownerDocument = (app && app.ownerDocument)
    || (typeof document === 'undefined' ? null : document);
  if (!ownerDocument)
    return null;

  let row = ownerDocument.createElement('article');
  row.className = INBOX_ROOT_CLASS;
  row.setAttribute('data-question-id', model.id);

  // What state this row is in. The reconciler repaints a row whose status
  // changed and leaves every other row's node alone — which is what keeps a
  // half-typed answer's caret and draft intact — so these belong on the row.
  let closed = model.status !== 'open';
  let settledFor = closed && model.closedAt > 0 && model.settleAfter > 0;
  row.setAttribute('data-question-status', model.status);
  row.setAttribute('data-question-settled', settledFor ? 'true' : 'false');
  if (settledFor)
    row.setAttribute('data-settled-until', String(model.closedAt + model.settleAfter));
  if (model.groupID)
    row.setAttribute('data-group-id', model.groupID);

  let frame = ownerDocument.createElement('kikx-question-frame');
  frame.updateFrame(
    { content: { question: model } },
    { app: app || null },
    { inboxChrome: true, groupCount: options.groupCount, now: options.now, handlers: options.handlers || null },
  );

  row.appendChild(frame);

  return row;
}
