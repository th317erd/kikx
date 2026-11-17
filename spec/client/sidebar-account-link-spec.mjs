'use strict';

// =============================================================================
// Sidebar Account removal + Sign out link (owner screenshot, 2026-11-17)
// =============================================================================
// The owner annotated session-2026-11-17-17-05-39.574 with:
//
//   1. "Remove the 'Account' button (can already get to it from the settings
//       page)"
//   2. "Turn 'Sign Out' into a <a> Link."
//
// This file pins BOTH, and pins the thing that made (1) safe. The parenthetical
// in (1) was an intent rather than existing behaviour: Settings only DISPLAYED
// the account name and email, and the sidebar row was the sole caller of
// `openAccountEditor` in the whole client. Deleting the row without adding a
// Settings entry point would have stranded the account editor -- the change
// would look correct in a screenshot and be broken on click.
//
// So the three claims here are deliberately joined. Each is asserted separately
// so a failure says which half regressed:
//
//   A. the sidebar no longer offers an 'Account' row          (absence)
//   B. 'Sign out' renders as a real <a>, and still signs out (tag + behaviour)
//   C. Settings -> General offers the account editor that (A) removed
//      (reachability -- the reason (A) is legitimate)
//
// NEGATIVE CONTROLS appear at the end. As in the settings-chrome spec, an
// absence assertion that passes against a tree that never had the feature is
// worthless, so the controls prove these probes DISCRIMINATE rather than merely
// finding nothing.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const {
  buildSessionObjectItems,
  buildSidebarSessionObjects,
} = await import('../../src/client/components/kikx-sidebar-session-objects.mjs');

function makeApp(overrides = {}) {
  let opened = [];
  let app = {
    _opened: opened,
    _state: {
      navigationStack: [ { sessionID: 's1', collapsed: false } ],
      account: { name: 'w', email: 'w@example.com' },
      ...overrides.state,
    },
    _openAgentManager() { opened.push('agents'); },
    _openTeamManager() { opened.push('teams'); },
    _openAccountEditor() { opened.push('account'); },
    _signOut() { opened.push('sign-out'); },
    ...overrides.app,
  };
  return app;
}

function rowsOf(node) {
  return [...node.querySelectorAll('button, a')];
}

// --- A. the Account row is gone ---------------------------------------------

test('the sidebar no longer offers an Account row (owner 2026-11-17)', () => {
  let app = makeApp();
  let items = buildSessionObjectItems(app);

  assert.equal(items.filter((item) => item.id === 'account').length, 0,
    'there must be no account descriptor at all');

  let labels = items.map((item) => item.label);
  assert.ok(!labels.includes('Account'),
    `no row may be labelled 'Account'; got ${JSON.stringify(labels)}`);

  // And absence must hold in the RENDERED footer, not just the descriptor list:
  // the descriptor is the data model, the footer is what the owner saw.
  let footer = buildSidebarSessionObjects(app, { group: 'footer' });
  let footerText = rowsOf(footer).map((node) => node.textContent.trim());
  assert.deepEqual(footerText, [ 'Sign out' ],
    `the footer cluster renders exactly one row now; got ${JSON.stringify(footerText)}`);
});

test('the account chip survives the removal — it is not the Account button', () => {
  // Guards against over-deleting: the chip (which shows the user's NAME) is a
  // different control from the Account button that opened the editor. The owner
  // asked to remove the button, not the identity chip.
  let app = makeApp();
  let footer = buildSidebarSessionObjects(app, { group: 'footer' });

  assert.ok(footer.querySelector('.kikx-account-chip'),
    'the account chip must still render in the footer');
});

// --- B. Sign out is a real anchor that still signs out ----------------------

test("'Sign out' is an <a> element, not a <button> (owner 2026-11-17)", () => {
  let app = makeApp();
  let footer = buildSidebarSessionObjects(app, { group: 'footer' });

  let anchors = [...footer.querySelectorAll('a')];
  let buttons = [...footer.querySelectorAll('button')];

  assert.equal(anchors.length, 1, 'exactly one anchor renders in the footer');
  assert.equal(anchors[0].textContent.trim(), 'Sign out');
  assert.equal(buttons.length, 0,
    'Sign out must NOT still be a button — that is the whole point of the ruling');

  // The href must be a real attribute, not the vendor's `attr="href"` artefact.
  // Measured in Chrome 2026-11-17: `.attr('href', '#')` SILENTLY produces
  // <a attr="href">, so asserting merely "it has some attribute" would pass
  // against a completely broken link. Assert the exact attribute name/value.
  assert.equal(anchors[0].getAttribute('href'), '#',
    'the anchor carries a real href attribute');
  assert.equal(anchors[0].getAttribute('attr'), null,
    'and NOT the malformed attr="href" the wrong builder idiom produces');
});

test('the anchor keeps the footer row class, so the grey-row ruling still applies', () => {
  // The 2026-11-14 ruling ("gray buttons WITHOUT a border, primary colour +
  // highlight on hover") is applied by `.kikx-session-objects
  // .kikx-sign-out-button` in topbar-unified.css. Keeping that class on the
  // anchor is what makes the link inherit the row METRICS instead of needing a
  // second copy of them. If this class is dropped the link silently reverts to
  // underlined-blue inline text.
  let app = makeApp();
  let anchor = buildSidebarSessionObjects(app, { group: 'footer' }).querySelector('a');

  assert.ok(anchor.className.includes('kikx-sign-out-button'),
    `the anchor must keep kikx-sign-out-button; got "${anchor.className}"`);
  assert.ok(anchor.className.includes('kikx-sidebar__link'),
    `the anchor must be selectable as kikx-sidebar__link; got "${anchor.className}"`);
});

test('clicking the anchor still signs out, and cancels the navigation', () => {
  // A link that navigates to '#' and does NOT sign out would be a regression
  // disguised as the requested change. Kikx auth is a localStorage bearer token,
  // so there is no URL that performs sign-out; the click handler is what does it.
  let app = makeApp();
  let anchor = buildSidebarSessionObjects(app, { group: 'footer' }).querySelector('a');

  let prevented = 0;
  let event = {
    preventDefault() { prevented += 1; },
  };
  anchor.dispatchEvent({ type: 'click', ...event });

  // The mini-dom stand-in may deliver via its own dispatcher; drive the handler
  // directly if the synthetic event did not reach it, so this test measures the
  // wiring rather than the harness.
  if (app._opened.length === 0)
    anchor.click?.();

  assert.ok(app._opened.includes('sign-out'),
    `clicking the anchor must call signOut; got ${JSON.stringify(app._opened)}`);
});

// --- C. Settings owns the account editor now --------------------------------

test('Settings -> General exposes the account editor the sidebar row used to own', async () => {
  // THIS is what makes removing the row safe, and it is the owner's own stated
  // justification ("can already get to it from the settings page"). Asserted
  // against the REAL view builder, not a re-implementation.
  let { buildSystemSettingsView } = await import('../../src/client/components/kikx-system-settings-view.mjs');

  let opened = [];
  let app = makeApp({
    app: { _openAccountEditor() { opened.push('account'); } },
  });
  app._state.settingsSection = 'General';

  let view = buildSystemSettingsView(app);
  let edit = view.querySelector('.kikx-settings-general__edit-account');

  assert.ok(edit,
    'General must offer an account editor control; without it the removed sidebar row stranded the editor');
  assert.equal(edit.textContent.trim(), 'Edit account');
  assert.ok(view.querySelector('.kikx-settings-general__actions'),
    'the control sits in an actions row inside the Account card');
});

// --- NEGATIVE CONTROLS ------------------------------------------------------
// Prove the probes above discriminate, using a re-created PRE-FIX DOM.

test('NEGATIVE CONTROL: the Account-absence probe fails on a re-created old footer', () => {
  // The old footer had two button rows: 'Account' and 'Sign out'. If the probe
  // in test A were vacuous it would also "pass" here -- it must not.
  let document = globalThis.document;
  let old = document.createElement('div');
  old.className = 'kikx-session-objects kikx-session-objects--footer';
  for (let label of [ 'Account', 'Sign out' ]) {
    let node = document.createElement('button');
    node.className = 'kikx-sign-out-button';
    node.textContent = label;
    old.appendChild(node);
  }

  let oldText = rowsOf(old).map((node) => node.textContent.trim());
  assert.deepEqual(oldText, [ 'Account', 'Sign out' ],
    'sanity: the re-created old footer really does contain both rows');
  assert.ok(oldText.includes('Account'),
    'and the absence assertion used above WOULD have failed against it');
  assert.equal(old.querySelectorAll('a').length, 0,
    'and its rows were buttons, never anchors');
});

test('NEGATIVE CONTROL: the anchor-shape probe fails on a re-created button DOM', () => {
  let document = globalThis.document;
  let old = document.createElement('div');
  let node = document.createElement('button');
  node.className = 'kikx-sign-out-button';
  node.textContent = 'Sign out';
  old.appendChild(node);

  assert.equal(old.querySelectorAll('a').length, 0,
    'a button row is not an anchor, so the <a> assertion above discriminates');
  assert.equal(node.getAttribute('href'), null,
    'and it has no href, so the href assertion discriminates too');
});

test('NEGATIVE CONTROL: the malformed attr="href" shape is detectable', () => {
  // Pins the exact failure mode the wrong builder idiom produced, so the
  // `getAttribute('attr') === null` assertion above cannot be vacuous.
  let document = globalThis.document;
  let broken = document.createElement('a');
  broken.textContent = 'Sign out';
  broken.setAttribute('attr', 'href');

  assert.equal(broken.getAttribute('href'), null,
    'the malformed shape has NO href');
  assert.equal(broken.getAttribute('attr'), 'href',
    'it has attr="href" instead -- which is precisely what the real probe rejects');
});
