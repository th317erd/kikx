'use strict';

// Owner item 2, the BLOCKER half: clicking Cancel (x) RENAMED the session.
//
// Why this is a separate file from session-rename-escape-spec.mjs:
//
//   That file's `click()` dispatches a bare `click` event. A real pointer click
//   on a button is `mousedown` -> input blur -> `focusout` -> `click`. The defect
//   lived entirely in the `focusout` step, which the bare-click path never
//   produces, so its assertion "Cancel must never commit" was structurally
//   incapable of failing. A test that cannot fail is worse than no test: it
//   reports green on the exact owner-visible damage it was written to prevent.
//
//   This file simulates the missing step directly. Every assertion below
//   dispatches a real `focusout` on the real rendered field, through the real
//   handler the builders wire, and counts the real PATCHes the real
//   `commitSessionName` issues. Against HEAD (no guard) these fail; against the
//   guarded tree they pass. That is the discriminator that makes them
//   regression tests rather than a restatement of the fix.
//
// The two halves of the fix, and what each assertion pair covers:
//
//   1. `commitSessionNameOnFocusout` ignores a focusout whose `relatedTarget` is
//      inside `.kikx-breadcrumb__editor` (the box holding the field AND its
//      Save/Cancel buttons). Covers Chrome/Edge/Firefox, which focus a button on
//      mousedown, and Tab moving between the field and those buttons.
//
//   2. `holdSessionNameFieldFocus` calls preventDefault on the buttons'
//      `mousedown`. Safari does NOT focus a button on click, so `relatedTarget`
//      is null there and half 1 cannot possibly fire. Cancelling the default
//      mousedown means focus never leaves the input, so no `focusout` is
//      generated at all. This half is asserted structurally (the handler cancels
//      a cancelable mousedown) because mini-dom has no focus model to observe it
//      end-to-end.
//
// The click-away CONTROL matters as much as the suppression: a guard that
// returns early for too much would silently break blur-to-commit, which is a
// documented behaviour the owner relies on. So every suppression assertion sits
// beside one proving the commit still happens for a genuine click-away.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();

const navigation = await import('../../src/client/components/kikx-navigation.mjs');
const topbar = await import('../../src/client/components/kikx-topbar.mjs');
const shellBuilders = await import('../../src/client/components/kikx-shell-builders.mjs');

const {
  SESSION_NAME_EDITOR_CLASS,
  SESSION_NAME_INPUT_NAME,
  SESSION_NAME_INPUT_SELECTOR,
  cancelSessionNameEdit,
  commitSessionName,
  commitSessionNameOnFocusout,
  holdSessionNameFieldFocus,
  isInsideSessionNameEditor,
} = navigation;

const { buildTopbarCrumb } = topbar;
const { buildBreadcrumbTitle, buildEditableTitle } = shellBuilders;

// --- helpers ---------------------------------------------------------------

// The fixture wires `_commitSessionName` to the REAL module function, not a
// counter stub. That is deliberate: a stub would prove only "the handler was
// reached", while the owner's damage was a network PATCH that renamed their
// session. Counting the real `_patchJSON` calls is the difference between
// observing the intent and observing the harm.
function makeApp(state = {}) {
  let app = {
    calls: { render: 0, patch: [], cancel: 0 },
    _state: {
      editingSessionNameID: 's1',
      editingSessionNameValue: 'Half-typed name',
      navigationStack: [ { sessionID: 's1', collapsed: false } ],
      authToken: 'token',
      sessionSearch: '',
      frameFilters: {},
      account: { name: 'w' },
      // `getSessions` reads `sessionIDs` + `sessionDetailsByID`, not a flat
      // `sessions` array. Getting this wrong makes the real `commitSessionName`
      // throw inside `getSessions` instead of exercising the PATCH path, which
      // would turn every "did it commit" assertion into a fixture error.
      sessionIDs: [ 's1' ],
      sessionDetailsByID: { s1: { id: 's1', title: 'Original name' } },
      ...state,
    },
    _render() { app.calls.render += 1; },
    _commitSessionName(sessionID) { return commitSessionName(app, sessionID); },
    _cancelSessionNameEdit() { app.calls.cancel += 1; cancelSessionNameEdit(app); },
    _beginSessionNameEdit() {},
    _navigateToDepth() {},
    _onSessionNameKeydown() {},
    _onSessionSearchInput() {},
    _clearFrameFilters() {},
    _patchJSON(url, body) {
      app.calls.patch.push({ url, body });
      return Promise.resolve({ data: { session: { id: 's1', title: body.title } } });
    },
    // The guards reach the field through the app's own query surface.
    querySelector(selector) {
      return app.host ? app.host.querySelector(selector) : null;
    },
  };
  return app;
}

function crumbFor(sessionID = 's1', label = 'Original name') {
  return { sessionID, label, active: true, depth: 2 };
}

// Attach the built node like the shell does, so parentNode chains and
// `isConnected` behave the way the browser's do. Without the attachment the
// containment walk in `isInsideSessionNameEditor` would have no ancestry to
// walk and every "inside the editor" assertion would be a false pass.
function mount(app, builder) {
  let node = builder.build(document);
  let host = document.createElement('div');
  host.appendChild(node);
  document.body.appendChild(host);
  app.host = host;
  return node;
}

function mountCrumb(app, crumb = crumbFor()) {
  return mount(app, buildTopbarCrumb(app, crumb));
}

// The three homes do not share a return shape: the topbar crumb returns a
// `.kikx-breadcrumb__editor` WRAPPER holding the field plus its buttons, while
// the two legacy homes return the input itself. Resolving the field with
// `querySelectorAll` on the mounted host covers both, where `node.querySelector`
// would silently find nothing in the legacy case and make those tests vacuous.
function findField(root) {
  let matches = root.querySelectorAll(SESSION_NAME_INPUT_SELECTOR);
  if (matches.length)
    return matches[0];
  return root.localName === 'input' ? root : null;
}

// A `focusout` with a real `relatedTarget`, which is the whole point: the guard
// reads exactly this property, and a plain `new Event('focusout')` leaves it
// undefined (the "no relatedTarget" branch), which is a DIFFERENT case.
function fireFocusout(node, relatedTarget) {
  let event = new Event('focusout', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'relatedTarget', {
    configurable: true,
    value: relatedTarget,
  });
  node.dispatchEvent(event);
  return event;
}

function fireClick(node) {
  node.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
}

function fireMousedown(node) {
  return node.dispatchEvent(new Event('mousedown', { bubbles: true, cancelable: true }));
}

function findButton(root, label) {
  return root.querySelectorAll('button')
    .find((node) => node.getAttribute('aria-label') === label);
}

// `commitSessionName` is async: the state clear and the `_patchJSON` call are
// both synchronous in its prologue, but awaiting a tick removes any doubt about
// ordering when asserting "no PATCH was ever issued".
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

// --- the guard primitive ---------------------------------------------------

test('the editor containment walk does not depend on Element.closest', () => {
  // The measured reason this exists: an earlier `relatedTarget?.closest?.(...)`
  // guard evaluated to `undefined` in this jsdom-free spec DOM (it implements
  // parentNode, classList and matches, but NOT closest), silently took the
  // "not inside" branch and COMMITTED -- commits=1, patches=1 in
  // .gate/node-eng-item2-cancel-focusout.log. A guard whose failure mode is
  // "do the dangerous thing" must not be built on an optional method.
  let editor = document.createElement('div');
  editor.className = SESSION_NAME_EDITOR_CLASS;
  let cancel = document.createElement('button');
  editor.appendChild(cancel);
  document.body.appendChild(editor);

  assert.equal(typeof cancel.closest, 'undefined',
    'this spec DOM must have no closest, or it cannot reproduce the failure mode');
  assert.equal(cancel.parentNode, editor, 'the walk needs a real parentNode chain');

  assert.equal(isInsideSessionNameEditor(cancel), true,
    'a button inside the editor must be recognised without closest');
  assert.equal(isInsideSessionNameEditor(editor), true,
    'the editor box itself is inside the editor');
  assert.equal(isInsideSessionNameEditor(null), false, 'null is not inside the editor');
  assert.equal(isInsideSessionNameEditor(undefined), false,
    'a focusout with no relatedTarget must fall through to the commit branch');
});

// --- the blocker: Cancel must not commit -----------------------------------

test('BLOCKER: focusout to the Cancel button does not commit', () => {
  let app = makeApp();
  let crumb = mountCrumb(app);
  let field = findField(crumb);
  let cancel = findButton(crumb, 'Cancel rename (Esc)');

  assert.ok(field, 'the rename field must be rendered so it can receive the focusout');
  assert.ok(cancel, 'the Cancel control must exist');

  fireFocusout(field, cancel);

  assert.deepEqual(app.calls.patch, [],
    'focus moving to Cancel must NOT PATCH the half-typed name');
  assert.equal(app._state.editingSessionNameID, 's1',
    'Cancel must not implicitly end the edit before its own click handler runs');
});

test('BLOCKER: focusout to the Save button does not commit early', () => {
  let app = makeApp();
  let crumb = mountCrumb(app);
  let field = findField(crumb);
  let save = findButton(crumb, 'Save name');

  assert.ok(field && save);

  fireFocusout(field, save);

  // Save commits on its own click. A commit from the focusout as well is the
  // double-PATCH half of the same defect: the second one is a no-op that hides
  // the first, so it looked correct in a browser.
  assert.deepEqual(app.calls.patch, [],
    'focus moving to Save must not PATCH; Save commits exactly once on click');
});

test('BLOCKER: the real pointer sequence leaves the title untouched', async () => {
  // The owner-visible sequence, in browser order: focusout first (because the
  // button is about to receive focus), then the click that means "cancel".
  let app = makeApp();
  let crumb = mountCrumb(app);
  let field = findField(crumb);
  let cancel = findButton(crumb, 'Cancel rename (Esc)');

  fireFocusout(field, cancel);
  fireClick(cancel);
  await tick();

  assert.equal(app.calls.cancel, 1, 'Cancel must actually run its handler');
  assert.deepEqual(app.calls.patch, [],
    'the session title must be untouched after focusout + Cancel click');
  assert.equal(app._state.editingSessionNameID, '',
    'Cancel must leave edit mode');
});

// --- the click-away control: suppression must not over-reach ---------------

test('CONTROL: focusout to something outside the editor still commits once', async () => {
  let app = makeApp();
  let crumb = mountCrumb(app);
  let field = findField(crumb);
  let outside = document.createElement('a');
  document.body.appendChild(outside);

  fireFocusout(field, outside);
  await tick();

  assert.equal(app.calls.patch.length, 1,
    'a genuine click-away must still commit -- blur-to-commit is documented behaviour');
  assert.equal(app.calls.patch[0].body.title, 'Half-typed name',
    'the commit must carry the typed value');
});

test('CONTROL: a focusout with no relatedTarget still commits once', async () => {
  // This is the Safari shape. Half 1 of the fix cannot fire here, which is
  // exactly why half 2 (mousedown preventDefault) exists rather than relying on
  // the guard alone. Asserting the commit still lands keeps the fallback honest.
  let app = makeApp();
  let crumb = mountCrumb(app);
  let field = findField(crumb);

  fireFocusout(field, null);
  await tick();

  assert.equal(app.calls.patch.length, 1,
    'with no relatedTarget the guard must not suppress the commit');
});

test('CONTROL: no field is rendered when no rename is open', () => {
  // The guard must be inert rather than load-bearing when there is nothing to
  // commit; `commitSessionName` returns early on its own state check.
  let app = makeApp({ editingSessionNameID: '', editingSessionNameValue: '' });
  let crumb = mountCrumb(app);

  assert.equal(findField(crumb), null, 'no field is rendered outside edit mode');
});

// --- half 2: Safari's missing focusout -------------------------------------

test('mousedown on Cancel is cancelled, so Safari generates no focusout', () => {
  let app = makeApp();
  let crumb = mountCrumb(app);
  let cancel = findButton(crumb, 'Cancel rename (Esc)');

  assert.ok(cancel);
  let notCancelled = fireMousedown(cancel);

  // dispatchEvent returns false when a listener called preventDefault.
  assert.equal(notCancelled, false,
    'mousedown must be prevented: that is what keeps focus on the field in Safari');
});

test('mousedown on Save is cancelled too', () => {
  let app = makeApp();
  let crumb = mountCrumb(app);
  let save = findButton(crumb, 'Save name');

  assert.ok(save);
  assert.equal(fireMousedown(save), false,
    'Save needs the same protection as Cancel');
});

test('holdSessionNameFieldFocus is safe on a missing event', () => {
  // The browser always passes an event, but a guard that throws on a null event
  // would break the whole editor rather than a single click.
  assert.doesNotThrow(() => holdSessionNameFieldFocus());
  assert.doesNotThrow(() => holdSessionNameFieldFocus({}));
});

// --- the guard is wired at EVERY home, not just the visible one -----------
//
// There are three builders that render the rename field. The owner sees the
// topbar crumb; the other two are older homes that are currently unreachable
// from the app (buildEditableTitle is assigned but never called, and
// buildBreadcrumbTitle appears only in a comment). They are still asserted,
// because "unreachable today" is not a property a future caller inherits, and a
// half-wired helper is exactly how this defect would come back.

const HOMES = [
  [ 'topbar crumb', (app) => mount(app, buildTopbarCrumb(app, crumbFor())) ],
  [ 'editable title', (app) => mount(app, buildEditableTitle(app, 'Original name', 's1')) ],
  [ 'breadcrumb title', (app) => mount(app, buildBreadcrumbTitle(app, 'Original name', 's1')) ],
];

for (let [ name, render ] of HOMES) {
  test(`the ${name} field routes its focusout through the guarded helper`, async () => {
    let app = makeApp();
    let node = render(app);
    let field = findField(node);

    assert.ok(field, `the ${name} home must render the shared rename field`);
    assert.equal(field.getAttribute('name'), SESSION_NAME_INPUT_NAME,
      `the ${name} field must carry the shared input name`);

    // An outside relatedTarget: the commit must still happen through this home.
    let outside = document.createElement('a');
    document.body.appendChild(outside);
    fireFocusout(field, outside);
    await tick();

    assert.equal(app.calls.patch.length, 1,
      `the ${name} focusout must commit on a genuine click-away`);
    assert.equal(app.calls.patch[0].url, '/api/v1/sessions/s1');
  });
}

test('every home suppresses the commit when focus lands inside the editor', async () => {
  // Built once per home; the relatedTarget is a node that carries the editor
  // class, which is what the browser would report for Save/Cancel.
  for (let [ name, render ] of HOMES) {
    let app = makeApp();
    let node = render(app);
    let field = findField(node);

    assert.ok(field, `the ${name} home must render the shared rename field`);

    let editorControl = document.createElement('button');
    let editor = document.createElement('div');
    editor.className = SESSION_NAME_EDITOR_CLASS;
    editor.appendChild(editorControl);
    document.body.appendChild(editor);

    fireFocusout(field, editorControl);
    await tick();

    assert.deepEqual(app.calls.patch, [],
      `the ${name} home must not commit when focus lands on the editor's own control`);
  }
});

// --- the helper itself, in isolation --------------------------------------

test('commitSessionNameOnFocusout commits for an outside target', async () => {
  let app = makeApp();
  let outside = document.createElement('a');
  document.body.appendChild(outside);

  commitSessionNameOnFocusout(app, { relatedTarget: outside }, 's1');
  await tick();

  assert.equal(app.calls.patch.length, 1);
});

test('commitSessionNameOnFocusout is inert for an editor target', async () => {
  let app = makeApp();
  let editor = document.createElement('div');
  editor.className = SESSION_NAME_EDITOR_CLASS;
  document.body.appendChild(editor);

  commitSessionNameOnFocusout(app, { relatedTarget: editor }, 's1');
  await tick();

  assert.deepEqual(app.calls.patch, []);
  assert.equal(app._state.editingSessionNameID, 's1',
    'an editor-internal focus move must leave the edit open');
});
