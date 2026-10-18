'use strict';

// The pinned Inbox surface (plan §6.1-6.2).
//
// Lives in its own module rather than kikx-shell-builders.mjs: that file is
// already past the 500-line soft limit, and the sidebar + inbox rendering is a
// self-contained concern that does not need the shell builder's closure.
//
// Layout (plan §6.1):
//   Sidebar (global overview)     Main column
//     [Inbox (N)]  <- pinned        Inbox list (oldest first)
//     Projects
//       Project -> Session -> Sub-session
//
// The sidebar entry is the glance; the list is the detail ([D-2]). Nothing here
// fetches — `fetchQuestions` owns that, called on load/connect (plan §6.6).

import { elements } from '../lib/aeor-ui.mjs';
import { guardClientOperation } from '../lib/error-boundary.mjs';
import {
  getQuestionsState,
  getSessions,
  isInboxOpen,
  navigateInbox,
} from '../state/kikx-state.mjs';
import { buildInboxList, inboxHeader } from './kikx-inbox-list.mjs';
import {
  canSubmitAnswer,
  groupHeading,
  groupQuestions,
  normalizeAnswerText,
  normalizeQuestionList,
  questionAge,
  unreadQuestionCount,
} from '../state/questions-state.mjs';

const { div, section, header, h2, h3, p, span, button, form, textarea } = elements;

// --- Sidebar ---------------------------------------------------------------

/**
 * The pinned Inbox button. Returns a node the shell drops into the sidebar
 * header above the session tree.
 *
 * The badge counts *unread* open questions, not all open ones: a row the user
 * already looked at still needs answering, but it must not keep pulling
 * attention back (see unreadQuestionCount).
 */
export function buildInboxSidebarEntry(app) {
  return guardClientOperation('kikx-inbox.sidebar', () => {
    let questionsState = getQuestionsState(app._state);
    let questions = questionsState.questions || [];
    let unread = unreadQuestionCount(questions);
    let selected = isInboxOpen(app._state);

    return button
      .type('button')
      .class(`kikx-sidebar__inbox${selected ? ' kikx-sidebar__inbox--active' : ''}`)
      .ariaLabel(unread > 0 ? `Inbox, ${unread} unread questions` : 'Inbox')
      .onClick(() => {
        navigateInbox(app._state);
        app._requestRender();
      })(
        span.class('kikx-sidebar__inbox-label')('Inbox'),
        unread > 0
          ? span.class('kikx-sidebar__inbox-badge')(String(unread))
          : null,
      ).build(document);
  }, { surface: 'sidebar' }) || div.class('kikx-sidebar__inbox')().build(document);
}

// --- Inbox view ------------------------------------------------------------

/**
 * The Inbox list, rendered in the main column.
 *
 * Rows come from the shared questions model, so an event-driven update and a
 * fetch-on-connect update produce identical markup. `kikx-inbox-list.mjs`
 * provides the list + cards; this wrapper owns the heading and the empty state
 * so the sidebar's badge and the list can never disagree about what counts.
 */
export function buildInboxView(app, options = {}) {
  return guardClientOperation('kikx-inbox.view', () => {
    let questionsState = getQuestionsState(app._state);
    let questions = normalizeQuestionList(questionsState.questions || []);

    // The list only wires its answer forms when it is handed handlers
    // (`kikx-inbox-list.mjs` requires at least one of onSubmit/onDismiss/onRead
    // before calling `bindAnswerForm`). The shell builds this view with no
    // options at all (`kikx-shell-builders.mjs:236`), so without these defaults
    // every card renders a textarea and a button that do nothing. Defaults live
    // here rather than in the shell so the Inbox stays the single owner of its
    // own wiring; callers may still override any handler via `options.handlers`.
    let handlers = {
      onSubmit: (questionID, answerText) => app._submitQuestionAnswer?.(questionID, answerText),
      onDismiss: (questionID) => app._dismissQuestion?.(questionID),
      onRead: (questionID) => app._markQuestionRead?.(questionID),
      ...(options.handlers || {}),
    };

    let body = options.renderList
      ? options.renderList(app)
      : buildInboxList(app, handlers);

    return section.class('kikx-inbox')(
      inboxHeader(app),
      questions.length === 0 ? buildInboxEmptyState() : body,
    ).build(document);
  }, { surface: 'inbox' }) || section.class('kikx-inbox')(h2('Inbox')).build(document);
}

export function buildInboxEmptyState() {
  return div.class('kikx-inbox__empty')(
    p('Nothing waiting on you.'),
    p.class('kikx-inbox__empty-hint')('When an agent needs an answer, it lands here.'),
  );
}

// Minimal grouped list used when the rich renderer is unavailable (and by
// specs). Mirrors kikx-inbox-list.mjs's grouping so the two cannot drift in
// ordering or headings.
function buildFallbackList(app, questions) {
  let groups = groupQuestions(questions);

  return div.class('kikx-inbox__list')(
    groups.map((group) => {
      let heading = groupHeading(group);

      return div.class('kikx-inbox__group')(
        heading ? h3.class('kikx-inbox__group-heading')(heading) : null,
        group.questions.map((question) => buildFallbackCard(app, question)),
      );
    }),
  );
}

function buildFallbackCard(app, question) {
  let age = questionAge(question.askedAt);

  // NB: no `.rows()` — the DSL kebab-cases attribute chains, and `rows` is a
  // plain HTML name. Size the box in CSS instead; `.placeholder()` is a real
  // chain used elsewhere in the shell builders.
  let answerBox = textarea
    .class('kikx-inbox__answer')
    .name('answer')
    .placeholder('Your answer…')();

  let submit = button
    .type('button')
    .class('kikx-inbox__submit')
    .onClick(() => app._submitQuestionAnswer?.(question.id, answerBox.value))('Answer');

  return form.class('kikx-inbox__card')
    .onSubmit((event) => {
      event.preventDefault?.();
      app._submitQuestionAnswer?.(question.id, answerBox.value);
    })(
      div.class('kikx-inbox__card-meta')(
        span.class('kikx-inbox__card-agent')(question.agentID || 'agent'),
        age ? span.class('kikx-inbox__card-age')(age) : null,
      ),
      p.class('kikx-inbox__card-text')(question.text),
      answerBox,
      submit,
    );
}

// --- Controller ------------------------------------------------------------

/**
 * In-place repaint hook, mirroring `syncSessionShell`'s contract: return `true`
 * only when something was actually repainted, so the caller falls back to a
 * full `_requestRender()` when we did not handle it. A full rebuild on every
 * `question.*` event would fight the frame batch and lose composer focus.
 */
export function syncQuestionShell(app) {
  let badge = app.querySelector?.('.kikx-sidebar__inbox');
  if (!badge)
    return false;

  let questionsState = getQuestionsState(app._state);
  let unread = unreadQuestionCount(questionsState.questions || []);

  let badgeNode = badge.querySelector?.('.kikx-sidebar__inbox-badge');
  if (unread > 0) {
    if (badgeNode)
      badgeNode.textContent = String(unread);
    else
      return false; // Shape changed (0 -> N); needs a rebuild to add the node.
  } else if (badgeNode) {
    return false; // Shape changed (N -> 0); needs a rebuild to drop the node.
  }

  // The inbox list is only on screen when the inbox entry is selected; a badge
  // update elsewhere must not force the list to re-render.
  if (!app.querySelector?.('.kikx-inbox'))
    return true;

  return false;
}

// Answer submission lives here, not on the app class, so the app keeps only a
// one-line delegate and the network shape stays next to the view that uses it.
export async function submitQuestionAnswer(app, questionID, answerText, options = {}) {
  let text = normalizeAnswerText(answerText);
  if (!canSubmitAnswer(text))
    return { ok: false, reason: 'empty' };

  let postJSON = options.postJSON || ((url, body) => app._postJSON(url, body));

  try {
    let result = await postJSON(`/api/v1/questions/${encodeURIComponent(questionID)}/answer`, {
      answer: text,
    });

    let payload = result?.data || result || {};
    // The server answers 200 even when delivery failed: the answer is durable
    // and `delivered` distinguishes the two cases (see question-routes.mjs).
    let questionsState = getQuestionsState(app._state);
    questionsState.questions = (questionsState.questions || [])
      .filter((question) => question.id !== questionID);
    questionsState.counts = {
      ...(questionsState.counts || {}),
      open: questionsState.questions.length,
    };

    app._requestRender?.();
    return { ok: true, delivered: payload.delivered !== false, payload };
  } catch (error) {
    return { ok: false, reason: 'error', error };
  }
}

export async function markQuestionRead(app, questionID) {
  try {
    await app._postJSON(`/api/v1/questions/${encodeURIComponent(questionID)}/read`, {});
  } catch (_ignored) {
    // Clearing the unread badge is cosmetic; a failure must not surface as an
    // error dialog or block answering.
    return false;
  }

  return true;
}

export async function dismissQuestion(app, questionID, reason = '') {
  try {
    await app._postJSON(`/api/v1/questions/${encodeURIComponent(questionID)}/dismiss`, {
      reason: reason || undefined,
    });
  } catch (_ignored) {
    return false;
  }

  let questionsState = getQuestionsState(app._state);
  questionsState.questions = (questionsState.questions || [])
    .filter((question) => question.id !== questionID);
  app._requestRender?.();
  return true;
}
