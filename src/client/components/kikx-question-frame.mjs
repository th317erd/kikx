'use strict';

// The inline `Question` frame (plan §6.5, §9 P3).
//
// A question asked by an agent shows up in the thread where it was asked, so
// the conversation stays readable without jumping to the Inbox. The Inbox is
// the aggregate view; this is the in-context one. Both render the same card so
// there is exactly one answer UI ([D-4]: free-form only).
//
// Registered in BUILT_IN_FRAME_COMPONENTS as `Question` — deferred out of P1
// (§17.3) because registering a module that does not exist breaks the whole
// client load via the bare `await import()` in frame-component-registry.mjs.

import { elements } from '../lib/aeor-ui.mjs';
import {
  canSubmitAnswer,
  DEFAULT_ANSWER_SOURCE,
  isAcknowledgedDefaultAnswer,
  isRevisableDefaultAnswer,
  normalizeAnswerText,
  normalizeContextRefs,
  normalizeQuestionSummary,
  questionAge,
  USER_ANSWER_SOURCE,
} from '../state/questions-state.mjs';
import {
  answerDraftStore,
  clearAnswerDraft,
  getAnswerDraft,
  setAnswerDraft,
} from '../state/question-drafts.mjs';
import { bindDismissControl, buildDismissControl } from './kikx-question-card.mjs';
import {
  buildSettleControl,
  FRAME_ROOT_CLASS,
  INBOX_MODIFIER_CLASS,
  vocabularyFor,
} from './kikx-question-surface.mjs';
import {
  buildAnswerBlock,
  buildAnswerReceipt,
  RECEIPT_CLASSES,
  REVISED_BY_USER_NOTE,
  USER_ANSWER_LABEL,
} from './kikx-answer-receipt.mjs';
import { bindComposerSubmitKeys } from './composer-keyboard.mjs';
import { describeQuestionOrigin } from '../state/question-attribution.mjs';

const { div, li, span, p, form, textarea, button, ul } = elements;


// The receipt labels live in kikx-answer-receipt.mjs, shared with the Inbox
// card, so the two surfaces cannot drift on who an answer is attributed to.
// Only the strings specific to THIS surface stay here: the placeholder and the
// submit label of the "replace this default" box.
const DEFAULT_ANSWER_PLACEHOLDER = 'Write a different answer\u2026';
const DEFAULT_ANSWER_SUBMIT = 'Send different answer';
// The acknowledgement control. Its whole job is to be the cheaper, obviously
// different choice from typing a replacement: "that's right" is one click, and
// it must not look like it sends anything to the agent (it does not).
const DEFAULT_ANSWER_CONFIRM = 'That\u2019s right';
const ACKNOWLEDGED_BY_USER_PLACEHOLDER = 'Confirmed by you \u2014 replace it below if that was wrong.';

// The class vocabulary of a Question surface, and the Inbox row adapter, live in
// their own module (`kikx-question-surface.mjs`): this file is about the answer
// interaction, that one is about which names the surfaces speak. The names are
// re-exported here so every existing import keeps working.
export {
  buildSettleControl,
  FRAME_ROOT_CLASS,
  INBOX_MODIFIER_CLASS,
  INBOX_ROOT_CLASS,
  INBOX_VOCAB,
  FRAME_VOCAB,
  renderInboxQuestionRow,
  vocabularyFor,
} from './kikx-question-surface.mjs';

export class KikxQuestionFrame extends HTMLElement {
  constructor() {
    super();
    this._frame = null;
    this._appState = {};
    // `inboxChrome` switches this frame into the Inbox row's vocabulary and adds
    // the three things only an aggregate row shows: batch position, context
    // references, and the settle fuse.
    this._inboxChrome = false;
    this._groupCount = 1;
    this._now = null;
    this._handlers = null;
  }

  set appState(value) {
    this._appState = value || {};
    if (this._frame)
      this._render();
  }

  set frame(value) {
    this.updateFrame(value, this._appState);
  }

  updateFrame(frame, appState = {}, options = {}) {
    this._frame = frame || null;
    this._appState = appState || {};

    // Read on every render rather than latched once: the Inbox rebuilds a row
    // when its status changes, and a fresh frame is constructed for that row.
    this._inboxChrome = Boolean(options.inboxChrome);
    this._groupCount = Number.isInteger(options.groupCount) && options.groupCount > 0
      ? options.groupCount
      : 1;
    // One clock for a whole list render, so every age label in it agrees.
    this._now = typeof options.now === 'number' && Number.isFinite(options.now)
      ? options.now
      : null;

    // The Inbox view passes handler overrides so a caller can intercept a
    // submit, a dismissal or the draft store. The frame answers through the app
    // by default; when a handler is supplied it wins, because that is the
    // contract `buildInboxList`'s callers and the specs already rely on. Without
    // this bridge the two surfaces would answer through different doors and a
    // spec handing the Inbox an `onSubmit` would silently observe nothing.
    this._handlers = options.handlers || null;

    this._render();
  }

  // The class vocabulary this instance speaks. Every element below resolves its
  // names through here, so a selector written to find a node cannot disagree
  // with the name the builder gave it.
  get _vocab() {
    return vocabularyFor(this._inboxChrome);
  }

  connectedCallback() {
    if (this._frame && this.childNodes.length === 0)
      this._render();
  }

  // The frame content carries the question document (written by ask-user-tool).
  _question() {
    let content = this._frame?.content;
    if (!content || typeof content !== 'object')
      return null;

    return normalizeQuestionSummary(content.question || content);
  }

  // A question that already has an answer shows it. The row used to read
  // "Answered (answered)." — the status, never the answer itself — so the
  // thread could not tell you what you had replied.
  //
  // The receipt is built by the module the Inbox card also uses. What stays here
  // is only the case a receipt cannot express: a terminal question with no
  // words at all, which needs a status line instead of an empty box.
  _answeredBlock(question) {
    let vocab = this._vocab;
    let receipt = buildAnswerReceipt(document, question, vocab.receipts);
    if (receipt)
      return receipt;

    let note = question.status === 'answered'
      ? 'Answered.'
      : `Closed: ${question.status}.`;

    return p.class(vocab.answered)(note);
  }

  _render() {
    this.textContent = '';

    let question = this._question();
    if (!question) {
      let fallback = document.createElement('p');
      fallback.className = this._vocab.missing;
      fallback.textContent = this._frame?.content?.preview || 'Question unavailable.';
      this.appendChild(fallback);
      return;
    }

    let vocab = this._vocab;

    // The frame element always keeps its own name; the Inbox row wrapper (an
    // `<article class="kikx-question-card">`) supplies the row's identity, and
    // this modifier is what a stylesheet can hang Inbox-only layout on.
    this.className = this._inboxChrome
      ? `${FRAME_ROOT_CLASS} ${INBOX_MODIFIER_CLASS}`
      : FRAME_ROOT_CLASS;
    this.dataset.questionID = question.id;

    let closed = question.status !== 'open';
    let settledFor = closed && question.closedAt > 0 && question.settleAfter > 0;

    let age = questionAge(question.askedAt, this._now === null ? undefined : this._now);

    // Build the box eagerly. A DSL builder's `.value` resolves through the
    // proxy chain and yields another builder, never the text a user typed, so
    // reading it in `_submit` always saw "not a string" and silently dropped
    // every answer. Only `.build(document)` produces the DOM node whose
    // `.value` reflects real input.
    let answerInput = textarea
      .class(vocab.input)
      .name('answer')
      .placeholder('Your answer…')
      .build(document);

    // Restore text this box held before the frame was re-rendered, and keep
    // recording it on every keystroke.
    //
    // This node is destroyed and rebuilt by `updateFrame()` — which the chat
    // view calls on every refresh, including the resync after a dropped
    // runtime-events socket reopens. The DOM value dies with the node, so
    // without a store outside the DOM, connecting / reconnecting / switching
    // sessions silently threw away whatever the user had typed. The Inbox card
    // has had exactly this protection (`kikx-question-card.mjs`); the inline
    // frame — the surface the user actually answers in, in the transcript — was
    // never wired to the store, so it was the one place text vanished.
    let drafts = this._drafts();
    let drafted = getAnswerDraft(drafts, question.id);
    if (drafted !== '')
      answerInput.value = drafted;

    if (typeof answerInput.addEventListener === 'function') {
      answerInput.addEventListener('input', () => {
        setAnswerDraft(drafts, question.id, answerInput.value);
      });
    }

    // The box sits in a <form>, where a textarea's Enter inserts a newline and
    // never submits. Bind the shared composer rule so Enter sends here too.
    // Re-entering while a send is in flight is ignored: _submit has no re-entry
    // guard of its own, so the guard lives in the one place that can see it.
    bindComposerSubmitKeys(answerInput, () => {
      if (this.getAttribute?.('data-answer-state') === 'busy')
        return;
      this._submit(question.id, answerInput);
    });

    // The unread badge clears when the person first LOOKS at the box, not when
    // the Inbox renders the row: a row scrolled past is not a row read. One
    // shot. It lives here because the frame is now the only surface that
    // renders an answer box -- the card's binder is no longer called, so
    // without this the badge would never clear at all.
    if (typeof answerInput.addEventListener === 'function') {
      let markedRead = false;
      answerInput.addEventListener('focus', () => {
        if (markedRead)
          return;

        let onRead = this._handlers?.onRead;
        if (typeof onRead !== 'function')
          return;

        markedRead = true;
        onRead(question.id);
      });
    }

    // A default answer that no person has taken over is NOT a closed row.
    // The agent's fallback fired because nobody replied, so the person it spoke
    // for is entitled to replace it. Every other terminal row stays read-only:
    // offering a box the server would refuse with a 409 is worse than showing
    // what was answered.
    let answered = question.status !== 'open';
    let revisable = isRevisableDefaultAnswer(question);
    let editable = !answered || revisable;
    let submitLabel = revisable ? DEFAULT_ANSWER_SUBMIT : 'Answer';
    this._submitLabel = submitLabel;

    // A confirmed row keeps its box only so a mistake stays fixable, and it says
    // so: "replace it below if that was wrong" is the true statement, whereas the
    // plain "write a different answer" placeholder would imply the default is
    // still unconfirmed.
    if (revisable && answerInput.setAttribute) {
      answerInput.setAttribute('placeholder', isAcknowledgedDefaultAnswer(question)
        ? ACKNOWLEDGED_BY_USER_PLACEHOLDER
        : DEFAULT_ANSWER_PLACEHOLDER);
    }

    let submit = button
      .type('button')
      .class(vocab.submit)
      .onClick(() => this._submit(question.id, answerInput))(submitLabel);

    // The acknowledgement. Separate control, separate intent: no text is read
    // from the box, because the answer it affirms already exists. Without this
    // the only way to say "the default was right" was to retype the default,
    // which the server cannot tell apart from a correction — so a one-word
    // agreement woke the agent to be told nothing new.
    let confirm = (revisable && !isAcknowledgedDefaultAnswer(question))
      ? button
        .type('button')
        .class(vocab.confirm)
        .onClick(() => this._confirm(question.id))(DEFAULT_ANSWER_CONFIRM)
      : null;

    // The frame used to offer only Answer, which meant a question asked inline
    // in a session could not be dismissed without opening the Inbox. The owner's
    // screenshot made the inconsistency plain: "there is no reason a question
    // frame shouldn't have a Dismiss and X close button." Both are the same
    // hold-to-confirm controls the Inbox card renders, built by the same code.
    let ownerDocument = this.ownerDocument || (typeof document === 'undefined' ? null : document);
    let closeControl = null;
    if (ownerDocument && settledFor && this._inboxChrome)
      closeControl = buildSettleControl(ownerDocument, question.settleAfter, vocab.settle);
    else if (ownerDocument && !answered)
      closeControl = buildDismissControl(ownerDocument, 'close').node;
    let dismissControl = answered || !ownerDocument ? null : buildDismissControl(ownerDocument, 'text').node;

    // Whoever asked is named, not numbered: the same attribution the Inbox card
    // uses, so the two surfaces cannot disagree about who is waiting on you.
    let origin = describeQuestionOrigin(this._appState?.app?._state, question);

    // Feedback lives in the frame as well as the Inbox card. `_submit` is what
    // wires these; they are built here because the DSL cannot reach a node it
    // has already returned.
    let hint = span.class(vocab.hint);

    // A terminal question is shown read-only: the answer already exists, and
    // offering a box that would 409 is worse than showing what was said.
    //
    // The ONE exception is `editable` above: an answer that only a DEFAULT
    // supplied has nobody behind it, so its question stays open to correction.
    // The batch position ("2 of 3") belongs to the aggregate view: a question
    // arriving alone in a thread has nothing to be positioned against.
    let position = (this._inboxChrome && this._groupCount > 1 && question.index)
      ? span.class(vocab.position)(`${question.index} of ${this._groupCount}`)
      : null;

    // Frame-of-reference references, likewise Inbox-only: they orient a row
    // among many, where the thread already has the conversation around it.
    let refs = this._inboxChrome ? normalizeContextRefs(question.contextRefs) : [];
    let refList = refs.length === 0
      ? null
      : ul.class(vocab.refs)(
        refs.map((ref) => li.class(vocab.ref)(ref.label || `${ref.type} ${ref.id}`)),
      );

    let node = form.class(vocab.form)
      .onSubmit((event) => {
        event.preventDefault?.();
        this._submit(question.id, answerInput);
      })(
        div.class(vocab.meta)(
          span.class(vocab.agent)(origin.text),
          position,
          age ? span.class(vocab.age)(age) : null,
          question.priority === 'high'
            ? span.class(vocab.priority)('high')
            : null,
          // The round close sits at the end of the meta row, exactly as it does
          // on the Inbox card: the question can be dismissed without scrolling
          // down to the answer box. Only an open question offers it — a terminal
          // one has nothing left to dismiss.
          closeControl,
        ),
        p.class(vocab.text)(question.text),
        refList,
        answered ? this._answeredBlock(question) : null,
        editable ? answerInput : null,
        editable ? div.class(vocab.actions)(submit, confirm, dismissControl, hint.hidden(true).ariaLive('polite')()) : null,
      ).build(document);

    this._submitNode = node.querySelector(`.${vocab.submit}`);
    this._inputNode = answerInput;
    this.appendChild(node);

    // A dismissal is an answer with `silent: true`, never the `/dismiss` route
    // (that one is the asking agent withdrawing). The app owns the call; the
    // frame only reports intent, and reports a failure instead of pretending.
    let requestDismiss = () => this._dismiss(question.id);

    // The fuse retires the row. It is NOT a dismissal.
    //
    // These used to be one handler, and that is a bug with teeth: a press on a
    // draining receipt would have run the dismissal path, which records
    // "<User chose not to respond>" as the answer -- overwriting the answer the
    // person actually gave. A window running out does not mean they declined.
    // So the fuse reports `onSettleExpired` and leaves the answer alone.
    //
    // The component fires `auto-complete` when an untouched ring runs out, and
    // `confirm` when the user presses a still-armed one (`duration="0"`). Both
    // mean the same thing here: the row has had its window and leaves.
    if (settledFor && this._inboxChrome) {
      let requestSettle = () => this._settle(question.id);
      closeControl?.addEventListener?.('auto-complete', requestSettle);
      closeControl?.addEventListener?.('confirm', requestSettle);
    } else {
      bindDismissControl(closeControl, requestDismiss);
    }

    // A settled row renders no text-dismiss control (`dismissControl` is null
    // once the question is terminal), so this binds nothing rather than
    // needing a branch.
    bindDismissControl(dismissControl, requestDismiss);

    // Escape abandons a question the person has not started answering. Only an
    // untouched box: Escape over typed text would throw that work away, which
    // is not what the key means to anyone. Gated on `editable` because a
    // terminal row has nothing left to abandon.
    if (editable && typeof node.addEventListener === 'function') {
      node.addEventListener('keydown', (event) => {
        if (event?.key !== 'Escape')
          return;

        if (normalizeAnswerText(answerInput.value) !== '')
          return;

        requestDismiss();
      });
    }
  }

  // The app owns the store so the Inbox card and this frame share one draft per
  // question id: a half-typed answer must be the same text whichever surface
  // you come back to it through.
  _drafts() {
    if (this._handlers?.drafts)
      return this._handlers.drafts;

    let app = this._appState?.app || this.closest?.('kikx-app');
    return answerDraftStore(app || this);
  }

  // "The default was right." Carries no text: the answer being affirmed is
  // already stored, and retyping it is what made this indistinguishable from a
  // correction. Sends the declared intent, which is the only thing that decides
  // whether the asking agent is woken.
  _confirm(questionID) {
    let app = this._appState?.app || this.closest?.('kikx-app');
    let pending = typeof this._handlers?.onSubmit === 'function'
      ? this._handlers.onSubmit(questionID, '', { intent: 'confirm' })
      : app?._submitQuestionAnswer?.(questionID, '', { intent: 'confirm' });

    if (!pending || typeof pending.then !== 'function')
      return;

    this._setPhase('busy');
    pending.then(
      (result) => {
        if (result && result.ok === false) {
          this._setPhase('error', result.message || 'Could not confirm the answer.');
          return;
        }

        // Painted WITHOUT an answer block: a confirmation changes no text, so
        // appending one would invent a "Your answer" line holding the empty
        // string. The receipt is what changes, and it changes by re-reading the
        // question — never by printing words the person did not write.
        this._setPhase('sent', result?.message || '', '', { paintAnswer: false });
      },
      () => this._setPhase('error', 'Could not confirm the answer.'),
    );
  }

  _submit(questionID, answerInput, options = {}) {
    let text = normalizeAnswerText(answerInput?.value);
    if (!canSubmitAnswer(text))
      return;

    // The app owns the network call; the frame only reports intent. If there is
    // no app (a frame rendered standalone in a spec), do nothing rather than
    // throwing inside an event handler.
    let app = this._appState?.app || this.closest?.('kikx-app');
    // An Inbox caller may supply its own submit handler; when it does, it wins
    // over the app method, because that is the contract `buildInboxList`'s
    // callers (and the specs that drive them) already rely on.
    let handler = typeof this._handlers?.onSubmit === 'function'
      ? this._handlers.onSubmit
      : null;
    // A revision of a delivered default is a CHANGE: the user typed text that
    // differs from what was applied, so the asking agent has to learn its
    // default was wrong. An ordinary first answer carries no intent at all and
    // goes through the unchanged path.
    // `options.intent` stays undefined for an ordinary answer, so JSON drops the
    // key and the normal path is byte-for-byte what it was.
    let pending = handler
      ? handler(questionID, text, options.intent ? { intent: options.intent } : undefined)
      : app?._submitQuestionAnswer?.(questionID, text, options.intent ? { intent: options.intent } : undefined);

    // The frame used to drop this promise on the floor: no busy state, no
    // confirmation, and a failure looked exactly like a send. It now owns the
    // same phase change the Inbox card does, because the answer row stays on
    // screen here and would otherwise reset with no explanation.
    if (!pending || typeof pending.then !== 'function')
      return;

    // Busy carries no message: the button already says "Sending…", and setting
    // the hint to the same words printed the status twice, side by side.
    this._setPhase('busy');
    pending.then(
      (result) => {
        if (result && result.ok === false) {
          this._setPhase('error', result.message || 'Could not send the answer.');
          return;
        }

        clearAnswerDraft(this._drafts(), questionID);
        this._setPhase('sent', result?.message || '', text);
      },
      (error) => {
        let message = typeof error?.message === 'string' && error.message !== ''
          ? `Could not send the answer: ${error.message}`
          : 'Could not send the answer.';
        this._setPhase('error', message);
      },
    );
  }

  // Dismiss a question from the inline frame.
  //
  // A dismissal is NOT the `/dismiss` route — that one is the asking agent
  // withdrawing its own question, the opposite direction. It is an answer
  // carrying the no-response marker with `silent: true`, which is what keeps the
  // agent from being woken. The app owns that call; this method only reports
  // intent and then reports the outcome honestly, because a dismissal the server
  // rejected must not look like one it accepted.
  _dismiss(questionID) {
    if (!questionID)
      return;

    let app = this._appState?.app || this.closest?.('kikx-app');
    let pending = typeof this._handlers?.onDismissAnswer === 'function'
      ? this._handlers.onDismissAnswer(questionID)
      : app?._dismissQuestionAnswer?.(questionID);

    // No app, or a call that already answered synchronously: nothing left to
    // report. A frame rendered standalone in a spec must not throw here.
    if (!pending || typeof pending.then !== 'function')
      return;

    this._setPhase('busy');
    pending.then(
      (result) => {
        if (result && result.ok === false) {
          this._setPhase('dismiss-error', result.message || 'Could not dismiss the question.');
          return;
        }

        clearAnswerDraft(this._drafts(), questionID);
        this._setPhase('dismissed');
      },
      (error) => {
        let message = typeof error?.message === 'string' && error.message !== ''
          ? `Could not dismiss the question: ${error.message}`
          : 'Could not dismiss the question.';
        this._setPhase('dismiss-error', message);
      },
    );
  }

  // The receipt window ran out, or the person pressed the still-draining ring
  // to end it now. The row has been on screen for its full window and leaves.
  //
  // Deliberately NOT `_dismiss`: a dismissal records "chose not to respond" as
  // the answer and would overwrite what the person already said. The Inbox list
  // owns removal, so this only reports intent -- and with no settle handler (a
  // frame rendered standalone in a spec, or a thread, which has no list to
  // retire from) it does nothing rather than inventing a dismissal.
  _settle(questionID) {
    if (typeof this._handlers?.onSettleExpired === 'function') {
      this._handlers.onSettleExpired(questionID);
      return;
    }

    let app = this._appState?.app || this.closest?.('kikx-app');
    if (typeof app?._settleQuestionAnswer === 'function')
      app._settleQuestionAnswer(questionID);
  }

  // What a sent answer looks like: the question stays in the thread, the box and
  // its control are gone, and the text the user wrote is shown in its place.
  // Leaving an enabled "Answer sent" button next to a live textarea invited the
  // user to answer a question twice.
  _showSent(answerText) {
    let vocab = this._vocab;
    let card = this.querySelector?.(`.${vocab.form}`);
    if (!card)
      return;

    // A revision of a delivered default: the green receipt already on screen
    // must STAY. The user is entitled to see what was delivered on their
    // behalf as well as what they replaced it with, so the new answer is
    // appended under the default rather than painted over it.
    if (this._defaultReceiptNode()) {
      this._removeAnswerForm(card);
      card.appendChild(buildAnswerBlock(document, answerText, {
        label: USER_ANSWER_LABEL,
        source: USER_ANSWER_SOURCE,
        note: REVISED_BY_USER_NOTE,
      }, vocab.receipts));
      return;
    }

    // A full re-render already paints the answer block as soon as the question
    // reaches a terminal status, and the socket can deliver that status before
    // this promise settles. When it does, appending here put a SECOND, identical
    // "Your answer" block under the first one — the screenshot that prompted
    // this fix. The render path always shows the answer the question document
    // holds, so when a block is already on screen there is nothing left to add.
    if (this._answeredBlockNode())
      return;

    this._removeAnswerForm(card);
    card.appendChild(buildAnswerBlock(document, answerText, {}, vocab.receipts));
  }

  // Drop the answer box and its control row from a card. Used once a send
  // succeeds: the row is a record from then on, and leaving a live textarea
  // beside it invites a second submission into a 409.
  _removeAnswerForm(card) {
    let vocab = this._vocab;
    for (let selector of [ `.${vocab.input}`, `.${vocab.actions}` ]) {
      for (let stale of [ ...(card.querySelectorAll?.(selector) || []) ]) {
        if (stale?.parentNode)
          stale.parentNode.removeChild(stale);
      }
    }
  }

  // Whether this frame is already showing an answer block. Scoped to its own
  // subtree: one frame is one question, and a neighbouring card must never make
  // this one believe it is already answered.
  _answeredBlockNode() {
    return this.querySelector?.(`.${this._vocab.answerText}`) || null;
  }

  // Whether this frame is showing a receipt for a default answer. Scoped the
  // same way, and distinct from _answeredBlockNode so _showSent can keep the
  // default visible while still replacing the form.
  _defaultReceiptNode() {
    return this.querySelector?.('[data-answer-source="default"]') || null;
  }

  // One phase setter for three states: idle, busy, error/sent. The attribute is
  // what the stylesheet and the specs hook into; the label is the part a user
  // reads.
  _setPhase(phase, message = '', answerText = '', options = {}) {
    let submitNode = this._submitNode;
    let inputNode = this._inputNode;

    // A sent row has no control left to describe: the form is replaced by the
    // answer. Only the busy and error phases still have a button to relabel.
    if (submitNode && phase !== 'sent') {
      submitNode.textContent = phase === 'busy' ? 'Sending\u2026' : (this._submitLabel || 'Answer');
      if (phase === 'busy')
        submitNode.setAttribute?.('disabled', '');
      else
        submitNode.removeAttribute?.('disabled');
    }

    if (inputNode && inputNode.setAttribute) {
      if (phase === 'busy')
        inputNode.setAttribute('readonly', '');
      else
        inputNode.removeAttribute?.('readonly');
    }

    if (phase === 'sent' && options.paintAnswer !== false)
      this._showSent(answerText);

    this.setAttribute('data-answer-state', phase);
    this.setAttribute('aria-busy', phase === 'busy' ? 'true' : 'false');

    let hint = this.querySelector?.(`.${this._vocab.hint}`);
    if (hint) {
      if (message) {
        hint.textContent = message;
        hint.removeAttribute('hidden');
      } else {
        hint.textContent = '';
        hint.setAttribute('hidden', '');
      }
    }
  }
}

if (!customElements.get('kikx-question-frame'))
  customElements.define('kikx-question-frame', KikxQuestionFrame);
