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
import {
  groupHeading,
  groupQuestions,
  isOpenQuestion,
  isVisibleInboxQuestion,
  normalizeQuestionList,
  openQuestionCount,
} from '../state/questions-state.mjs';
import { renderInboxQuestionRow } from './kikx-question-frame.mjs';
import { buildViewBackButton } from './kikx-view-chrome.mjs';

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

  // Back lives in the view's own header: when a view is on top of the stack
  // the shell renders it instead of `buildWindow`, so this is the only header
  // on screen and therefore the only place the affordance can live.
  return header.class(HEADER_CLASS)(
    buildViewBackButton(app),
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

function buildGroup(app, group, now, handlers) {
  let groupCount = group.questions.length;
  let heading = groupHeading(group);
  let children = [];

  // One heading per batch (plan §6.3) — rendered only when the model says the
  // group holds more than one question.
  if (heading)
    children.push(h3.class(HEADING_CLASS)(heading));

  for (let question of group.questions) {
    let card = renderInboxQuestionRow(app, question, { now, groupCount, handlers });
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

  // Settled rows stay on screen for their receipt window, so this is not
  // "everything in the model" — it is the visibility rule, shared with the
  // in-place reconciler below so a full render and a sync agree.
  let questions = readQuestions(app).filter((question) => isVisibleInboxQuestion(question));
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
      node = buildGroup(app, group, now, handlers);
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

  // Each row is a `kikx-question-frame` mounted by the adapter, and the frame
  // wires its own controls on render. There is no second bind pass: binding one
  // here as well would attach every submit twice.

  return list;
}

// --- In-place reconciliation ------------------------------------------------

const INPUT_CLASS = `${CARD_CLASS}__input`;

function setHeaderCount(app, count) {
  let headerCount = app.querySelector?.(`.${HEADER_COUNT_CLASS}`);
  if (headerCount)
    headerCount.textContent = String(count);
}

/**
 * Reconcile the rendered list against the model without touching the DOM of
 * questions that are still open.
 *
 * Returns `false` when the shape changed in a way this function will not
 * handle (no list on screen, empty <-> non-empty), so the caller falls back to
 * a full `_requestRender()`. When it returns `true` the user's drafts are
 * intact, because untouched cards were never re-created.
 */
export function syncInboxList(app, handlers = {}) {
  let inbox = app.querySelector?.('.kikx-inbox');
  if (!inbox)
    return false;

  let list = app.querySelector?.(`.${LIST_CLASS}`);
  let empty = app.querySelector?.(`.${EMPTY_CLASS}`);

  let questionsState = readQuestionsState(app);
  // A settled row is terminal but must remain visible until its receipt window
  // closes. Filtering on "locally closed" alone removed it the instant it was
  // answered, which is exactly the vanish-without-feedback behaviour the receipt
  // exists to prevent.
  let questions = normalizeQuestionList(readQuestions(app))
    .filter((question) => isVisibleInboxQuestion(question));

  // Nothing open: swap the list for the empty state in place. This is the
  // "answered the last question" case, and it used to return `false` so the
  // caller rebuilt the whole shell -- replacing every node on screen, including
  // the answer box and caret in a sibling card -- purely to show an empty state
  // this module can render itself.
  if (questions.length === 0) {
    if (!list)
      return true; // the empty state is already what is on screen

    let replacement = inboxEmptyState(app);
    if (!replacement || !list.parentNode)
      return false;

    list.parentNode.replaceChild(replacement, list);
    setHeaderCount(app, 0);
    return true;
  }

  // Questions to show, but the previous render drew the empty state: build the
  // list and swap it in. This is "the first question arrives while the Inbox is
  // open", which used to force a full rebuild for the same reason.
  if (!list) {
    if (!empty || !empty.parentNode)
      return false;

    let fresh = buildInboxList(app, handlers);
    if (!fresh)
      return false;

    empty.parentNode.replaceChild(fresh, empty);
    setHeaderCount(app, questions.length);
    return true;
  }

  let rendered = [ ...list.querySelectorAll(`.${CARD_CLASS}`) ];
  if (rendered.length === 0)
    return false;

  let wanted = new Set(questions.map((question) => question.id));

  // Drop rows the model no longer lists. Their drafts go with them, which is
  // correct: an answered question is closed, so there is nothing left to send.
  for (let card of rendered) {
    let questionID = card.getAttribute('data-question-id');
    if (questionID && wanted.has(questionID))
      continue;

    let row = card;
    while (row && row.parentNode && !row.classList?.contains(ROW_CLASS))
      row = row.parentNode;

    (row?.parentNode || list).removeChild(row || card);
  }

  let present = new Set(
    [ ...list.querySelectorAll(`.${CARD_CLASS}`) ]
      .map((card) => card.getAttribute('data-question-id'))
      .filter(Boolean),
  );

  // Repaint a card whose OWN state changed, without touching its neighbours.
  //
  // This is what makes the receipt appear: the row was rendered while the
  // question was open, and the answer form has to become "You replied." plus a
  // countdown.
  //
  // The change is NOT one-way. A rejected answer reopens the row through
  // `revertLocalSettlement`, so a repaint has to run in the settled -> open
  // direction too. It used to be skipped ("only rebuild when it settles"),
  // which left the receipt on screen after the server refused the write: the
  // model said open and the row above the failure notice still said "You
  // replied", contradicting it. Reopening rebuilds an interactive card, which
  // is safe because the node is new but the text is not — `bindAnswerForm`
  // restores the draft, which a failed send never cleared.
  //
  // A card still awaiting an answer keeps its node (and therefore its caret):
  // its status and settled-ness are unchanged, so it never reaches the rebuild.
  let byID = new Map(questions.map((question) => [ question.id, question ]));
  for (let card of [ ...list.querySelectorAll(`.${CARD_CLASS}`) ]) {
    let questionID = card.getAttribute('data-question-id');
    let question = questionID ? byID.get(questionID) : null;
    if (!question)
      continue;

    let renderedStatus = card.getAttribute('data-question-status') || '';
    let renderingStatus = question.status || '';
    let renderedSettled = card.getAttribute('data-question-settled') === 'true';
    let renderingSettled = isVisibleInboxQuestion(question) && !isOpenQuestion(question);

    // Comparing the STATUS specifically: an answered row and a dismissed row are
    // both terminal but must not be mistaken for each other, and an open row that
    // merely got a new readAt must NOT be rebuilt (that would eat the caret).
    if (renderedStatus === renderingStatus && renderedSettled === renderingSettled)
      continue;

    let fresh = renderInboxQuestionRow(app, question, {
      now: Date.now(),
      groupCount: questions.length,
      handlers,
    });
    if (!fresh)
      continue;

    let row = card;
    while (row && row.parentNode && !row.classList?.contains(ROW_CLASS))
      row = row.parentNode;

    let replacement = row && row !== card
      ? li.class(ROW_CLASS)(fresh).build(resolveDocument(app))
      : fresh;

    (row?.parentNode || list).replaceChild(replacement, row || card);
  }

  // Append rows that appeared after this list was rendered. Ordering is not
  // repaired here: new questions carry the newest `askedAt`, so appending is
  // already oldest-first.
  let now = Date.now();
  let groupCount = questions.length;
  for (let question of questions) {
    if (present.has(question.id))
      continue;

    let card = renderInboxQuestionRow(app, question, { now, groupCount, handlers });
    if (!card)
      continue;

    list.appendChild(li.class(ROW_CLASS)(card).build(resolveDocument(app)));
  }

  setHeaderCount(app, openQuestionCount(questions));
  return true;
}
