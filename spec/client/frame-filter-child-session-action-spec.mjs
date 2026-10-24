'use strict';

// Regression guard: removing the grid-of-dots header toggle removed the only
// route to the child-session grid, and that grid is the only place the
// "+ Add Session" card is rendered. Child-session creation then had no UI
// route at all, while the whole suite stayed green, because no spec asserted
// that the grid was still reachable. This one does.
//
// mini-dom has no CSS cascade or layout, so this asserts structure and
// handler behaviour only. That the control is visible and correctly sized
// belongs in the browser lane.

import assert from 'node:assert/strict';
import test from 'node:test';

import { installDom } from './support/mini-dom.mjs';

const { document } = installDom();
document.addEventListener = () => {};
document.removeEventListener = () => {};
globalThis.document = document;

await import('../../src/client/components/kikx-frame-filter-popup.mjs');

const SESSIONS = [
  { id: 'parent_1', parentSessionID: null, title: 'Parent' },
  { id: 'child_1', parentSessionID: 'parent_1', title: 'Child One' },
  { id: 'child_2', parentSessionID: 'parent_1', title: 'Child Two' },
  { id: 'unrelated', parentSessionID: 'other', title: 'Elsewhere' },
];

function bootPopup({ childCount = 2 } = {}) {
  let calls = { showSubSessions: 0 };
  let app = {
    _state: { sessions: SESSIONS, frameFilters: null },
    _showSubSessions() { calls.showSubSessions += 1; },
  };
  let popup = document.createElement('kikx-frame-filter-popup');
  popup.configure({ app, appState: app._state, sessionID: 'parent_1', childCount });
  document.body.appendChild(popup);

  return { popup, app, calls };
}

test('the popup exposes a control that reaches the child-session grid', () => {
  let { popup } = bootPopup();
  popup._open({ focus: false });

  let action = popup.querySelector('[data-filter-action="child-sessions-grid"]');
  assert.ok(action, 'without this control the grid, and the add-session card, are unreachable');
  assert.equal(action.tagName, 'BUTTON');
  assert.equal(action.type, 'button');
});

test('that control shows the count the builder hands it', () => {
  let { popup } = bootPopup({ childCount: 3 });
  popup._open({ focus: false });

  let action = popup.querySelector('[data-filter-action="child-sessions-grid"]');
  assert.equal(action.textContent, 'Child sessions (3)', 'the count comes from the shell, not re-derived here');
});

test('clicking it opens the child-session grid exactly once and closes the popup', () => {
  let { popup, calls } = bootPopup();
  popup._open({ focus: false });
  assert.equal(popup.isOpen, true);

  popup.querySelector('[data-filter-action="child-sessions-grid"]')
    .dispatchEvent(new Event('click', { bubbles: true }));

  assert.equal(calls.showSubSessions, 1, 'the grid must be opened exactly once');
  assert.equal(popup.isOpen, false, 'the popup must not stay over the grid it just opened');
});

test('the control lives inside the panel, so it is unreachable while closed', () => {
  let { popup } = bootPopup();
  let panel = popup.querySelector('.kikx-frame-filter__panel');
  assert.equal(panel.hidden, true, 'the panel starts closed');

  let action = popup.querySelector('[data-filter-action="child-sessions-grid"]');
  assert.equal(panel.contains(action), true, 'the route lives with the filters, not in the header');
  assert.equal(popup.classList.contains('is-open'), false);
});

test('it survives a session with no children and still routes', () => {
  let { popup, calls } = bootPopup({ childCount: 0 });
  popup._open({ focus: false });

  let action = popup.querySelector('[data-filter-action="child-sessions-grid"]');
  assert.equal(action.textContent, 'Child sessions (0)');
  action.dispatchEvent(new Event('click', { bubbles: true }));
  assert.equal(calls.showSubSessions, 1);
});
