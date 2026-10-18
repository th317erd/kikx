'use strict';

// The Inbox list (plan §6.2): every open question, oldest first, grouped so a
// batch from one `ask-user` call reads as a single flow (plan §6.3).
//
// All reconciliation lives in `state/questions-state.mjs`; this module only
// turns the app's current question array into DOM. Nothing here fetches, sorts
// or filters — if the model changes a rule, the list inherits it.
//
// S1: no function here throws. A missing state slice, a malformed question or a
// builder failure degrades to the empty state, because this node is built inside
// the shell's render pass and an exception would blank the whole app.

import { elements } from '../lib/aeor-ui.mjs';
import { groupHeading, groupQuestions, openQuestionCount } from '../state/questions-state.mjs';
import { bindAnswerForm, renderQuestionCard } from './kikx-question-card.mjs';

const { div, h3, header, h2, li, p, span, ul } = elements;

const LIST_CLASS = 'kikx-inbox-list';
const GROUP_CLASS = `${LIST_CLASS}__group`;
const HEADING_CLASS = `${LIST_CLASS}__heading`;
const ROW_CLASS = `${LIST_CLASS}__row`;
const CARD_CLASS = 'kikx-question-card';
const EMPTY_CLASS = 'kikx-inbox-empty';
const EMPTY_TITLE_CLASS = `${EMPTY_CLASS}__title`;
const EMPTY_DETAIL_CLASS = `${EMPTY_CLASS}__detail`;

const HEADER_CLASS = 'kikx-inbox-header';
const HEADER_TITLE_CLASS = `${HEADER_CLASS}__title`;
const HEADER_COUNT_CLASS = `${HEADER_CLASS}__count`;
const HEADER_ERROR_CLASS = `${HEADER_CLASS}__error`;

const EMPTY_TITLE = 'Nothing waiting on you';
const EMPTY_DETAIL = 'Questions from your agents will appear here.';

// The builder needs an owner document. `app` is a custom element in the running
// app, while a spec may pass a bare `{ _state }` owner, so fall back to the
// ambient document.
function resolveDocument(app) {
  if (app && app.ownerDocument)
    return app.ownerDocument;

  return typeof document === 'undefined' ? null : document;
}

function readQuestionsState(app) {
  let questionsState = app?._state?.questionsState;
  return questionsState && typeof questionsState === 'object' ? questionsState : null;
}

// The questions array is read live from the model slice. A missing slice is a
// normal state (the view renders before the first fetch), not an error.
function readQuestions(app) {
  let questions = readQuestionsState(app)?.questions;
  return Array.isArray(questions) ? questions : [];
}

/**
 * The Inbox heading: what this surface is, how many questions are open, and any
 * load error. The count comes from the shared model so the header, the sidebar
 * badge and the list can never disagree about what "open" means.
 *
 * A load error is shown as text rather than thrown: a failed fetch must not
 * replace the Inbox with an error dialog, and the rows already known stay
 * visible below it.
 */
export function inboxHeader(app) {
  let ownerDocument = resolveDocument(app);
  if (!ownerDocument)
    return null;

  let questionsState = readQuestionsState(app);
  let count = openQuestionCount(readQuestions(app));
  let error = questionsState?.error;

  return header.class(HEADER_CLASS)(
    h2.class(HEADER_TITLE_CLASS)('Inbox'),
    span.class(HEADER_COUNT_CLASS)(String(count)),
    error ? span.class(HEADER_ERROR_CLASS)(String(error)) : null,
  ).build(ownerDocument);
}

/**
 * The empty state: no open questions. Deliberately says nothing about errors or
 * loading — those belong to `inboxHeader`, and a card list must not claim a
 * fetch failed when it merely has nothing to show yet.
 */
export function inboxEmptyState(app) {
  let ownerDocument = resolveDocument(app);
  if (!ownerDocument)
    return null;

  return div.class(EMPTY_CLASS)(
    p.class(EMPTY_TITLE_CLASS)(EMPTY_TITLE),
    p.class(EMPTY_DETAIL_CLASS)(EMPTY_DETAIL),
  ).build(ownerDocument);
}

function buildGroup(app, group, now) {
  let groupCount = group.questions.length;
  let heading = groupHeading(group);
  let children = [];

  // One heading per batch (plan §6.3) — rendered only when the model says the
  // group holds more than one question.
  if (heading)
    children.push(h3.class(HEADING_CLASS)(heading));

  for (let question of group.questions) {
    let card = renderQuestionCard(app, question, { now, groupCount });
    if (!card)
      continue;

    children.push(li.class(ROW_CLASS)(card));
  }

  return ul.class(GROUP_CLASS)(children).build(resolveDocument(app));
}

/**
 * Build the Inbox list node.
 *
 * Reads `app._state.questionsState.questions`, groups and sorts through the
 * shared model, and renders one card per question, oldest group first. Missing,
 * malformed or empty question state renders the empty state, and any builder
 * failure degrades the same way instead of throwing into the render pass.
 *
 * `handlers` is optional and additive: when supplied, every card is wired
 * through `bindAnswerForm` in the same call. Without it the caller binds the
 * cards itself (each one carries `.kikx-question-card` and
 * `data-question-id`), which is how the Inbox view and the inline `Question`
 * frame share this renderer.
 */
export function buildInboxList(app, handlers = {}) {
  let ownerDocument = resolveDocument(app);
  if (!ownerDocument)
    return null;

  let questions = readQuestions(app);
  if (questions.length === 0)
    return inboxEmptyState(app);

  // One clock for the whole render, so every age label in the list agrees and a
  // slow render cannot print "now" above "1m".
  let now = Date.now();
  let groupNodes = [];
  let groups = [];
  try {
    groups = groupQuestions(questions);
  } catch (_error) {
    groups = [];
  }

  for (let group of groups) {
    let node = null;
    try {
      node = buildGroup(app, group, now);
    } catch (_error) {
      // One unrenderable row must not take the rest of the Inbox down with it
      // (S1): drop the failing group, keep the others.
      node = null;
    }

    if (node && node.childNodes.length > 0)
      groupNodes.push(node);
  }

  if (groupNodes.length === 0)
    return inboxEmptyState(app);

  let list = div.class(LIST_CLASS)(groupNodes).build(ownerDocument);

  let hasHandlers = handlers && (typeof handlers.onSubmit === 'function'
    || typeof handlers.onDismiss === 'function'
    || typeof handlers.onRead === 'function');
  if (hasHandlers) {
    for (let card of list.querySelectorAll(`.${CARD_CLASS}`))
      bindAnswerForm(card, handlers);
  }

  return list;
}
