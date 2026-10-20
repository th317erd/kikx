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
  normalizeAnswerText,
  normalizeQuestionSummary,
  questionAge,
} from '../state/questions-state.mjs';

const { div, span, p, form, textarea, button } = elements;

export class KikxQuestionFrame extends HTMLElement {
  constructor() {
    super();
    this._frame = null;
    this._appState = {};
  }

  set appState(value) {
    this._appState = value || {};
    if (this._frame)
      this._render();
  }

  set frame(value) {
    this.updateFrame(value, this._appState);
  }

  updateFrame(frame, appState = {}) {
    this._frame = frame || null;
    this._appState = appState || {};
    this._render();
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
  _answeredBlock(question) {
    let answer = typeof question.answer === 'string' ? question.answer.trim() : '';
    if (answer === '') {
      // "Answered (answered)." said the same word twice and never said what was
      // said. A closed row now names its state plainly.
      let note = question.status === 'answered'
        ? 'Answered.'
        : `Closed: ${question.status}.`;
      return p.class('kikx-question-frame__answered')(note);
    }

    return div.class('kikx-question-frame__answer-given')(
      span.class('kikx-question-frame__answer-label')('Your answer'),
      div.class('kikx-question-frame__answer-text')(answer),
    );
  }

  _render() {
    this.textContent = '';

    let question = this._question();
    if (!question) {
      let fallback = document.createElement('p');
      fallback.className = 'kikx-question-frame__missing';
      fallback.textContent = this._frame?.content?.preview || 'Question unavailable.';
      this.appendChild(fallback);
      return;
    }

    this.className = 'kikx-question-frame';
    this.dataset.questionID = question.id;

    let age = questionAge(question.askedAt);

    // Build the box eagerly. A DSL builder's `.value` resolves through the
    // proxy chain and yields another builder, never the text a user typed, so
    // reading it in `_submit` always saw "not a string" and silently dropped
    // every answer. Only `.build(document)` produces the DOM node whose
    // `.value` reflects real input.
    let answerInput = textarea
      .class('kikx-question-frame__answer')
      .name('answer')
      .placeholder('Your answer…')
      .build(document);

    let submit = button
      .type('button')
      .class('kikx-question-frame__submit')
      .onClick(() => this._submit(question.id, answerInput))('Answer');

    // Feedback lives in the frame as well as the Inbox card. `_submit` is what
    // wires these; they are built here because the DSL cannot reach a node it
    // has already returned.
    let hint = span.class('kikx-question-frame__hint');

    // A terminal question is shown read-only: the answer already exists, and
    // offering a box that would 409 is worse than showing what was said.
    let answered = question.status !== 'open';

    let node = form.class('kikx-question-frame__card')
      .onSubmit((event) => {
        event.preventDefault?.();
        this._submit(question.id, answerInput);
      })(
        div.class('kikx-question-frame__meta')(
          span.class('kikx-question-frame__agent')(question.agentID || 'agent'),
          age ? span.class('kikx-question-frame__age')(age) : null,
          question.priority === 'high'
            ? span.class('kikx-question-frame__priority')('high')
            : null,
        ),
        p.class('kikx-question-frame__text')(question.text),
        answered
          ? this._answeredBlock(question)
          : answerInput,
        answered ? null : div.class('kikx-question-frame__actions')(hint.hidden(true).ariaLive('polite')(), submit),
      ).build(document);

    this._submitNode = node.querySelector('.kikx-question-frame__submit');
    this._inputNode = answerInput;
    this.appendChild(node);
  }

  _submit(questionID, answerInput) {
    let text = normalizeAnswerText(answerInput?.value);
    if (!canSubmitAnswer(text))
      return;

    // The app owns the network call; the frame only reports intent. If there is
    // no app (a frame rendered standalone in a spec), do nothing rather than
    // throwing inside an event handler.
    let app = this._appState?.app || this.closest?.('kikx-app');
    let pending = app?._submitQuestionAnswer?.(questionID, text);

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

  // What a sent answer looks like: the question stays in the thread, the box and
  // its control are gone, and the text the user wrote is shown in its place.
  // Leaving an enabled "Answer sent" button next to a live textarea invited the
  // user to answer a question twice.
  _showSent(answerText) {
    let card = this.querySelector?.('.kikx-question-frame__card');
    if (!card)
      return;

    for (let selector of [ '.kikx-question-frame__answer', '.kikx-question-frame__actions' ]) {
      let stale = card.querySelector?.(`.${selector.replace('.', '')}`)
        || this.querySelector?.(selector);
      if (stale?.parentNode)
        stale.parentNode.removeChild(stale);
    }

    let block = div.class('kikx-question-frame__answer-given')(
      span.class('kikx-question-frame__answer-label')('Your answer'),
      div.class('kikx-question-frame__answer-text')(answerText),
    ).build(document);

    card.appendChild(block);
  }

  // One phase setter for three states: idle, busy, error/sent. The attribute is
  // what the stylesheet and the specs hook into; the label is the part a user
  // reads.
  _setPhase(phase, message = '', answerText = '') {
    let submitNode = this._submitNode;
    let inputNode = this._inputNode;

    // A sent row has no control left to describe: the form is replaced by the
    // answer. Only the busy and error phases still have a button to relabel.
    if (submitNode && phase !== 'sent') {
      submitNode.textContent = phase === 'busy' ? 'Sending\u2026' : 'Answer';
      if (phase === 'busy')
        submitNode.setAttribute?.('disabled', '');
      else
        submitNode.removeAttribute?.('disabled');
    }

    if (inputNode && phase === 'busy' && inputNode.setAttribute)
      inputNode.setAttribute('readonly', '');

    if (phase === 'sent')
      this._showSent(answerText);

    this.setAttribute('data-answer-state', phase);
    this.setAttribute('aria-busy', phase === 'busy' ? 'true' : 'false');

    let hint = this.querySelector?.('.kikx-question-frame__hint');
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
