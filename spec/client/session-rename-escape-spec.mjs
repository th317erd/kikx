'use strict';

// Owner item 2 (2026-10-27): the inline session rename.
//
// Two complaints, one file, because they are one control:
//
//   2a  "the edit pencil icon itself is WAY WAY too large"
//   2b  "once entering edit mode, if I change my mind, I am fucked... there is NO
//        WAY to leave edit mode. Esc won't do it. Blurring the field won't do it.
//        Even navigating around the app won't do it!"
//
// THE MEASURED TRAP this file exists to keep closed (owner screenshots at HEAD
// 4b4f902, so these are live defects, not history):
//
//   * `buildTopbarCrumb` named the field `crumb-name` while
//     `beginSessionNameEdit` looked up `input[name="session-name"]`. The lookup
//     never matched, so the field was never focused. Two exits died with it:
//     `focusout` cannot fire on a field that never had focus, and the field's own
//     `onKeydown` Escape handler never received a key.
//   * Nothing else ever cleared `editingSessionNameID`, so every re-render
//     re-entered edit mode for that crumb -- "even navigating around the app
//     won't do it".
//
// The CSS/presentation half of item 2 (the pencil glyph size and the Cancel
// control's computed visibility) lives in
// spec/client/session-rename-presentation-spec.mjs -- split by responsibility,
// because those assertions read stylesheets and these drive the DOM.
//
// WHAT THIS FILE CAN AND CANNOT PROVE, stated before the assertions because the
// difference matters:
//
//   mini-dom has NO layout, NO CSS cascade, NO focus() and NO activeElement. So
//   "the input is document.activeElement" is NOT assertable here; it is the
//   browser lane's line (.gate probe 2a). What IS assertable, and is the actual
//   root cause, is stronger for regression purposes: the shared selector MATCHES
//   the field each of the three builders renders, and `focusSessionNameField`
//   therefore reaches that node and calls focus()+select() on it. At HEAD the
//   selector matched nothing in the bar, so every assertion in the "focus
//   reaches the field" group fails there -- which is exactly the discriminator
//   that makes this a regression test rather than a restatement of the fix.
//
//   The document-level Escape guard IS assertable end-to-end here: the guard is
//   state-armed, not focus-armed, so it needs no DOM focus to test. That is the
//   property the owner's complaint is about.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();

// The client state module imports a real ReactiveState through aeor-ui, whose
// /vendor/... specifiers are browser-only; the loader above redirects them to
// the local stand-ins, exactly as the sibling client specs do.
const navigation = await import('../../src/client/components/kikx-navigation.mjs');
const topbar = await import('../../src/client/components/kikx-topbar.mjs');
const shellBuilders = await import('../../src/client/components/kikx-shell-builders.mjs');

const {
  SESSION_NAME_INPUT_NAME,
  SESSION_NAME_INPUT_SELECTOR,
  beginSessionNameEdit,
  clearSessionNameEditState,
  focusSessionNameField,
  installSessionNameEditGuards,
  navigationContextKey,
  onSessionNameKeydown,
  syncSessionNameEdit,
} = navigation;

const {
  buildEditableTitle,
  buildBreadcrumbTitle,
} = shellBuilders;

const { buildTopbarCrumb } = topbar;

// --- helpers ---------------------------------------------------------------

// A stand-in app carrying only the surface these builders and guards touch. The
// counters are the point: several defects here are "a handler was never reached",
// which is invisible without observing calls.
function makeApp(state = {}) {
  let app = {
    calls: { render: 0, commit: [], cancel: 0, patch: [], focus: [] },
    _state: {
      editingSessionNameID: '',
      editingSessionNameValue: '',
      navigationStack: [ { sessionID: 's1', collapsed: false } ],
      authToken: 'token',
      sessionSearch: '',
      frameFilters: {},
      account: { name: 'w' },
      sessions: [ { id: 's1', title: 'Original name' } ],
      ...state,
    },
    _render() { app.calls.render += 1; },
    _commitSessionName(sessionID) { app.calls.commit.push(sessionID); },
    _cancelSessionNameEdit() { app.calls.cancel += 1; },
    _beginSessionNameEdit() {},
    _navigateToDepth() {},
    // The real app wires this straight through to the module's handler
    // (kikx-app.mjs:241). A no-op stub here would make the Enter/Escape
    // assertions below vacuous -- they would pass against markup with no
    // working handler at all.
    _onSessionNameKeydown(event, sessionID) { onSessionNameKeydown(app, event, sessionID); },
    _onSessionSearchInput() {},
    _clearFrameFilters() {},
    _patchJSON(url) {
      app.calls.patch.push(url);
      return Promise.resolve({ data: { session: { id: 's1', title: 'Renamed' } } });
    },
  };
  return app;
}

function crumbFor(sessionID = 's1', label = 'Original name') {
  return { sessionID, label, active: true, depth: 2 };
}

// Build one of the three rename homes and attach it, so `closest`/`isConnected`
// behave the way the browser's would.
function mount(builder) {
  let node = builder.build(document);
  let host = document.createElement('div');
  host.appendChild(node);
  document.body.appendChild(host);
  return node;
}

function click(node) {
  node.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
}

function keydown(node, key) {
  let event = new Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'key', { configurable: true, value: key });
  node.dispatchEvent(event);
  return event;
}

// The guard installs on the DOCUMENT. mini-dom's MiniDocument has no
// addEventListener (it is a node, not an event target yet), so capture the two
// registrations instead of relying on real dispatch. This is the same surface
// the browser gives the guard; only the plumbing is stubbed.
function captureDocumentListeners() {
  let listeners = [];
  document.addEventListener = (type, handler, options) => listeners.push({ type, handler, options });
  document.removeEventListener = (type, handler, options) => {
    let index = listeners.findIndex((entry) =>
      entry.type === type && entry.handler === handler && entry.options === options);
    if (index >= 0)
      listeners.splice(index, 1);
  };
  document.__captured = listeners;
  return listeners;
}

function escapeEvent() {
  return {
    key: 'Escape',
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };
}

// --- 2b: one shared field identity across all three homes ------------------

test('all three rename homes render the ONE shared input name', () => {
  let app = makeApp({ editingSessionNameID: 's1', editingSessionNameValue: 'Original name' });

  // The bar's crumb -- the one the pencil opens, and the one that shipped with
  // the wrong name.
  // The crumb's editor IS this builder's root node (the full breadcrumb wraps it
  // in nav.kikx-breadcrumb), and querySelector only walks descendants -- so the
  // root itself has to be accepted or this asserts the wrapper, not the editor.
  let crumbField = mount(buildTopbarCrumb(app, crumbFor()));
  let crumbEditor = crumbField.classList.contains('kikx-breadcrumb__editor')
    ? crumbField
    : crumbField.querySelector('.kikx-breadcrumb__editor');
  assert.ok(crumbEditor, 'the bar crumb must render inside .kikx-breadcrumb__editor');

  for (let [ home, node ] of [
    [ 'topbar crumb', crumbField ],
    [ 'buildBreadcrumbTitle', mount(buildBreadcrumbTitle(app, 'Original name', 's1')) ],
    [ 'buildEditableTitle', mount(buildEditableTitle(app, 'Original name', 's1')) ],
  ]) {
    let field = node.localName === 'input' ? node : node.querySelector(SESSION_NAME_INPUT_SELECTOR);
    assert.ok(field, `${home} must render a field matching ${SESSION_NAME_INPUT_SELECTOR}`);
    assert.equal(field.getAttribute('name'), SESSION_NAME_INPUT_NAME,
      `${home} must name the field ${SESSION_NAME_INPUT_NAME}`);
  }
});

test('the shared selector is a single selector, not a comma list', () => {
  // A comma list is unparseable by the client's own selector engine and made the
  // contract untestable downstream. One selector, one identity.
  assert.doesNotMatch(SESSION_NAME_INPUT_SELECTOR, /,/, 'the selector must not be a comma list');
  assert.equal(SESSION_NAME_INPUT_SELECTOR, `input[name="${SESSION_NAME_INPUT_NAME}"]`);
});

// --- 2a: the lookup actually reaches the field, and focuses + selects it ----

test('focusSessionNameField focuses and selects the rendered crumb field', async () => {
  let app = makeApp({ editingSessionNameID: 's1', editingSessionNameValue: 'Original name' });
  let crumb = mount(buildTopbarCrumb(app, crumbFor()));

  let field = crumb.querySelector(SESSION_NAME_INPUT_SELECTOR);
  assert.ok(field, 'the crumb must render the field the lookup asks for');

  // The lookup goes through app.querySelector, exactly as in the browser. Give
  // the app one so the real lookup path is exercised rather than bypassed.
  app.querySelector = (selector) => crumb.querySelector(selector);

  let focused = 0;
  let selected = 0;
  field.focus = () => { focused += 1; };
  field.select = () => { selected += 1; };

  focusSessionNameField(app);
  await Promise.resolve();      // the focus happens in a microtask, after render

  assert.equal(focused, 1, 'the rename field must be focused');
  assert.equal(selected, 1, 'the field text must be selected so typing replaces the name');
});

test('beginSessionNameEdit arms the edit, renders, and focuses the field', async () => {
  let app = makeApp();

  // The stand-in app's `_render` is a counter, but the real one REBUILDS the
  // shell -- which is precisely why the focus has to happen after the render,
  // in a microtask. Model that faithfully: render replaces the node, and the
  // focus must land on the NEW one. A version that focused during the old
  // render would fail here, which is the failure mode the queueMicrotask exists
  // to prevent.
  let host = document.createElement('div');
  document.body.appendChild(host);
  let focused = 0;
  app._render = () => {
    app.calls.render += 1;
    host.replaceChildren(buildTopbarCrumb(app, crumbFor()).build(document));
    let rendered = host.querySelector(SESSION_NAME_INPUT_SELECTOR);
    if (rendered)
      rendered.focus = () => { focused += 1; };
  };
  app.querySelector = (selector) => host.querySelector(selector);

  beginSessionNameEdit(app, 's1', 'Original name');
  await Promise.resolve();

  assert.equal(app._state.editingSessionNameID, 's1');
  assert.equal(app._state.editingSessionNameValue, 'Original name');
  assert.equal(app.calls.render, 1, 'entering edit mode repaints');
  assert.equal(focused, 1, 'entering edit mode focuses the field (blur-to-exit depends on it)');
});

// --- 2b(b): Escape leaves edit mode with focus anywhere --------------------

test('a document-level Escape guard is installed on the CAPTURE phase', () => {
  let listeners = captureDocumentListeners();
  let app = makeApp();
  installSessionNameEditGuards(app);

  let keydownListener = listeners.find((entry) => entry.type === 'keydown');
  assert.ok(keydownListener, 'Escape must be caught at document level, not only on the field');
  assert.equal(keydownListener.options, true,
    'the guard must run on CAPTURE so an inner stopPropagation cannot swallow Escape');
});

test('Escape exits edit mode even though focus is NOT in the field', () => {
  // THE DEFECT. At HEAD Escape only worked while the field held focus, and the
  // field never got focus -- so Escape was dead. The guard is armed by state, so
  // no focus is needed for this assertion to be meaningful.
  let listeners = captureDocumentListeners();
  let app = makeApp({ editingSessionNameID: 's1', editingSessionNameValue: 'Original name' });
  installSessionNameEditGuards(app);

  let keydownListener = listeners.find((entry) => entry.type === 'keydown');
  let event = escapeEvent();
  keydownListener.handler(event);

  assert.equal(app._state.editingSessionNameID, '', 'Escape must clear the edit id');
  assert.equal(app._state.editingSessionNameValue, '', 'Escape must drop the typed value');
  assert.equal(app.calls.render, 1, 'Escape must repaint out of edit mode');
  assert.equal(event.prevented, true, 'Escape must be consumed while the rename is open');
  assert.equal(event.stopped, true, 'Escape must not reach other handlers mid-rename');
});

test('Escape cancels, it does not commit: the title is left untouched', () => {
  let listeners = captureDocumentListeners();
  let app = makeApp({ editingSessionNameID: 's1', editingSessionNameValue: 'Half-typed name' });
  installSessionNameEditGuards(app);

  listeners.find((entry) => entry.type === 'keydown').handler(escapeEvent());

  assert.deepEqual(app.calls.commit, [], 'Escape must not call the commit path');
  assert.deepEqual(app.calls.patch, [], 'Escape must not PATCH the session');
  assert.equal(app._state.sessions[0].title, 'Original name', 'the session title must be unchanged');
});

test('the guard is inert when no rename is open, and for non-Escape keys', () => {
  let listeners = captureDocumentListeners();
  let app = makeApp();
  installSessionNameEditGuards(app);

  let keydownListener = listeners.find((entry) => entry.type === 'keydown');

  // No open edit: Escape must fall through to whatever else wants it.
  let idle = escapeEvent();
  keydownListener.handler(idle);
  assert.equal(idle.prevented, false, 'Escape must not be swallowed when nothing is being renamed');
  assert.equal(app.calls.render, 0, 'an idle Escape must not repaint');

  // Open edit, some other key: must not end the edit.
  app._state.editingSessionNameID = 's1';
  keydownListener.handler({ key: 'a', preventDefault() {}, stopPropagation() {} });
  assert.equal(app._state.editingSessionNameID, 's1', 'typing must not end the edit');
});

test('the guards install once per app and expose a cleanup that removes them', () => {
  let listeners = captureDocumentListeners();
  let app = makeApp();
  installSessionNameEditGuards(app);
  let afterFirst = listeners.length;
  installSessionNameEditGuards(app);
  assert.equal(listeners.length, afterFirst, 'a second install must not double-register listeners');

  assert.equal(typeof app.__sessionNameEditCleanup, 'function');
  app.__sessionNameEditCleanup();
  assert.equal(listeners.length, 0, 'cleanup must remove every listener it installed');
});

// --- 2b(c): leaving the field exits -----------------------------------------

test('leaving the field commits and exits edit mode', () => {
  let app = makeApp({ editingSessionNameID: 's1', editingSessionNameValue: 'Original name' });
  let crumb = mount(buildTopbarCrumb(app, crumbFor()));

  let field = crumb.querySelector(SESSION_NAME_INPUT_SELECTOR);
  field.dispatchEvent(new Event('focusout', { bubbles: false, cancelable: true }));

  assert.deepEqual(app.calls.commit, [ 's1' ],
    'blur-out must reach the commit path -- the handler that focus() made reachable again');
});

test('Enter commits and Escape (from the field) cancels', () => {
  let app = makeApp({ editingSessionNameEdit: true, editingSessionNameID: 's1' });
  let field = mount(buildBreadcrumbTitle(app, 'Original name', 's1'));

  keydown(field, 'Enter');
  assert.deepEqual(app.calls.commit, [ 's1' ], 'Enter must commit the name');

  keydown(field, 'Escape');
  assert.equal(app.calls.cancel, 1, 'the field-level Escape handler must still cancel');
});

// --- 2b(d): navigation ends the edit ---------------------------------------

test('navigationContextKey changes on any stack change', () => {
  let app = makeApp();
  let before = navigationContextKey(app);

  app._state.navigationStack = [ ...app._state.navigationStack, { sessionID: 's2', collapsed: false } ];
  assert.notEqual(navigationContextKey(app), before, 'pushing a session must change the context');

  let pushed = navigationContextKey(app);
  app._state.navigationStack = [ { sessionID: 's1', collapsed: false } ];
  assert.notEqual(navigationContextKey(app), pushed, 'popping back must change the context');

  let popped = navigationContextKey(app);
  app._state.navigationStack = [ { sessionID: 'null', view: 'inbox' } ];
  assert.notEqual(navigationContextKey(app), popped, 'a sidebar view switch must change the context');
});

test('navigating to another session clears the edit and the typed value', () => {
  let app = makeApp({ editingSessionNameID: 's1', editingSessionNameValue: 'Half-typed name' });
  app.__sessionNameEditContext = navigationContextKey(app);

  // Same context: the edit must survive, or every re-render would drop it.
  syncSessionNameEdit(app);
  assert.equal(app._state.editingSessionNameID, 's1', 'a plain re-render must NOT cancel the rename');

  app._state.navigationStack = [ ...app._state.navigationStack, { sessionID: 's2', collapsed: false } ];
  syncSessionNameEdit(app);

  assert.equal(app._state.editingSessionNameID, '', 'navigating must clear the edit id');
  assert.equal(app._state.editingSessionNameValue, '', 'navigating must drop the typed value');

  // And the stale crumb therefore renders static, so the input is gone.
  let after = mount(buildTopbarCrumb(app, crumbFor()));
  assert.equal(after.querySelector(SESSION_NAME_INPUT_SELECTOR), null,
    'after navigating, the crumb must render as a label, not an input');
  assert.equal(after.querySelector('.kikx-breadcrumb__editor'), null,
    'after navigating, the rename editor must be gone');
});

test('the edited session leaving the stack also clears the edit', () => {
  let app = makeApp({ editingSessionNameID: 's1', editingSessionNameValue: 'x' });
  app.__sessionNameEditContext = navigationContextKey(app);

  // Back to root: s1 is gone from the stack entirely, context key differs too.
  app._state.navigationStack = [ { sessionID: null, collapsed: true } ];
  syncSessionNameEdit(app);
  assert.equal(app._state.editingSessionNameID, '');
});

test('clearSessionNameEditState ends the edit without a stack test', () => {
  let app = makeApp({ editingSessionNameID: 's1', editingSessionNameValue: 'x' });
  clearSessionNameEditState(app);
  assert.equal(app._state.editingSessionNameID, '');
  assert.equal(app._state.editingSessionNameValue, '');

  // Idempotent: the navigation paths call it more than once.
  clearSessionNameEditState(app);
  assert.equal(app._state.editingSessionNameID, '');
});

test('the app subscribes to navigationStack as a backstop for paths that do not repaint', () => {
  let listeners = captureDocumentListeners();
  let app = makeApp();
  let subscribed = [];
  app._state.on = (key, handler) => subscribed.push({ key, handler });
  app._state.off = () => {};
  app._requestRender = () => { app.calls.requestRender = (app.calls.requestRender || 0) + 1; };

  installSessionNameEditGuards(app);
  let entry = subscribed.find((item) => item.key === 'navigationStack');
  assert.ok(entry, 'the guard must subscribe to navigationStack, not only rely on a render');

  // A stack change while renaming must clear the edit even when nothing repaints
  // on its own -- this is the "even navigating around the app won't do it" case.
  app._state.editingSessionNameID = 's1';
  entry.handler();
  assert.equal(app._state.editingSessionNameID, '', 'the subscription must clear the edit');
  assert.equal(app.calls.requestRender, 1, 'and ask for a repaint, since it cleared state');
});

// --- 2b(e): a visible way out that needs no key ----------------------------

test('the crumb renders a visible Cancel control beside the field', () => {
  let app = makeApp({ editingSessionNameID: 's1', editingSessionNameValue: 'Original name' });
  let crumb = mount(buildTopbarCrumb(app, crumbFor()));

  // The crumb builder returns the editor AS its root when editing, so the root
  // has to be accepted as the group rather than only searched as a descendant.
  let editor = crumb.classList.contains('kikx-breadcrumb__editor')
    ? crumb
    : crumb.querySelector('.kikx-breadcrumb__editor');
  assert.ok(editor, 'the field and its exits must be one editor group');

  let buttons = editor.querySelectorAll('button');
  let labels = buttons.map((node) => node.getAttribute('aria-label'));
  assert.ok(labels.includes('Cancel rename (Esc)'),
    `the editor must offer a Cancel control; got ${JSON.stringify(labels)}`);
  assert.ok(labels.includes('Save name'), 'the editor must offer a Save control');

  // Both are real buttons, so they are keyboard reachable rather than spans.
  for (let node of buttons)
    assert.equal(node.localName, 'button', 'editor actions must be real buttons');
});

test('clicking Cancel exits edit mode', () => {
  let app = makeApp({ editingSessionNameID: 's1', editingSessionNameValue: 'Original name' });
  let crumb = mount(buildTopbarCrumb(app, crumbFor()));

  let cancel = crumb.querySelectorAll('button')
    .find((node) => node.getAttribute('aria-label') === 'Cancel rename (Esc)');
  assert.ok(cancel, 'Cancel must exist before it can be clicked');
  click(cancel);

  assert.equal(app.calls.cancel, 1, 'the Cancel control must run the cancel path');
  assert.deepEqual(app.calls.commit, [], 'Cancel must never commit');
});

test('clicking Save commits the rename', () => {
  let app = makeApp({ editingSessionNameID: 's1', editingSessionNameValue: 'Original name' });
  let crumb = mount(buildTopbarCrumb(app, crumbFor()));

  let save = crumb.querySelectorAll('button')
    .find((node) => node.getAttribute('aria-label') === 'Save name');
  assert.ok(save);
  click(save);

  assert.deepEqual(app.calls.commit, [ 's1' ], 'Save must run the commit path');
});
