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
import { announceAnswerStatus } from './answer-notice.mjs';
import { buildInboxList, inboxEmptyState, inboxHeader, syncInboxList } from './kikx-inbox-list.mjs';
import {
  applyLocalAnswer,
  applyLocalDismiss,
  applyLocalRead,
  captureSettlementTarget,
  revertLocalSettlement,
} from '../state/questions-local-state.mjs';
import { answerDraftStore } from '../state/question-drafts.mjs';
import {
  canSubmitAnswer,
  expiredSettledQuestions,
  groupHeading,
  groupQuestions,
  NO_RESPONSE_ANSWER_TEXT,
  normalizeAnswerText,
  normalizeQuestionList,
  questionAge,
  retireQuestion,
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
/**
 * The handlers every Inbox card needs, in one place.
 *
 * `buildInboxView` and `syncQuestionShell` must bind identical behaviour: the
 * in-place repaint creates cards for questions that arrived after the original
 * render, and those cards need the same wiring or they render a dead box.
 */
// How long a settled row stays on screen, counting down, before it leaves.
// One constant, used both to drive the fuse and to decide expiry, so the two can
// never disagree about when the receipt ends.
export const SETTLE_WINDOW_MS = 60000;

/**
 * Drop every settled row whose receipt window has elapsed.
 *
 * Idempotent and cheap: it reads deadlines out of the data rather than relying
 * on one timer per row, so it is safe to call from a repaint, an event or a
 * tick. Expiry is therefore decided by the deadline, never by whether a timer
 * happened to survive a rebuild.
 */
export function retireExpiredQuestionRows(app) {
  let questionsState = getQuestionsState(app._state);
  let expired = expiredSettledQuestions(questionsState.questions || []);
  if (expired.length === 0)
    return [];

  let remaining = questionsState.questions || [];
  for (let questionID of expired)
    remaining = retireQuestion(remaining, questionID);

  questionsState.questions = remaining;
  return expired;
}

/**
 * Repaint after a local settlement change: in place when possible, and only
 * falling back to a full render when the list shape genuinely changed.
 *
 * Used on BOTH edges of an optimistic close — the settle and the rollback — so
 * the two can never disagree about how the change is shown.
 */
function repaintQuestionShell(app) {
  if (!app._syncQuestionShell?.())
    app._requestRender?.();
}

export function questionAnswerHandlers(app, overrides = {}) {
  return {
    onSubmit: (questionID, answerText) => app._submitQuestionAnswer?.(questionID, answerText),
    onDismiss: (questionID) => app._dismissQuestion?.(questionID),
    // The user declining to answer. Distinct from `onDismiss` above, which is the
    // asker withdrawing its own question.
    onDismissAnswer: (questionID) => app._dismissQuestionAnswer?.(questionID),
    // The receipt's fuse ran out, or the user pressed it to close now. Either
    // way the row has had its full window and leaves.
    onSettleExpired: (questionID) => {
      let questionsState = getQuestionsState(app._state);
      questionsState.questions = retireQuestion(questionsState.questions || [], questionID);
      if (!app._syncQuestionShell?.())
        app._requestRender?.();
    },
    onRead: (questionID) => app._markQuestionRead?.(questionID),
    // Typed-but-unsent answers, restored whenever a card is re-created. Held on
    // the app so every route that rebuilds the Inbox (shell render, view sync,
    // fallback full render) reads and writes the same store — a module-level Map
    // would leak drafts between apps, and a per-render Map would be empty
    // exactly when it is needed.
    drafts: answerDraftStore(app),
    ...overrides,
  };
}

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
    let handlers = questionAnswerHandlers(app, options.handlers || {});

    let body = options.renderList
      ? options.renderList(app)
      : buildInboxList(app, handlers);

    return section.class('kikx-inbox')(
      inboxHeader(app),
      questions.length === 0 ? inboxEmptyState(app) : body,
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


// The builder needs an owner document; tests may pass a bare owner object.
function resolveDocument(app) {
  if (app && app.ownerDocument)
    return app.ownerDocument;

  return typeof document === 'undefined' ? null : document;
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
  let inbox = app.querySelector?.('.kikx-inbox');

  // Neither surface rendered means this tab is not showing questions at all;
  // report that honestly so the caller does whatever it would do anyway.
  if (!badge && !inbox)
    return false;

  let questionsState = getQuestionsState(app._state);
  let unread = unreadQuestionCount(questionsState.questions || []);

  // A missing badge is not a shape change to report — the badge is simply not
  // on screen. Returning `false` here used to force a full rebuild, which is
  // what destroyed typed-but-unsent answers.
  let badgeNode = badge?.querySelector?.('.kikx-sidebar__inbox-badge') || null;

  // Add or drop the badge node in place rather than reporting a shape change.
  // The worst case this caused: answering the last unread question took the
  // count to zero, which read as a shape change and triggered a rebuild.
  if (badge) {
    if (unread > 0) {
      if (!badgeNode) {
        let ownerDocument = resolveDocument(app);
        if (ownerDocument) {
          badgeNode = ownerDocument.createElement('span');
          badgeNode.className = 'kikx-sidebar__inbox-badge';
          badge.appendChild(badgeNode);
        }
      }

      if (badgeNode)
        badgeNode.textContent = String(unread);
    } else if (badgeNode) {
      badge.removeChild(badgeNode);
      badgeNode = null;
    }

    if (badge.setAttribute)
      badge.setAttribute('aria-label', unread > 0 ? `Inbox, ${unread} unread questions` : 'Inbox');
  }

  // The inbox list is only on screen when the inbox entry is selected; a badge
  // update elsewhere must not force the list to re-render.
  if (!inbox)
    return true;

  // The list is on screen, so reconcile it in place. A full `_requestRender()`
  // here rebuilds the whole shell and destroys every typed-but-unsent answer in
  // the other cards — the reason this function used to return `false` and the
  // caller used to rebuild. `syncInboxList` preserves those drafts and reports
  // `false` when the shape changed in a way that genuinely needs a rebuild
  // (empty <-> non-empty).
  retireExpiredQuestionRows(app);

  return syncInboxList(app, questionAnswerHandlers(app));
}

// Answer submission lives here, not on the app class, so the app keeps only a
// one-line delegate and the network shape stays next to the view that uses it.
export async function submitQuestionAnswer(app, questionID, answerText, options = {}) {
  let text = normalizeAnswerText(answerText);
  if (!canSubmitAnswer(text))
    return { ok: false, reason: 'empty', message: '' };

  // Injectable so a failing POST is testable without a network, and so a caller
  // can substitute the transport.
  let postJSON = options.postJSON || ((url, body) => app._postJSON(url, body));
  let announce = options.announce || ((message, noticeOptions) => (
    announceAnswerStatus(app, message, noticeOptions)
  ));

  let questionsState = getQuestionsState(app._state);

  // Captured while the row is still open, so a failed write knows what it is
  // allowed to put back — and whether anything of ours is there at all.
  let target = captureSettlementTarget(questionsState, questionID, { status: 'answered' });

  // Closed BEFORE the POST, not after it.
  //
  // This used to `await` first, which meant the row sat there looking unanswered
  // for the whole round trip and only reacted once the server replied. The wait
  // is invisible on localhost and unmissable on a slow link, and it made a
  // dropped connection look like a dead button. The receipt now appears on the
  // click.
  //
  // Safe only because it is reversible: `revertLocalSettlement` below puts the
  // row back if the write is rejected, and `closedAt` is held as the token that
  // proves the rollback is undoing THIS settlement.
  let closedAt = Date.now();
  applyLocalAnswer(questionsState, questionID, {
    answer: text,
    closedAt,
    // Kept on screen, counting down, instead of vanishing: an answer that
    // simply disappears gives the user no confirmation their click landed.
    settleAfter: SETTLE_WINDOW_MS,
  });
  repaintQuestionShell(app);

  try {
    let result = await postJSON(`/api/v1/questions/${encodeURIComponent(questionID)}/answer`, {
      answer: text,
    });

    let payload = result?.data || result || {};
    // The server answers 200 even when delivery failed: the answer is durable
    // and `delivered` distinguishes the two cases (see question-routes.mjs).
    //
    // Nothing more to do to the row: it was closed optimistically and the server
    // has now accepted the write. The closed id was already recorded, so a
    // `fetchQuestions` that was in flight cannot re-list it as open.
    // The row is already gone from the list by the time this runs, so the
    // notice is the only thing that can confirm the send. `delivered: false` is
    // not a failure — the server stored the answer and will retry the wake-up —
    // but it is worth saying, because the asking agent has not seen it yet.
    // Three outcomes, not two. `pending` is the common one: the wake is queued
    // and the agent will pick it up as its turn starts. It used to be reported
    // as `delivered: false`, which read as "the agent did not get it".
    let pending = payload.pending === true;
    let delivered = !pending && payload.delivered !== false;
    announce(
      pending
        ? 'Answer saved. The agent has not started on it yet.'
        : (delivered
          ? 'Answer sent.'
          : 'Answer saved. The agent has not picked it up yet.'),
      { tone: 'success' },
    );

    return { ok: true, delivered, pending, payload };
  } catch (error) {
    // `message` is what the card shows under the box. It must be a plain
    // string: the card falls back to its own text when this is missing, and the
    // previous behaviour (resolve with `{ ok: false }` and no message, which the
    // caller read as success) is the defect being fixed.
    let message = typeof error?.message === 'string' && error.message !== ''
      ? `Could not send the answer: ${error.message}`
      : 'Could not send the answer.';

    // Reopen the row: the receipt was a promise the server has now broken, and
    // leaving "You replied." on screen for an answer that was never stored is
    // worse than the delay this optimistic close removed. The draft was never
    // cleared, so the text the user typed comes back with the form.
    //
    // Only a row this close actually changed is reopened: if the question was
    // already terminal when the user acted, the failure of our redundant write
    // says nothing about that row's real state.
    if (target?.wasOpen) {
      revertLocalSettlement(questionsState, questionID, {
        expectedClosedAt: closedAt,
        expectedStatus: 'answered',
      });
      repaintQuestionShell(app);
    }

    announce(message, { tone: 'error' });

    return { ok: false, reason: 'error', error, message };
  }
}

/**
 * Dismiss a question: record the user's non-response as the answer, without
 * waking the asking agent.
 *
 * Deliberately NOT `dismissQuestion`. That endpoint is the ASKING agent
 * withdrawing its own question (`status:'dismissed'`); here the USER declines to
 * answer, which must still be readable by the agent — so it goes through the
 * answer path with `silent: true`, and the server substitutes its own
 * `<User chose not to respond>` literal.
 *
 * The request ALSO carries a valid `answer`. A route that has the `silent` flag
 * ignores it, so the current server still composes its own literal and the
 * client cannot smuggle agent-visible text. A route that predates `silent`
 * rejects the request with "answer must be a non-empty string", which is
 * exactly the failure this second field prevents: the two server versions are
 * a pure boolean apart, so sending both satisfies either without sniffing an
 * error string or retrying a mutation.
 *
 * Locally this closes the row exactly like a real answer: the same
 * `applyLocalAnswer` and the same in-place shell sync, so the badge, the count
 * and the "already in flight" race all behave identically.
 */
export async function dismissQuestionAnswer(app, questionID, options = {}) {
  let postJSON = options.postJSON || ((url, body) => app._postJSON(url, body));
  let announce = options.announce || ((message, noticeOptions) => (
    announceAnswerStatus(app, message, noticeOptions)
  ));

  let questionsState = getQuestionsState(app._state);
  // A row that was already terminal before the user acted is not ours to reopen
  // merely because our own write failed.
  let target = captureSettlementTarget(questionsState, questionID, { status: 'dismissed' });

  // Same optimistic close as a real answer, and for the same reason: a dismissal
  // that takes a round trip to acknowledge reads as a click that did nothing.
  let closedAt = Date.now();
  applyLocalDismiss(questionsState, questionID, {
    closedAt,
    settleAfter: SETTLE_WINDOW_MS,
  });
  repaintQuestionShell(app);

  try {
    let result = await postJSON(`/api/v1/questions/${encodeURIComponent(questionID)}/answer`, {
      // Ignored by a server that understands `silent`; satisfies the answer
      // validation on one that does not. See the docstring above.
      answer: NO_RESPONSE_ANSWER_TEXT,
      silent: true,
    });

    let payload = result?.data || result || {};
    // Said plainly, because a dismissal is silent BY DESIGN and the absence of
    // any feedback would otherwise be indistinguishable from a failed click.
    announce('Dismissed. The agent was not woken.', { tone: 'success' });

    return { ok: true, suppressed: payload.suppressed !== false, payload };
  } catch (error) {
    let message = typeof error?.message === 'string' && error.message !== ''
      ? `Could not dismiss the question: ${error.message}`
      : 'Could not dismiss the question.';

    // The question was never actually dismissed, so it must reappear as open.
    if (target?.wasOpen) {
      revertLocalSettlement(questionsState, questionID, {
        expectedClosedAt: closedAt,
        expectedStatus: 'dismissed',
      });
      repaintQuestionShell(app);
    }

    announce(message, { tone: 'error' });

    return { ok: false, reason: 'error', error, message };
  }
}

export async function markQuestionRead(app, questionID) {
  let result;
  try {
    result = await app._postJSON(`/api/v1/questions/${encodeURIComponent(questionID)}/read`, {});
  } catch (_ignored) {
    // Clearing the unread badge is cosmetic; a failure must not surface as an
    // error dialog or block answering.
    return false;
  }

  // Mirror the server's `readAt` into the local model. Without this the badge
  // kept its old count until the next fetch, because the badge derives from
  // local state and nothing else updated it.
  let payload = result?.data || result || {};
  let questionsState = getQuestionsState(app._state);
  applyLocalRead(questionsState, questionID, { readAt: payload?.question?.readAt });

  // A read is badge-only: repaint through the shell sync so the Inbox list is
  // left entirely alone (its cards, and any drafts in them, stay put).
  if (!app._syncQuestionShell?.())
    app._requestRender?.();

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
  applyLocalDismiss(questionsState, questionID, { settleAfter: SETTLE_WINDOW_MS });

  if (!app._syncQuestionShell?.())
    app._requestRender?.();

  return true;
}
