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
          ? p.class('kikx-question-frame__answered')(`Answered (${question.status}).`)
          : answerInput,
        answered ? null : submit,
      ).build(document);

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
    app?._submitQuestionAnswer?.(questionID, text);
  }
}

if (!customElements.get('kikx-question-frame'))
  customElements.define('kikx-question-frame', KikxQuestionFrame);
