'use strict';

// One question row, shared by the Inbox list (plan §6.2) and the inline
// `Question` frame (plan §6.3). Nothing here may assume Inbox-only context: the
// frame renders this card on its own, so all layout state comes from `options`.
//
// [D-4] Free-form text only. The card offers exactly one interaction — a text
// box with its submit control. There is deliberately no toggle, quick-pick or
// options list, and the answer text is the only thing the user can produce.

import { elements } from '../lib/aeor-ui.mjs';
import {
  canSubmitAnswer,
  isTerminalQuestion,
  normalizeAnswerText,
  normalizeContextRefs,
  normalizeQuestionSummary,
  questionAge,
} from '../state/questions-state.mjs';
import {
  clearAnswerDraft,
  getAnswerDraft,
  setAnswerDraft,
} from '../state/question-drafts.mjs';

const { article, button, div, form, label, li, p, span, textarea, ul } = elements;

const CARD_CLASS = 'kikx-question-card';
const HEADER_CLASS = `${CARD_CLASS}__header`;
const AGENT_CLASS = `${CARD_CLASS}__agent`;
const AGE_CLASS = `${CARD_CLASS}__age`;
const POSITION_CLASS = `${CARD_CLASS}__position`;
const TEXT_CLASS = `${CARD_CLASS}__text`;
const REFS_CLASS = `${CARD_CLASS}__refs`;
const REF_CLASS = `${CARD_CLASS}__ref`;
const CLOSED_CLASS = `${CARD_CLASS}__closed`;
const FORM_CLASS = `${CARD_CLASS}__answer`;
const LABEL_CLASS = `${CARD_CLASS}__answer-label`;
const INPUT_CLASS = `${CARD_CLASS}__input`;
const ACTIONS_CLASS = `${CARD_CLASS}__actions`;
const HINT_CLASS = `${CARD_CLASS}__hint`;
const SUBMIT_CLASS = `${CARD_CLASS}__submit`;

const ANSWER_LABEL = 'Your answer';
const ANSWER_PLACEHOLDER = 'Type your answer';
const EMPTY_ANSWER_HINT = 'Type an answer before sending.';
const SUBMIT_FAILED_HINT = 'Could not send the answer.';
const SUBMIT_LABEL = 'Answer';
const SUBMIT_BUSY_LABEL = 'Sending\u2026';

// The card publishes what its last submission did through this attribute, so
// the stylesheet can colour the row and a spec can assert the phase without
// matching on human-readable label text.
const STATE_ATTRIBUTE = 'data-answer-state';

// A closed row states what happened instead of offering a box that would 409.
// The status is interpolated verbatim rather than prettified, so the row says
// exactly what the server recorded.
function closedNote(status) {
  return `Closed: ${status}.`;
}

// The builder needs an owner document. `app` is a custom element in the running
// app, but tests and the inline frame may pass a bare owner object, so fall back
// to the ambient document and finally to null (callers skip a null render
// instead of throwing inside a render pass).
function resolveDocument(app) {
  if (app && app.ownerDocument)
    return app.ownerDocument;

  return typeof document === 'undefined' ? null : document;
}

// "asking agent + session" (plan §6.2) in one meta node, with both ids verbatim:
// the card has no session/agent lookup of its own and must never invent a
// prettified label.
function questionMetaText(question) {
  if (question.agentID && question.sessionID)
    return `${question.agentID} · ${question.sessionID}`;

  return question.agentID || question.sessionID || 'Unattributed question';
}

function buildHeader(question, age, groupCount) {
  let isoAskedAt = question.askedAt > 0 ? new Date(question.askedAt).toISOString() : '';
  let children = [ span.class(AGENT_CLASS)(questionMetaText(question)) ];

  // A batch shares one group heading; the position keeps a single row orientated
  // when several questions arrive together (plan §6.3).
  if (groupCount > 1)
    children.push(span.class(POSITION_CLASS)(`${question.index} of ${groupCount}`));

  if (age)
    children.push(span.class(AGE_CLASS).title(isoAskedAt)(age));

  return div.class(HEADER_CLASS)(children);
}

// Frame-of-reference references as small labels. `normalizeContextRefs` has
// already dropped anything without a type and id, so every row names something.
function buildRefList(refs) {
  if (refs.length === 0)
    return null;

  return ul.class(REFS_CLASS)(
    refs.map((ref) => li.class(REF_CLASS)(ref.label || `${ref.type} ${ref.id}`)),
  );
}

// One interaction: a text box and its submit control. The hint element is the
// only other thing rendered, and it stays hidden until validation fails.
function buildAnswerForm(inputID) {
  return form.class(FORM_CLASS)(
    label.class(LABEL_CLASS).for(inputID)(ANSWER_LABEL),
    textarea
      .class(INPUT_CLASS)
      .id(inputID)
      .placeholder(ANSWER_PLACEHOLDER)
      .ariaLabel(ANSWER_LABEL)(),
    div.class(ACTIONS_CLASS)(
      span.class(HINT_CLASS).hidden(true).ariaLive('polite')(),
      button.type('submit').class(SUBMIT_CLASS)('Answer'),
    ),
  );
}

/**
 * Render one question row (plan §6.2): question text, asking agent + session,
 * age, frame-of-reference references, and the inline free-form answer box.
 *
 * `options.now` pins the clock used for the age label (so a list can render
 * every row against one timestamp); `options.groupCount` is the size of the
 * batch this row belongs to, used only for the "2 of 3" position label.
 *
 * A terminal row (`answered`/`dismissed`/`undeliverable`) renders read-only: the
 * answer already exists or the asker withdrew it, so offering a box that would
 * 409 is worse than showing the status.
 *
 * Returns null for a question that cannot be normalized, or when no owner
 * document is available, so a caller can filter instead of crashing a render.
 */
export function renderQuestionCard(app, question, options = {}) {
  let model = normalizeQuestionSummary(question);
  if (!model)
    return null;

  let ownerDocument = resolveDocument(app);
  if (!ownerDocument)
    return null;

  let now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now();
  let groupCount = Number.isInteger(options.groupCount) && options.groupCount > 0 ? options.groupCount : 1;
  let age = questionAge(model.askedAt, now);
  let refs = normalizeContextRefs(model.contextRefs);
  let inputID = `${CARD_CLASS}-answer-${model.id}`;
  let closed = isTerminalQuestion(model);

  let node = article.class(CARD_CLASS)(
    buildHeader(model, age, groupCount),
    p.class(TEXT_CLASS)(model.text),
    buildRefList(refs),
    closed
      ? p.class(CLOSED_CLASS)(closedNote(model.status))
      : buildAnswerForm(inputID),
  ).build(ownerDocument);

  // `data-question-id` is how `bindAnswerForm` addresses the row it was given:
  // the bind contract passes no question id, and this attribute survives the
  // list re-render that replaces the node.
  node.setAttribute('data-question-id', model.id);
  node.setAttribute('data-question-status', model.status);
  node.setAttribute(STATE_ATTRIBUTE, closed ? 'closed' : 'idle');
  if (model.groupID)
    node.setAttribute('data-group-id', model.groupID);

  // Stamp the reference identity directly on the rendered labels. A caller that
  // wants click-through (plan §6.2) can read it without re-parsing the label
  // text, and `setAttribute` keeps the names identical in every DOM.
  let refNodes = [ ...node.querySelectorAll(`.${REF_CLASS}`) ];
  for (let [ index, refNode ] of refNodes.entries()) {
    let ref = refs[index];
    if (!ref)
      continue;

    refNode.setAttribute('data-ref-type', ref.type);
    refNode.setAttribute('data-ref-id', ref.id);
  }

  return node;
}

function setHidden(element, hidden) {
  if (!element)
    return;

  if (hidden)
    element.setAttribute('hidden', '');
  else
    element.removeAttribute('hidden');
}

/**
 * Wire a card's answer form to the caller.
 *
 *   onSubmit(questionID, answerText) — answer text already normalized; may
 *     return a promise, and the control stays disabled until it settles.
 *   onRead(questionID) — fired once, when the answer box first takes focus.
 *   onDismiss(questionID) — fired on Escape while the box is still untouched.
 *
 * Handlers are attached here rather than through the builder's event chains
 * because they only exist at bind time, after the node is rendered. A throwing
 * `onSubmit` resets the control before rethrowing, so a bug in one card can
 * neither wedge the form nor hide the error from the app's error boundary.
 *
 * A read-only card has no form, so this is a no-op for terminal rows.
 */
export function bindAnswerForm(node, handlers = {}) {
  if (!node || typeof node.querySelector !== 'function')
    return;

  let formNode = node.querySelector(`.${FORM_CLASS}`);
  let inputNode = node.querySelector(`.${INPUT_CLASS}`);
  let submitNode = node.querySelector(`.${SUBMIT_CLASS}`);
  let hintNode = node.querySelector(`.${HINT_CLASS}`);
  if (!formNode || !inputNode || !submitNode)
    return;

  let { onSubmit, onDismiss, onRead, drafts } = handlers || {};
  let questionID = node.getAttribute('data-question-id') || '';
  let inFlight = false;
  let readSent = false;

  // Restore text this box held before the card was re-created. This is what
  // makes a full shell rebuild (session switch, unrelated runtime event, the
  // empty <-> non-empty fallback) non-destructive: the node is new, the text is
  // not. `getAnswerDraft` returns '' for any question without a draft, so a
  // freshly asked question is untouched.
  let restored = getAnswerDraft(drafts, questionID);
  if (restored !== '')
    inputNode.value = restored;

  // Saved on every keystroke rather than on submit: the whole failure being
  // fixed is text that was typed but never submitted.
  if (drafts && typeof inputNode.addEventListener === 'function') {
    inputNode.addEventListener('input', () => {
      setAnswerDraft(drafts, questionID, inputNode.value);
    });
  }

  function setHint(message) {
    setHidden(hintNode, message === '');
    if (hintNode)
      hintNode.textContent = message;
  }

  function setState(name) {
    if (node.setAttribute)
      node.setAttribute(STATE_ATTRIBUTE, name);
  }

  function setInFlight(next) {
    inFlight = next;
    // `disabled` and `readonly` are presence-based; the DSL and the DOM both
    // read them that way.
    if (next)
      submitNode.setAttribute('disabled', '');
    else
      submitNode.removeAttribute('disabled');

    if (next)
      inputNode.setAttribute('readonly', '');
    else
      inputNode.removeAttribute('readonly');

    // A disabled button with an unchanged label is not feedback: it looks
    // identical to an enabled one until you try it. The label and the row
    // state are what make the round-trip visible.
    submitNode.textContent = next ? SUBMIT_BUSY_LABEL : SUBMIT_LABEL;
    if (next)
      setState('busy');

    if (node.setAttribute)
      node.setAttribute('aria-busy', next ? 'true' : 'false');
  }

  function handleSubmit(event) {
    if (event && typeof event.preventDefault === 'function')
      event.preventDefault();

    if (inFlight)
      return;

    let answer = normalizeAnswerText(inputNode.value);
    if (!canSubmitAnswer(answer)) {
      setHint(EMPTY_ANSWER_HINT);
      if (typeof inputNode.focus === 'function')
        inputNode.focus();
      return;
    }

    setHint('');

    // No handler means nothing owns the answer yet; keep the typed text rather
    // than clearing it as if it had been sent.
    if (typeof onSubmit !== 'function')
      return;

    let pending;
    try {
      pending = onSubmit(questionID, answer);
    } catch (error) {
      setInFlight(false);
      setHint(SUBMIT_FAILED_HINT);
      throw error;
    }

    if (pending && typeof pending.then === 'function') {
      setInFlight(true);
      pending.then(
        (result) => {
          // A resolved-but-unsuccessful result is a failure. `submitQuestionAnswer`
          // reports a dropped POST or a 409 as `{ ok: false }` rather than by
          // rejecting, and treating every resolution as success is what used to
          // empty the box and discard the draft for an answer the server never
          // stored.
          if (result && result.ok === false) {
            setInFlight(false);
            setState('error');
            setHint(result.message || SUBMIT_FAILED_HINT);
            return;
          }

          setInFlight(false);
          setState('sent');
          // Only this row's draft is dropped. Every other card keeps its text,
          // including a sibling question from the same batch.
          clearAnswerDraft(drafts, questionID);
          inputNode.value = '';
        },
        () => {
          setInFlight(false);
          setState('error');
          setHint(SUBMIT_FAILED_HINT);
        },
      );
      return;
    }

    // A synchronous handler has no in-flight window to guard.
    clearAnswerDraft(drafts, questionID);
    inputNode.value = '';
  }

  function handleFocus() {
    if (readSent || typeof onRead !== 'function')
      return;

    readSent = true;
    onRead(questionID);
  }

  function handleKeydown(event) {
    if (!event || event.key !== 'Escape' || typeof onDismiss !== 'function')
      return;

    // Only abort an untouched box: Escape over typed text would discard work.
    if (normalizeAnswerText(inputNode.value) !== '')
      return;

    onDismiss(questionID);
  }

  formNode.addEventListener('submit', handleSubmit);
  formNode.addEventListener('keydown', handleKeydown);
  if (typeof onRead === 'function')
    inputNode.addEventListener('focus', handleFocus);
}
