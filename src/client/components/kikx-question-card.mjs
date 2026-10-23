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
import { describeQuestionOrigin } from '../state/question-attribution.mjs';

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
const DISMISS_CLASS = `${CARD_CLASS}__dismiss`;
const DISMISS_CLOSE_CLASS = `${CARD_CLASS}__dismiss-close`;

const ANSWER_LABEL = 'Your answer';
const ANSWER_PLACEHOLDER = 'Type your answer';
const EMPTY_ANSWER_HINT = 'Type an answer before sending.';
const SUBMIT_FAILED_HINT = 'Could not send the answer.';
const SUBMIT_LABEL = 'Answer';
const SUBMIT_BUSY_LABEL = 'Sending\u2026';
const DISMISS_LABEL = 'Dismiss';
const DISMISS_CLOSE_LABEL = 'Dismiss question';

// Both dismiss affordances are hold-to-activate: a stray click next to the
// answer box must not silently close a question the user was about to answer.
// 500ms is the agreed hold — long enough to be deliberate, short enough that it
// does not feel like the control is broken.
const DISMISS_HOLD_MS = 500;

// The vendored hold-to-confirm controls. Both are already loaded by aeor-ui.mjs;
// they are looked up at build time and degrade to plain buttons when absent (a
// spec DOM, or a vendor tree that failed to load) so the Inbox never renders a
// card whose dismiss controls do nothing.
const CONFIRM_BUTTON_TAG = 'aeor-confirm-button';
const PROGRESS_BUTTON_TAG = 'aeor-progress-button';

function customElementDefined(tagName) {
  return typeof customElements !== 'undefined' && Boolean(customElements.get(tagName));
}

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

// The receipt shown for a row this tab just settled. Deliberately not
// `closedNote`: that one reports a status the SERVER recorded, and this is the
// user's own action being acknowledged. A dismissal also has to say plainly
// that nobody was woken, or "I dismissed it" is indistinguishable from "my
// click did nothing".
function settledNote(question) {
  if (question.status === 'dismissed')
    return 'Dismissed \u2014 you chose not to respond. The agent was not woken.';

  return 'You replied.';
}

// The close control on a settled row: a fuse that retires the row once its
// receipt window runs out. A press cancels the fuse (the component's own rule);
// the NEXT press fires it immediately, which is `duration="0"`.
function buildSettleControl(ownerDocument, settleAfter) {
  let node = ownerDocument.createElement(PROGRESS_BUTTON_TAG);
  node.className = `${DISMISS_CLOSE_CLASS} ${DISMISS_CLOSE_CLASS}--settle`;
  node.setAttribute('icon', 'close');
  node.setAttribute('label', 'Close now');
  node.setAttribute('title', 'Close now');
  node.setAttribute('size', '1.75rem');
  node.setAttribute('duration', '0');
  node.setAttribute('auto-complete-after', String(settleAfter));

  return node;
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

// "asking agent + session" (plan §6.2) in one meta node.
//
// This used to print both ids verbatim, on the principle that a card with no
// lookup must never invent a prettified label. The principle was right and the
// conclusion was wrong: the lookup exists in the app state, the renderer was
// simply never given it, so the row was headed by two UUIDs that told the owner
// nothing. `describeQuestionOrigin` resolves the real agent name and session
// title, and degrades to a short id — never a fabricated name — when either is
// unknown.
function questionMetaText(app, question) {
  return describeQuestionOrigin(app?._state, question).text;
}

function buildHeader(app, question, age, groupCount, closeControl = null) {
  let isoAskedAt = question.askedAt > 0 ? new Date(question.askedAt).toISOString() : '';
  let origin = describeQuestionOrigin(app?._state, question);
  let children = [ span.class(AGENT_CLASS).title(origin.text)(origin.text) ];

  // A batch shares one group heading; the position keeps a single row orientated
  // when several questions arrive together (plan §6.3).
  if (groupCount > 1)
    children.push(span.class(POSITION_CLASS)(`${question.index} of ${groupCount}`));

  if (age)
    children.push(span.class(AGE_CLASS).title(isoAskedAt)(age));

  // The round close sits at the far end of the header row. It is in the header
  // rather than the actions row so the question can be dismissed without first
  // scrolling to the answer box.
  if (closeControl)
    children.push(closeControl);

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

/**
 * Build one dismiss control.
 *
 * `kind` is 'text' for the labelled Dismiss button (the linear
 * aeor-confirm-button, which fills left-to-right) or 'close' for the round
 * aeor-progress-button (a radial ring around a close glyph). Both fire `confirm`
 * once their hold completes; the fallbacks are plain buttons whose click is
 * wired by `bindAnswerForm`, so the same behaviour survives a missing vendor.
 *
 * Returns `{ node, holdToConfirm }` — the bind step needs to know which event to
 * listen for, and a plain fallback button never emits `confirm`.
 */
export function buildDismissControl(ownerDocument, kind) {
  let isClose = kind === 'close';
  let tagName = isClose ? PROGRESS_BUTTON_TAG : CONFIRM_BUTTON_TAG;

  if (customElementDefined(tagName)) {
    let node = ownerDocument.createElement(tagName);
    node.className = isClose ? DISMISS_CLOSE_CLASS : DISMISS_CLASS;
    node.setAttribute('duration', String(DISMISS_HOLD_MS));
    if (isClose) {
      node.setAttribute('icon', 'close');
      node.setAttribute('label', DISMISS_CLOSE_LABEL);
      node.setAttribute('title', `${DISMISS_CLOSE_LABEL} (hold)`);
      node.setAttribute('size', '1.75rem');
    } else {
      node.setAttribute('label', DISMISS_LABEL);
      node.setAttribute('title', 'Hold to dismiss this question');
    }

    return { node, holdToConfirm: true };
  }

  // Fallback: same classes and accessible name so layout and a11y are unchanged.
  let node = ownerDocument.createElement('button');
  node.type = 'button';
  node.className = isClose
    ? `${DISMISS_CLOSE_CLASS} ${DISMISS_CLOSE_CLASS}--fallback`
    : `${DISMISS_CLASS} ${DISMISS_CLASS}--fallback`;
  node.setAttribute('aria-label', isClose ? DISMISS_CLOSE_LABEL : DISMISS_LABEL);
  node.setAttribute('title', isClose ? DISMISS_CLOSE_LABEL : DISMISS_LABEL);
  node.textContent = isClose ? '\u00d7' : DISMISS_LABEL;

  return { node, holdToConfirm: false };
}

/**
 * Attach a handler to one dismiss control.
 *
 * Both dismiss affordances are hold-to-activate, so which event to listen for
 * depends on what the vendored control actually is: `aeor-confirm-button` and
 * `aeor-progress-button` emit `confirm` once the hold completes, while the plain
 * fallback buttons only emit `click`. Exported because the inline `Question`
 * frame renders the same two controls and must not grow a second, subtly
 * different copy of this logic.
 */
export function bindDismissControl(control, handler) {
  if (!control || typeof handler !== 'function')
    return;

  let isHold = control.localName === CONFIRM_BUTTON_TAG
    || control.localName === PROGRESS_BUTTON_TAG;

  control.addEventListener(isHold ? 'confirm' : 'click', (event) => {
    if (event && typeof event.preventDefault === 'function' && !isHold)
      event.preventDefault();
    if (event && typeof event.stopPropagation === 'function')
      event.stopPropagation();

    handler();
  });
}

// One interaction: a text box and its submit control. The hint element is the
// only other thing rendered, and it stays hidden until validation fails.
function buildAnswerForm(inputID, ownerDocument) {
  return form.class(FORM_CLASS)(
    label.class(LABEL_CLASS).for(inputID)(ANSWER_LABEL),
    textarea
      .class(INPUT_CLASS)
      .id(inputID)
      .placeholder(ANSWER_PLACEHOLDER)
      .ariaLabel(ANSWER_LABEL)(),
    div.class(ACTIONS_CLASS)(
      button.type('submit').class(SUBMIT_CLASS)('Answer'),
      // Text Dismiss sits next to Answer: the explicit "I am not answering".
      ownerDocument ? buildDismissControl(ownerDocument, 'text').node : null,
      // The hint is LAST so revealing it grows into the free space to the right
      // of the controls. It used to sit first, which meant unhiding it inserted
      // its width ahead of the buttons and shoved them sideways exactly when the
      // user was aiming at one.
      span.class(HINT_CLASS).hidden(true).ariaLive('polite')(),
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


  // A settled row keeps its controls: the close button becomes the fuse that
  // ends the receipt window, and a press on it closes the row straight away.
  // Only a row with no receipt window is bare.
  let settledFor = closed && model.closedAt > 0 && model.settleAfter > 0;
  let closeControl = settledFor
    ? { node: buildSettleControl(ownerDocument, model.settleAfter), holdToConfirm: false }
    : (closed ? null : buildDismissControl(ownerDocument, 'close'));

  let node = article.class(CARD_CLASS)(
    buildHeader(app, model, age, groupCount, closeControl ? closeControl.node : null),
    p.class(TEXT_CLASS)(model.text),
    buildRefList(refs),
    closed
      ? p.class(CLOSED_CLASS)(settledFor ? settledNote(model) : closedNote(model.status))
      : buildAnswerForm(inputID, ownerDocument),
  ).build(ownerDocument);

  // `data-question-id` is how `bindAnswerForm` addresses the row it was given:
  // the bind contract passes no question id, and this attribute survives the
  // list re-render that replaces the node.
  node.setAttribute('data-question-id', model.id);
  node.setAttribute('data-question-status', model.status);
  node.setAttribute(STATE_ATTRIBUTE, closed ? 'closed' : 'idle');
  if (settledFor) {
    node.setAttribute('data-question-settled', 'true');
    node.setAttribute('data-settled-until',
      String(model.closedAt + model.settleAfter));
  }
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

  // A settled row has no form to bind, but its close control is live: it ends
  // the receipt window now instead of waiting for the fuse. Handled before the
  // form lookup, which returns early for every settled row.
  if (node.getAttribute && node.getAttribute('data-question-settled') === 'true') {
    bindSettleControl(node, handlers);
    return;
  }

  let formNode = node.querySelector(`.${FORM_CLASS}`);
  let inputNode = node.querySelector(`.${INPUT_CLASS}`);
  let submitNode = node.querySelector(`.${SUBMIT_CLASS}`);
  let hintNode = node.querySelector(`.${HINT_CLASS}`);
  if (!formNode || !inputNode || !submitNode)
    return;

  let { onSubmit, onRead, onDismiss, onDismissAnswer, drafts } = handlers || {};
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

    // Only the Answer button may submit this form. A hold-to-confirm control
    // renders a nested <button>, and an untyped nested button is a submit
    // button by default — so a Dismiss press used to submit the form, fail the
    // empty-answer check, and push the hint (and the buttons) sideways under the
    // user's cursor. The framework now sets type="button" on it; this check also
    // guards any vendored copy older than that fix, where the submit still
    // happens.
    if (event && event.submitter && event.submitter !== submitNode)
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

  // Dismiss the question: record "<User chose not to respond>" as the answer and
  // close the row locally. This is NOT the `/dismiss` endpoint — that one is the
  // asking agent withdrawing its own question, the opposite direction and a
  // different terminal status. Going through the answer path means the asking
  // agent can read the outcome, while `silent` keeps it from being woken.
  function requestDismiss() {
    if (inFlight)
      return;

    if (typeof onDismissAnswer !== 'function') {
      // Nothing owns the dismissal (an inline frame rendered without handlers):
      // fall back to the older local-only behaviour rather than a dead button.
      if (typeof onDismiss === 'function')
        onDismiss(questionID);

      return;
    }

    let pending;
    try {
      pending = onDismissAnswer(questionID);
    } catch (error) {
      setHint(SUBMIT_FAILED_HINT);
      throw error;
    }

    if (!pending || typeof pending.then !== 'function')
      return;

    setInFlight(true);
    pending.then(
      (result) => {
        if (result && result.ok === false) {
          setInFlight(false);
          setState('error');
          setHint(result.message || SUBMIT_FAILED_HINT);
          return;
        }

        // Same bookkeeping a real answer does, so the dismissed row leaves and
        // its draft is not left behind for a question that is now terminal.
        setInFlight(false);
        setState('sent');
        clearAnswerDraft(drafts, questionID);
        inputNode.value = '';
      },
      () => {
        setInFlight(false);
        setState('error');
        setHint(SUBMIT_FAILED_HINT);
      },
    );
  }

  function wireDismissControl(control) {
    if (!control)
      return;

    // Hold-to-confirm controls (aeor-confirm-button / aeor-progress-button) emit
    // `confirm`; the plain fallbacks only emit `click`.
    let eventName = control.localName === 'aeor-confirm-button'
      || control.localName === 'aeor-progress-button'
      ? 'confirm'
      : 'click';

    control.addEventListener(eventName, (event) => {
      if (event && typeof event.preventDefault === 'function' && eventName === 'click')
        event.preventDefault();
      if (event && typeof event.stopPropagation === 'function')
        event.stopPropagation();

      requestDismiss();
    });
  }

  wireDismissControl(node.querySelector(`.${DISMISS_CLASS}`));
  wireDismissControl(node.querySelector(`.${DISMISS_CLOSE_CLASS}`));

  function bindSettleControl(target, settleHandlers) {
    let control = target.querySelector(`.${DISMISS_CLOSE_CLASS}`);
    if (!control)
      return;

    let questionID = target.getAttribute('data-question-id') || '';
    let retired = false;

    // Retire the row: tell the list to drop it now. The fuse event and a press
    // both land here, so the row leaves exactly once whichever came first.
    function retire() {
      if (retired)
        return;

      retired = true;
      if (typeof settleHandlers.onSettleExpired === 'function')
        settleHandlers.onSettleExpired(questionID);
    }

    // The component fires this when an untouched fuse runs out, and again as
    // `confirm` when the user presses a still-armed control (duration="0").
    control.addEventListener('auto-complete', retire);
    control.addEventListener('confirm', retire);
  }

  // Defence in depth: any <button> a vendored hold-to-confirm control renders
  // into the light DOM inherits the surrounding form's submit behaviour unless
  // it names a type. Neutralise it here too, so the card stays correct against
  // a vendor build that predates the framework fix. The `submitter` check above
  // is what holds regardless, because these children may not exist yet at bind
  // time — the custom element builds them in its own connectedCallback.
  for (let control of node.querySelectorAll(`.${DISMISS_CLASS}, .${DISMISS_CLOSE_CLASS}`)) {
    for (let nested of control.querySelectorAll('button')) {
      if (nested !== submitNode && !nested.hasAttribute('type'))
        nested.setAttribute('type', 'button');
    }
  }

  function handleKeydown(event) {
    if (!event || event.key !== 'Escape')
      return;

    if (typeof onDismissAnswer !== 'function' && typeof onDismiss !== 'function')
      return;

    // Only abort an untouched box: Escape over typed text would discard work.
    if (normalizeAnswerText(inputNode.value) !== '')
      return;

    requestDismiss();
  }

  formNode.addEventListener('submit', handleSubmit);
  formNode.addEventListener('keydown', handleKeydown);
  if (typeof onRead === 'function')
    inputNode.addEventListener('focus', handleFocus);
}
