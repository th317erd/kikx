'use strict';

// Owner change of mind, 2026-10-27 (supersedes the pencil from item 2a):
//
//   "I changed my mind about the pencil icon to change the name of a session in
//    the breadcrumb... let's please instead have a double-click or long-press
//    enter edit mode. Blur, or Esc leaves edit mode."
//
// So the RENAME ENTRY gesture is the contract now, and the pencil is gone. This
// file pins the entry half; the exit half (Esc, blur, navigation, Cancel) already
// lives in spec/client/session-rename-escape-spec.mjs and is deliberately not
// duplicated here.
//
// WHY THIS FILE EXISTS AT ALL, given that spec also touches the crumb: the old
// entry path was a button. A button is trivially discoverable by a test -- it is
// either in the tree or it is not -- and that is exactly the property that made
// it easy to verify and easy to ship. A gesture has no such artifact. If nothing
// pins "a double-click calls beginSessionNameEdit", the control can silently
// disappear in a refactor and every remaining test still passes, because the
// absence of markup is not an assertion. These assertions are that pin.
//
// WHAT mini-dom CAN AND CANNOT PROVE. It has addEventListener/dispatchEvent with
// bubbling and cancellation, but no layout, no pointer capture and no real
// timers. So:
//   * dblclick dispatch and handler wiring ARE faithful here;
//   * long-press is driven by advancing mock timers, which proves the logic
//     (timer armed, threshold, cancel routes) but NOT that a real touch produces
//     a 450ms pointerdown hold. That half is the browser lane's job and is
//     stated as unverified rather than implied by a green run.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();

const topbar = await import('../../src/client/components/kikx-topbar.mjs');
const gestures = await import('../../src/client/components/session-name-gestures.mjs');

const {
  SESSION_NAME_LONG_PRESS_MS,
  SESSION_NAME_LONG_PRESS_SLOP_PX,
  SESSION_NAME_CLICK_SUPPRESS_MS,
  attachSessionNameEntryGestures,
} = gestures;

const { buildTopbarCrumb } = topbar;

// --- helpers ---------------------------------------------------------------

function makeApp(state = {}) {
  let app = {
    calls: { render: 0, begin: [], navigate: [], commit: [], cancel: 0 },
    _state: {
      editingSessionNameID: '',
      editingSessionNameValue: '',
      navigationStack: [ { sessionID: 's1', collapsed: false } ],
      sessions: [ { id: 's1', title: 'Original name' }, { id: 's2', title: 'Parent' } ],
      ...state,
    },
    _render() { app.calls.render += 1; },
    _beginSessionNameEdit(sessionID, currentTitle) {
      app.calls.begin.push({ sessionID, currentTitle });
    },
    _navigateToDepth(depth) { app.calls.navigate.push(depth); },
    _commitSessionName() {},
    _cancelSessionNameEdit() {},
  };
  return app;
}

function crumbFor(overrides = {}) {
  return { sessionID: 's1', label: 'Original name', active: true, depth: 2, ...overrides };
}

function mount(builder) {
  let node = builder.build(document);
  let host = document.createElement('div');
  host.appendChild(node);
  document.body.appendChild(host);
  return node;
}

// The label the gesture is attached to: the thing showing the session name.
function labelOf(node) {
  // The builder returns the LABEL itself when it is not wrapping anything, so a
  // descendant-only query returns null for a root/leaf crumb. Accept the node
  // when it already carries a crumb class.
  for (let name of [ 'kikx-breadcrumb__crumb--active', 'kikx-breadcrumb__crumb' ])
    if (node.classList?.contains?.(name))
      return node;
  return node.querySelector('.kikx-breadcrumb__crumb--active')
    || node.querySelector('.kikx-breadcrumb__crumb');
}

function fire(node, type, init = {}) {
  let event = new Event(type, { bubbles: true, cancelable: true });
  for (let [ key, value ] of Object.entries(init))
    Object.defineProperty(event, key, { configurable: true, value });
  node.dispatchEvent(event);
  return event;
}

function pointer(node, type, x = 0, y = 0, button = 0) {
  return fire(node, type, { clientX: x, clientY: y, button });
}

// --- 1. the pencil is gone -------------------------------------------------

test('the session crumb renders no pencil: the gesture replaced it', () => {
  let app = makeApp();
  let crumb = mount(buildTopbarCrumb(app, crumbFor()));

  assert.equal(crumb.querySelector('.kikx-icon-button'), null,
    'the rename pencil must be gone from the crumb, not merely hidden');
  assert.equal(crumb.querySelector('svg'), null,
    'no rename glyph should remain in the crumb at all');
});

test('the crumb still renders its label text, so the rename target stays visible', () => {
  let app = makeApp();
  let label = labelOf(mount(buildTopbarCrumb(app, crumbFor())));

  assert.ok(label, 'the session crumb must still render a label node');
  assert.match(label.textContent, /Original name/,
    'the label carries the session title and is the dblclick target');
});

// --- 2. double-click enters edit mode --------------------------------------

test('double-clicking the active crumb begins the rename', () => {
  let app = makeApp();
  let label = labelOf(mount(buildTopbarCrumb(app, crumbFor())));

  fire(label, 'dblclick');

  assert.deepEqual(app.calls.begin, [ { sessionID: 's1', currentTitle: 'Original name' } ],
    'a double-click must call _beginSessionNameEdit with the session it names');
});

test('a single click on the active crumb does NOT begin the rename', () => {
  // The active crumb is a span, not a destination, so a stray click has no other
  // job -- but entering edit mode on one click would make every mis-click on the
  // title start a rename the owner then has to escape from.
  let app = makeApp();
  let label = labelOf(mount(buildTopbarCrumb(app, crumbFor())));

  fire(label, 'click');

  assert.deepEqual(app.calls.begin, [], 'one click must not enter edit mode');
  assert.deepEqual(app.calls.navigate, [], 'the active crumb must not navigate');
});

test('double-click enters edit mode from an already-open editor only once', () => {
  // While the field is rendered the crumb is the editor, not a label: there is no
  // dblclick target left to re-enter through. This pins that the editor branch
  // wins, so a double-click cannot re-seed the typed value mid-edit.
  let app = makeApp({ editingSessionNameID: 's1', editingSessionNameValue: 'Half-typed' });
  let node = mount(buildTopbarCrumb(app, crumbFor()));

  assert.equal(node.querySelector('input[name="session-name"]') !== null
    || node.querySelector('.kikx-breadcrumb__editor') !== null, true,
    'the crumb must render the editor while editing');

  let editor = node.classList?.contains?.('kikx-breadcrumb__editor')
    ? node
    : node.querySelector('.kikx-breadcrumb__editor');
  if (editor)
    fire(editor, 'dblclick');

  assert.deepEqual(app.calls.begin, [],
    'a double-click inside the open editor must not restart the rename');
});

// --- 3. long-press enters edit mode ----------------------------------------

test('holding the crumb for the long-press threshold begins the rename', (t) => {
  t.mock.timers.enable({ apis: [ 'setTimeout' ] });

  let app = makeApp();
  let label = labelOf(mount(buildTopbarCrumb(app, crumbFor())));

  pointer(label, 'pointerdown', 10, 10);
  assert.deepEqual(app.calls.begin, [], 'the rename must not fire on press alone');

  t.mock.timers.tick(SESSION_NAME_LONG_PRESS_MS - 1);
  assert.deepEqual(app.calls.begin, [], 'the rename must not fire before the threshold');

  t.mock.timers.tick(1);
  assert.deepEqual(app.calls.begin, [ { sessionID: 's1', currentTitle: 'Original name' } ],
    'holding past the threshold must begin the rename');
});

test('a quick tap never begins the rename', (t) => {
  // The common case by far: every tap on the title would otherwise rename it.
  t.mock.timers.enable({ apis: [ 'setTimeout' ] });

  let app = makeApp();
  let label = labelOf(mount(buildTopbarCrumb(app, crumbFor())));

  pointer(label, 'pointerdown', 10, 10);
  t.mock.timers.tick(SESSION_NAME_LONG_PRESS_MS / 2);
  pointer(label, 'pointerup', 10, 10);
  t.mock.timers.tick(SESSION_NAME_LONG_PRESS_MS * 2);

  assert.deepEqual(app.calls.begin, [], 'a tap shorter than the threshold must cancel the timer');
});

test('moving the pointer past the slop cancels the long-press', (t) => {
  // A scroll or a drag that starts on the title must not rename it.
  t.mock.timers.enable({ apis: [ 'setTimeout' ] });

  let app = makeApp();
  let label = labelOf(mount(buildTopbarCrumb(app, crumbFor())));

  pointer(label, 'pointerdown', 10, 10);
  pointer(label, 'pointermove', 10 + SESSION_NAME_LONG_PRESS_SLOP_PX + 5, 10);
  t.mock.timers.tick(SESSION_NAME_LONG_PRESS_MS * 2);

  assert.deepEqual(app.calls.begin, [], 'a drag past the slop tolerance must cancel the long-press');
});

test('a small jitter inside the slop still begins the rename', (t) => {
  // CONTROL for the test above: if the move handler cancelled on ANY movement,
  // the slop assertion would pass for the wrong reason and real fingers -- which
  // always wobble a pixel or two -- would never trigger the rename.
  t.mock.timers.enable({ apis: [ 'setTimeout' ] });

  let app = makeApp();
  let label = labelOf(mount(buildTopbarCrumb(app, crumbFor())));

  pointer(label, 'pointerdown', 10, 10);
  pointer(label, 'pointermove', 10 + SESSION_NAME_LONG_PRESS_SLOP_PX - 2, 10);
  t.mock.timers.tick(SESSION_NAME_LONG_PRESS_MS);

  assert.deepEqual(app.calls.begin, [ { sessionID: 's1', currentTitle: 'Original name' } ],
    'jitter inside the slop must NOT cancel the long-press');
});

test('pointercancel aborts the long-press', (t) => {
  t.mock.timers.enable({ apis: [ 'setTimeout' ] });

  let app = makeApp();
  let label = labelOf(mount(buildTopbarCrumb(app, crumbFor())));

  pointer(label, 'pointerdown', 10, 10);
  pointer(label, 'pointercancel', 10, 10);
  t.mock.timers.tick(SESSION_NAME_LONG_PRESS_MS * 2);

  assert.deepEqual(app.calls.begin, [], 'a cancelled pointer must not rename');
});

test('the long-press does not rename a session that has left the stack', (t) => {
  // A frame-poll repaint can replace the crumb mid-press. The timer must not
  // start an edit for a session the owner is no longer looking at.
  t.mock.timers.enable({ apis: [ 'setTimeout' ] });

  let app = makeApp();
  let label = labelOf(mount(buildTopbarCrumb(app, crumbFor())));

  pointer(label, 'pointerdown', 10, 10);
  app._state.navigationStack = [ { sessionID: 's2', collapsed: false } ];
  t.mock.timers.tick(SESSION_NAME_LONG_PRESS_MS);

  assert.deepEqual(app.calls.begin, [],
    'the timer must re-check that the session is still on the navigation stack');
});

// --- 4. the keyboard path the pencil used to provide -----------------------

test('F2 on the focused crumb begins the rename', () => {
  // Deleting the pencil alone would have left the rename unreachable from the
  // keyboard: a gesture has no focus target. F2 is the platform rename key.
  let app = makeApp();
  let label = labelOf(mount(buildTopbarCrumb(app, crumbFor())));

  fire(label, 'keydown', { key: 'F2' });

  assert.deepEqual(app.calls.begin, [ { sessionID: 's1', currentTitle: 'Original name' } ],
    'F2 must begin the rename so the control stays keyboard reachable');
  assert.equal(label.getAttribute('tabindex'), '0',
    'the crumb must be focusable, or F2 can never reach it');
});

test('other keys on the crumb do nothing', () => {
  let app = makeApp();
  let label = labelOf(mount(buildTopbarCrumb(app, crumbFor())));

  for (let key of [ 'a', 'Enter', ' ', 'Escape' ])
    fire(label, 'keydown', { key });

  assert.deepEqual(app.calls.begin, [], 'only F2 is a rename entry; nothing else may fire');
});

// --- 5. navigable ancestor crumbs keep navigating --------------------------

test('a click on an ancestor crumb still navigates, unchanged', () => {
  // The regression guard for the whole change: the ancestor crumb is a real
  // button that navigates. Attaching gesture handlers must not swallow that.
  let app = makeApp();
  let node = mount(buildTopbarCrumb(app, crumbFor({ sessionID: 's2', label: 'Parent', active: false, depth: 1 })));
  let label = labelOf(node);

  fire(label, 'click');

  assert.deepEqual(app.calls.navigate, [ 1 ],
    'an ancestor crumb click must still navigate to its depth');
  assert.deepEqual(app.calls.begin, [], 'and must not rename');
});

test('an ancestor crumb is still a real button', () => {
  let app = makeApp();
  let label = labelOf(mount(buildTopbarCrumb(app, crumbFor({ sessionID: 's2', active: false, depth: 1 }))));

  assert.equal(label.localName, 'button', 'ancestor crumbs remain buttons');
});

test('the root Projects crumb gets no rename gesture', () => {
  // It has no sessionID: there is no session row to rename, which is the same
  // reason it never had a pencil.
  let app = makeApp();
  let node = mount(buildTopbarCrumb(app, crumbFor({ sessionID: null, label: 'Projects', active: false, depth: 1 })));
  let label = labelOf(node);

  fire(label, 'dblclick');
  pointer(label, 'pointerdown', 5, 5);

  assert.deepEqual(app.calls.begin, [], 'the root crumb must never begin a rename');
  assert.equal(label.getAttribute('tabindex'), null,
    'and it must not become a tab stop just to carry a gesture it does not have');
});

// --- 6. attaching twice must not double-fire -------------------------------

test('attaching the gesture a second time replaces listeners rather than duplicating them', () => {
  // buildTopbarCrumb is called on every render. If each call appended another
  // listener to a retained node, one double-click would fire N renames.
  let app = makeApp();
  let label = document.createElement('span');
  label.textContent = 'Original name';

  attachSessionNameEntryGestures(app, label, crumbFor());
  attachSessionNameEntryGestures(app, label, crumbFor());

  fire(label, 'dblclick');

  assert.equal(app.calls.begin.length, 1,
    'the gesture must be idempotent per node, or a re-render multiplies the rename');
});

// --- 6. the hold must not be undone by the click that follows it ------------

test('a hold that opened the editor swallows the click that follows the release', (t) => {
  // The bug this exists for: on an ANCESTOR crumb the label is a button, and the
  // order is `pointerdown -> (450ms: editor opens) -> pointerup -> click`. That
  // click calls navigateToDepth, which rebuilds the bar and destroys the editor
  // the hold just opened -- so the gesture would look broken in the one place a
  // user is most likely to reach for it. Reproduced here through the real
  // handler on the real crumb, not by calling the guard directly.
  t.mock.timers.enable({ apis: [ 'setTimeout' ] });

  let app = makeApp({ navigationStack: [ { sessionID: 's2', collapsed: false }, { sessionID: 's1', collapsed: false } ] });
  let label = labelOf(mount(buildTopbarCrumb(app, crumbFor({ sessionID: 's2', label: 'Parent', active: false, depth: 1 }))));

  pointer(label, 'pointerdown', 10, 10);
  t.mock.timers.tick(SESSION_NAME_LONG_PRESS_MS);
  assert.deepEqual(app.calls.begin, [ { sessionID: 's2', currentTitle: 'Parent' } ],
    'the hold must open the editor before the click is even dispatched');

  pointer(label, 'pointerup', 10, 10);
  fire(label, 'click');

  assert.deepEqual(app.calls.navigate, [],
    'the click that ends the hold must not navigate: it would tear down the editor the hold opened');
});

test('CONTROL: a plain click on an ancestor crumb still navigates', () => {
  // Without this, the test above passes for the wrong reason if navigation were
  // simply broken. A click with no preceding hold must go through untouched.
  let app = makeApp();
  let label = labelOf(mount(buildTopbarCrumb(app, crumbFor({ sessionID: 's2', label: 'Parent', active: false, depth: 1 }))));

  fire(label, 'click');

  assert.deepEqual(app.calls.navigate, [ 1 ],
    'a click that is not part of a hold must still navigate');
});

test('the guard expires, so it cannot eat a later genuine navigation', (t) => {
  // A sticky flag would be safer for the hold and wrong for the user: the click
  // is not guaranteed to arrive at all (the pressed node may already be
  // detached), so an arming that is never consumed must not persist. Mocking
  // Date alongside setTimeout is what lets this be measured rather than argued.
  t.mock.timers.enable({ apis: [ 'setTimeout', 'Date' ] });

  let app = makeApp({ navigationStack: [ { sessionID: 's2' } ] });
  let label = labelOf(mount(buildTopbarCrumb(app, crumbFor({ sessionID: 's2', label: 'Parent', active: false, depth: 1 }))));

  pointer(label, 'pointerdown', 4, 4);
  t.mock.timers.tick(SESSION_NAME_LONG_PRESS_MS);
  assert.equal(app.calls.begin.length, 1, 'the hold arms the guard');

  // Well past the suppression window, with the following click never delivered.
  t.mock.timers.tick(SESSION_NAME_CLICK_SUPPRESS_MS + 1);

  fire(label, 'click');
  assert.deepEqual(app.calls.navigate, [ 1 ],
    'an arming that outlived its window must not swallow a genuine navigation');
});

test('the guard does not arm when the hold did not actually begin an edit', (t) => {
  // CONTROL for the arming condition. If the guard armed on every hold -- even
  // one the entry guard refused -- a press-and-hold on a crumb whose session has
  // left the stack would silently eat the user's next navigation.
  t.mock.timers.enable({ apis: [ 'setTimeout', 'Date' ] });

  // Stack does NOT contain s2, so requestRename refuses.
  let app = makeApp({ navigationStack: [ { sessionID: 's1' } ] });
  let label = labelOf(mount(buildTopbarCrumb(app, crumbFor({ sessionID: 's2', label: 'Parent', active: false, depth: 1 }))));

  pointer(label, 'pointerdown', 4, 4);
  t.mock.timers.tick(SESSION_NAME_LONG_PRESS_MS);
  assert.deepEqual(app.calls.begin, [], 'sanity: the refused hold began nothing');

  fire(label, 'click');
  assert.deepEqual(app.calls.navigate, [ 1 ],
    'a refused hold must not arm a guard that suppresses the next real click');
});

test('a double-click on an ANCESTOR crumb does not rename: that crumb navigates on click', () => {
  // Its single click already navigates and rebuilds the bar, so there is no
  // stable second target to pair with -- a "double-click" there has always just
  // been two navigations. Ancestors are renamed by hold or by F2 instead, and the
  // tooltip says so.
  let app = makeApp();
  let label = labelOf(mount(buildTopbarCrumb(app, crumbFor({ sessionID: 's2', label: 'Parent', active: false, depth: 1 }))));

  fire(label, 'dblclick');

  assert.deepEqual(app.calls.begin, [], 'double-click must not rename an ancestor crumb');
});

test('the tooltip only advertises the gestures the crumb actually supports', () => {
  let app = makeApp();

  let activeLabel = labelOf(mount(buildTopbarCrumb(app, crumbFor())));
  assert.match(activeLabel.getAttribute('title'), /Double-click or hold/,
    'the active crumb supports double-click, so its tooltip must name it');

  let ancestorLabel = labelOf(mount(buildTopbarCrumb(app, crumbFor({ sessionID: 's2', label: 'Parent', active: false, depth: 1 }))));
  assert.doesNotMatch(ancestorLabel.getAttribute('title'), /Double-click/,
    'an ancestor crumb ignores double-click, so it must not promise one');
  assert.match(ancestorLabel.getAttribute('title'), /Hold/,
    'but it must still advertise the hold that does work there');
});
