'use strict';

// The way back out of a stack view.
//
// The defect these tests exist for: entering Inbox or Activities left the user
// with no route back to Projects/Sessions. Nothing was wrong with the stack --
// `pushView` stacks the view over the session and `popStack` pops it -- but
// `kikx-shell-builders.mjs:237-238` renders `buildInboxView`/
// `buildActivitiesView` *instead of* `buildWindow` when a view is on top, and
// `buildWindowHeader` is the only place a Back control was ever built. So the
// one affordance that leaves a view was destroyed by entering it.
//
// The suite stayed green because every existing spec asserts on class names and
// ARIA state of the *view*; none asserted that a control exists which pops the
// stack. So these tests assert the affordance end to end:
//
//   1. the header renders a Back control at all,
//   2. it is wired to the app's own pop handler (not a bespoke state edit that
//      would strand `selectedSessionID` and the URL on the view),
//   3. pressing it actually returns the stack to the project/session surface.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const { buildViewBackButton } = await import('../../src/client/components/kikx-view-chrome.mjs');
const { inboxHeader } = await import('../../src/client/components/kikx-inbox-list.mjs');
const { buildActivitiesView } = await import('../../src/client/components/kikx-activities-view.mjs');
const { getNavigationStack, kikxState, navigateInbox, navigateActivities } =
  await import('../../src/client/state/kikx-state.mjs');
const { popStack, pushThread, createNavigationStack, currentViewName } =
  await import('../../src/client/state/navigation-stack.mjs');

// --- helpers ---------------------------------------------------------------

function walk(node, predicate, found = []) {
  if (!node || typeof node !== 'object')
    return found;

  if (predicate(node))
    found.push(node);

  for (let child of node.childNodes || [])
    walk(child, predicate, found);

  return found;
}

function classesOf(node) {
  return String(node?.className || '').split(/\s+/).filter(Boolean);
}

function byClass(root, className) {
  return walk(root, (node) => classesOf(node).includes(className));
}

function byTag(root, tagName) {
  return walk(root, (node) => String(node?.tagName || '').toLowerCase() === tagName.toLowerCase());
}

function textOf(root) {
  return walk(root, () => true).map((node) => String(node.textContent ?? '')).join(' ');
}

/**
 * A minimal app double. `_minimizeCurrent` is the real pop entry point
 * (`kikx-app.mjs:347` wires it to `minimizeCurrent`), so the stub models it the
 * same way the app does: pop the stack. Recording the call lets a test prove the
 * button is wired to the app's handler rather than reimplementing the pop.
 */
function appWith(stack, extra = {}) {
  let calls = { minimize: 0 };
  return {
    calls,
    ownerDocument: globalThis.document,
    _state: {
      navigationStack: stack,
      questionsState: { questions: [] },
      sessionIDs: [],
      sessionDetailsByID: {},
      ...extra,
    },
    _minimizeCurrent() {
      calls.minimize += 1;
      this._state.navigationStack = popStack(this._state.navigationStack);
    },
  };
}

function inboxStack() {
  // Root project grid -> a session -> the Inbox pushed on top of it.
  return [ ...pushThread(createNavigationStack(), 'ses_1'), { sessionID: null, collapsed: true, view: 'inbox' } ];
}

function activitiesStack() {
  return [ ...pushThread(createNavigationStack(), 'ses_1'), { sessionID: null, collapsed: true, view: 'activities' } ];
}

// --- the primitive ---------------------------------------------------------

test('buildViewBackButton renders a labelled, accessible control', () => {
  let node = buildViewBackButton(appWith(inboxStack()));

  assert.ok(node, 'a Back node is returned');
  assert.equal(String(node.tagName).toLowerCase(), 'button');
  assert.ok(classesOf(node).includes('kikx-view__back'));
  assert.equal(node.getAttribute('type'), 'button', 'must not submit a surrounding form');
  assert.match(String(node.getAttribute('aria-label')), /Back/);
  // The label names the destination, so the control is not a bare chevron.
  // Read the attribute: mini-dom keeps attributes in `_attributes` rather than
  // mirroring them onto element properties, so `node.title` is undefined even
  // though a browser would expose it.
  assert.match(String(node.getAttribute('title')), /Back to/);
});

// An earlier version of this test asserted `null` for a root-only stack and
// called it "no dead button at the root". That is vacuous against the real app:
// at the root `selectedSessionID` is null, so the sidebar can push a view onto
// the root entry without anything underneath it -- see "a view over the root"
// below. The null case that actually occurs is an app that cannot pop at all.
test('buildViewBackButton returns null when the app cannot pop', () => {
  let app = appWith(createNavigationStack());
  delete app._minimizeCurrent;

  assert.equal(buildViewBackButton(app), null,
    'no button when there is no pop handler to wire it to');
});

test('pressing Back pops the view off the stack and returns to the session', () => {
  let app = appWith(inboxStack());
  let node = buildViewBackButton(app);

  node.dispatchEvent({ type: 'click', bubbles: true });

  assert.equal(app.calls.minimize, 1, 'the app\'s own pop handler was used');
  let remaining = app._state.navigationStack;
  assert.equal(currentViewName(remaining), null, 'the view is no longer on top');
  assert.equal(remaining.at(-1).sessionID, 'ses_1',
    'the user is returned to the session they were in, not the root');
});

// --- the two views ---------------------------------------------------------

test('the Inbox header carries the way back', () => {
  let app = appWith(inboxStack());
  let header = inboxHeader(app);

  let back = byClass(header, 'kikx-view__back');
  assert.equal(back.length, 1, 'exactly one Back control in the Inbox header');
  assert.ok(byTag(back[0], 'svg').length >= 1, 'the control renders its chevron');

  // The title survived alongside it: Back must not replace the heading.
  assert.match(textOf(header), /Inbox/);
});

test('the Activities header carries the way back', () => {
  let app = appWith(activitiesStack());
  let view = buildActivitiesView(app);

  let back = byClass(view, 'kikx-view__back');
  assert.equal(back.length, 1, 'exactly one Back control in the Activities header');
  assert.match(textOf(view), /Activities/);
});

test('pressing Back from the Inbox leaves the user on a session surface', () => {
  let app = appWith(inboxStack());
  let header = inboxHeader(app);
  let back = byClass(header, 'kikx-view__back')[0];

  back.dispatchEvent({ type: 'click', bubbles: true });

  let stack = app._state.navigationStack;
  assert.equal(currentViewName(stack), null);
  assert.equal(stack.length, 2, 'the stack returned to root + session');
});

test('pressing Back from Activities leaves the user on a session surface', () => {
  let app = appWith(activitiesStack());
  let view = buildActivitiesView(app);
  let back = byClass(view, 'kikx-view__back')[0];

  back.dispatchEvent({ type: 'click', bubbles: true });

  assert.equal(currentViewName(app._state.navigationStack), null);
});

test('Activities at workspace scope still offers the way back', () => {
  // The workspace branch renders its own header (derived.scope === 'workspace',
  // which is what you get when no session is entered). That branch was missed by
  // the first fix, so Activities opened from the root still stranded the user.
  let app = appWith(activitiesStack());

  let view = buildActivitiesView(app);
  let header = byClass(view, 'kikx-activities__header')[0];

  // Prove this really rendered the workspace branch. Asserting only that a Back
  // control exists would pass on the session branch too, so the test would
  // silently stop covering the branch it was written for. The two branches
  // differ structurally: workspace renders a project grid, the session branch
  // renders a `__summary` card plus a `__scope` label.
  assert.equal(byClass(view, 'kikx-activities__summary').length, 0,
    'no session summary card in workspace scope');
  assert.equal(byClass(header, 'kikx-activities__scope').length, 0,
    'the "project rollup" label is the session branch only');
  assert.equal(
    byClass(view, 'kikx-activities__grid').length + byClass(view, 'kikx-activities__empty').length, 1,
    'workspace scope renders the project grid, or its empty state when there are no projects');

  let back = byClass(header, 'kikx-view__back');
  assert.equal(back.length, 1, 'the workspace-scope header carries a Back control');

  back[0].dispatchEvent({ type: 'click', bubbles: true });
  assert.equal(currentViewName(app._state.navigationStack), null,
    'pressing it leaves the view');
});

// --- the real state transitions -------------------------------------------

test('navigateInbox then Back restores the pre-existing session context', () => {
  // Drive the real state module, not the double: this proves the push the
  // sidebar performs is the same entry the Back control pops.
  let state = { navigationStack: pushThread(createNavigationStack(), 'ses_42') };

  navigateInbox(state);
  assert.equal(currentViewName(getNavigationStack(state)), 'inbox');
  assert.equal(getNavigationStack(state).length, 3);

  let app = {
    _state: state,
    _minimizeCurrent() {
      this._state.navigationStack = popStack(this._state.navigationStack);
    },
  };
  let back = buildViewBackButton(app);
  back.dispatchEvent({ type: 'click', bubbles: true });

  assert.equal(currentViewName(getNavigationStack(state)), null);
  assert.equal(getNavigationStack(state).at(-1).sessionID, 'ses_42');
});

test('navigateActivities then Back restores the pre-existing session context', () => {
  let state = { navigationStack: pushThread(createNavigationStack(), 'ses_7') };

  navigateActivities(state);
  assert.equal(currentViewName(getNavigationStack(state)), 'activities');

  let app = {
    _state: state,
    _minimizeCurrent() {
      this._state.navigationStack = popStack(this._state.navigationStack);
    },
  };
  buildViewBackButton(app).dispatchEvent({ type: 'click', bubbles: true });

  assert.equal(currentViewName(getNavigationStack(state)), null);
  assert.equal(getNavigationStack(state).at(-1).sessionID, 'ses_7');
});

test('switching Inbox -> Activities keeps one Back, not a buried stack', () => {
  // `pushView` replaces the current view rather than stacking a second one, so
  // Back from Activities must land on the session, never on the Inbox.
  let state = { navigationStack: pushThread(createNavigationStack(), 'ses_9') };

  navigateInbox(state);
  navigateActivities(state);

  assert.equal(getNavigationStack(state).length, 3, 'the view was replaced, not stacked');
  assert.equal(currentViewName(getNavigationStack(state)), 'activities');

  state.navigationStack = popStack(state.navigationStack);
  assert.equal(currentViewName(getNavigationStack(state)), null);
  assert.equal(getNavigationStack(state).at(-1).sessionID, 'ses_9');
});

// Guard against a regression where the module is imported but the live state
// singleton is the one the app actually renders from.
test('the control works against the shared kikxState singleton', () => {
  let saved = kikxState.navigationStack;
  try {
    kikxState.navigationStack = pushThread(createNavigationStack(), 'ses_live');
    navigateInbox(kikxState);
    assert.equal(currentViewName(getNavigationStack(kikxState)), 'inbox');

    let app = {
      _state: kikxState,
      _minimizeCurrent() {
        this._state.navigationStack = popStack(this._state.navigationStack);
      },
    };
    buildViewBackButton(app).dispatchEvent({ type: 'click', bubbles: true });

    assert.equal(currentViewName(getNavigationStack(kikxState)), null);
  } finally {
    kikxState.navigationStack = saved;
  }
});

// Opening a view before selecting a session: `pushView` keeps the root entry and
// pushes the view on top of it, so the stack is always at least two deep while a
// view header is on screen. Back therefore lands on the root project grid, which
// is the surface the user came from.
test('a view opened over the root still offers a way back', () => {
  let state = { navigationStack: createNavigationStack() };
  navigateInbox(state);

  assert.equal(getNavigationStack(state).length, 2, 'the root entry is retained under the view');
  assert.equal(currentViewName(getNavigationStack(state)), 'inbox');

  let app = {
    _state: state,
    _minimizeCurrent() {
      this._state.navigationStack = popStack(this._state.navigationStack);
    },
  };

  let back = buildViewBackButton(app);
  assert.ok(back, 'the control is rendered when no session was selected first');

  back.dispatchEvent({ type: 'click', bubbles: true });
  assert.equal(currentViewName(getNavigationStack(state)), null, 'the view was left');
});
