'use strict';

// Regression guard, inverted: there is no child-session entry point in the frame
// filter popup, and there must not be one again.
//
// History, because this file used to assert the opposite. `c70aeb8` replaced the
// header's grid-of-dots toggle with this popup. The toggle had done two jobs --
// narrowing the thread, and entering a separate child-session grid -- and only
// the first moved into the popup. To keep child-session creation reachable, this
// popup grew a footer action ("Child sessions (n)") wired to `showSubSessions`,
// and this spec was written to require it.
//
// That footer was the entrance to a view you could not leave: it set `collapsed`
// on the stack entry, `buildWindow` then rendered the child grid *instead of* the
// thread, and nothing in the grid cleared the flag. The owner's ruling was that
// the second view itself was the defect -- everything about a session belongs in
// that session's window -- so the grid was deleted and children render inline.
// Creation now lives in the window header at every level, which is what the
// footer's own comment claimed it existed to protect.
//
// So the absence asserted here is deliberate, not incidental. If a footer action
// reappears, a second way into a replaced view has reappeared with it.
//
// mini-dom has no CSS cascade or layout, so this asserts structure only. That the
// popup is visible and correctly placed belongs in the browser lane.

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
];

function bootPopup() {
  let calls = { create: 0 };
  let app = {
    _state: {
      sessionIDs: SESSIONS.map((session) => session.id),
      sessionDetailsByID: Object.fromEntries(SESSIONS.map((session) => [ session.id, session ])),
      frameFilters: null,
    },
    _createSession() { calls.create += 1; },
  };
  let popup = document.createElement('kikx-frame-filter-popup');
  popup.configure({ app, appState: app._state, sessionID: 'parent_1' });
  document.body.appendChild(popup);

  return { popup, app, calls };
}

test('the popup no longer carries a control that opens a child-session grid', () => {
  let { popup } = bootPopup();
  popup._open({ focus: false });

  assert.equal(
    popup.querySelector('[data-filter-action="child-sessions-grid"]'),
    null,
    'that action opened a view whose thread it replaced; children render inline now',
  );
});

test('the popup has no footer at all, so no count is plumbed in to label one', () => {
  let { popup } = bootPopup();
  popup._open({ focus: false });

  assert.equal(popup.querySelector('.kikx-frame-filter__footer'), null);
  assert.equal(popup._childCount, undefined,
    'the count existed only to label the footer action');
});

test('the popup keeps its actual job: the category rows and the Deleted gate', () => {
  let { popup } = bootPopup();
  popup._open({ focus: false });

  // The eye narrows the thread. It is not, and is not becoming, a mode switch --
  // so its real controls must survive the footer's removal.
  let panel = popup.querySelector('.kikx-frame-filter__panel');
  assert.ok(panel, 'the panel still renders');
  assert.ok(panel.querySelector('[data-filter-key="user"]'), 'category rows survive');
  assert.ok(panel.querySelector('[data-filter-key="deleted"]'), 'the Deleted gate survives');
});

test('configure() no longer accepts or requires a child count', () => {
  let popup = document.createElement('kikx-frame-filter-popup');
  // A caller still passing the old field must not break; it is simply ignored.
  popup.configure({ sessionID: 'parent_1', childCount: 3 });
  document.body.appendChild(popup);
  popup._open({ focus: false });

  assert.equal(popup.querySelector('[data-filter-action="child-sessions-grid"]'), null);
});
