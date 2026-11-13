'use strict';

import '../support/test-env.mjs';

import { register } from 'node:module';
import { readFile } from 'node:fs/promises';

// The section builds real elements through aeor-ui, which imports the
// browser-absolute /vendor/aeor-web-components path — the frame-item loader
// maps it for Node, mini-dom provides the DOM the builder needs.
register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);
const { installDom } = await import('./support/mini-dom.mjs');
installDom();

// Settings → Email client (owner, 2026-11-13): a form over an injected
// fetcher store, mirroring the plugins store discipline: honest loading/
// saving/testing flags, server messages verbatim, a blank password field
// NEVER overwrites the stored one, typed drafts live on the APP (never only
// in DOM nodes), and the fields render even when the GET fails (a fixture
// server without these routes must still show a form, with the error above
// it — an empty panel reads as a bug).

import assert from 'node:assert/strict';
import test from 'node:test';

function makeApp(stateOverrides = {}) {
  return {
    _state: { account: { name: 'Wyatt', email: 'w@example.com' }, navigationStack: [ { sessionID: null, collapsed: true } ], ...stateOverrides },
    _posts: [],
    async _getJSON() { throw new Error('_getJSON not stubbed'); },
    async _postJSON(url, body) { this._posts.push([ url, body ]); return { data: { ok: true } }; },
    _render() {},
    _requestRender() {},
  };
}

const FULL = {
  provider: 'smtp', host: 'smtp.example.com', port: 587, username: 'u@example.com',
  fromAddress: 'a@b.c', fromName: 'Kikx', tls: 'STARTTLS',
};

test('store: load unwraps settings, keeps server messages, never stores a password', async () => {
  const { loadEmailSettings, createEmailSettingsState } = await import('../../src/client/state/email-settings.mjs');

  const state = {};
  await loadEmailSettings(state, async () => ({ data: { settings: FULL, passwordSet: true } }));
  let store = state.emailSettings;
  assert.equal(store.loaded, true);
  assert.equal(store.loading, false);
  assert.equal(store.settings.host, 'smtp.example.com');
  assert.equal(store.passwordSet, true);
  assert.equal('password' in store.settings, false, 'a password never enters client state from a GET');

  await loadEmailSettings(state, async () => { const e = new Error('Sign in required to change email settings'); throw e; });
  store = state.emailSettings;
  assert.match(store.error, /Sign in required/, 'server message verbatim');
  assert.deepEqual(store.settings.host, 'smtp.example.com', 'a failed reload keeps the loaded form');
  assert.equal(store.loading, false);

  assert.equal(createEmailSettingsState().loading, false, 'defaults are honest');
});

test('store: save omits a blank password (stored one survives), testing flags honestly', async () => {
  const { saveEmailSettings, sendTestEmail, loadEmailSettings } = await import('../../src/client/state/email-settings.mjs');

  const state = {};
  await loadEmailSettings(state, async () => ({ data: { settings: FULL, passwordSet: true } }));

  // draft on the APP holder: typed values live outside the DOM
  const app = makeApp({ emailSettings: state.emailSettings });
  app._state = state;
  app.__emailDraft = { password: '' };
  const posts = [];
  // The mock ECHOES what was sent — the store adopting the server's echo is
  // exactly the contract under test.
  app._postJSON = async (url, body) => {
    posts.push([ url, body ]);
    if (url.includes('/test'))
      return { data: { ok: true, mode: 'log', to: body.to } };
    return { data: { settings: body, passwordSet: true } };
  };

  await saveEmailSettings(app, { ...FULL, host: 'new.example' });
  assert.equal(posts[0][0], '/api/v1/auth/mailer/settings');
  assert.equal('password' in posts[0][1], false, 'blank password field → key OMITTED, server keeps the stored one');
  assert.equal(app._state.emailSettings.saving, false, 'saving clears');
  assert.equal(app._state.emailSettings.settings.host, 'new.example', 'saved settings land in the store');

  // a typed password DOES travel
  app.__emailDraft.password = 'typed-secret';
  await saveEmailSettings(app, { ...FULL });
  assert.equal(posts[1][1].password, 'typed-secret', 'a typed password is sent');

  await sendTestEmail(app, 'me@example.com');
  assert.equal(posts[2][0], '/api/v1/auth/mailer/test');
  assert.deepEqual(posts[2][1], { to: 'me@example.com' });
  assert.equal(app._state.emailSettings.testing, false, 'testing clears');
});

test('the Email section renders the reference form even when the GET failed', async () => {
  let { buildEmailSection } = await import('../../src/client/components/kikx-settings-email-section.mjs');
  let { createEmailSettingsState } = await import('../../src/client/state/email-settings.mjs');

  const app = makeApp({
    emailSettings: { ...createEmailSettingsState(), error: 'Sign in required to change email settings', settings: { ...FULL } },
  });
  const built = buildEmailSection(app);
  const node = typeof built.build === 'function' ? built.build(document) : built;

  const text = [];
  const names = [];
  const selects = [];
  (function walk(n) {
    if (!n) return;
    if (n.nodeType === 3) text.push(n.textContent || '');
    if (n.getAttribute?.('name')) names.push(n.getAttribute('name'));
    if (n.localName === 'aeor-select') selects.push(n.getAttribute('name'));
    for (const c of n.childNodes || []) walk(c);
  })(node);
  const all = text.join(' ');

  assert.match(all, /Sign in required/, 'the error stays readable above/inside the form');
  for (const field of [ 'host', 'port', 'username', 'password', 'fromAddress', 'fromName' ])
    assert.ok(names.includes(field), `field ${field} renders even on a failed load`);
  assert.ok(selects.includes('provider'), 'Provider is a select');
  assert.ok(selects.includes('tls'), 'TLS is a select');
  assert.match(all, /magic/i, 'the reference description mentions magic links');

  const buttons = [];
  (function walk(n) {
    if (!n) return;
    if (n.getAttribute?.('data-action')) buttons.push(n.getAttribute('data-action'));
    for (const c of n.childNodes || []) walk(c);
  })(node);
  assert.ok(buttons.includes('save-email'), 'Save exists');
  assert.ok(buttons.includes('test-email'), 'Send Test Email exists');
});

test('layout: config half, divider, and test half are separate blocks (owner 2026-11-13)', async () => {
  const { buildEmailSection } = await import('../../src/client/components/kikx-settings-email-section.mjs');
  const app = makeApp();
  const built = buildEmailSection(app);
  const node = typeof built.build === 'function' ? built.build(document) : built;

  const walk = (root, visit) => {
    (function go(current) {
      if (!current) return;
      visit(current);
      for (const child of current.childNodes || []) go(child);
    })(root);
  };
  const has = (n, cls) => Boolean(n && ((n.classList && n.classList.contains(cls))
    || (typeof n.className === 'string' && n.className.split(/\s+/).includes(cls))));
  const findAll = (cls) => { const hits = []; walk(node, (n) => { if (has(n, cls)) hits.push(n); }); return hits; };
  // Containment proven DOWNWARD from each block (the mini-dom harness wires
  // childNodes reliably; this also asserts the block OWNS its controls).
  const containsAction = (block, name) => {
    let found = false;
    walk(block, (n) => { if (n.getAttribute?.('data-action') === name) found = true; });
    return found;
  };
  const containsName = (block, name) => {
    let found = false;
    walk(block, (n) => { if (n.getAttribute?.('name') === name) found = true; });
    return found;
  };

  const saveRow = findAll('kikx-settings-email__save-row')[0];
  const divider = findAll('kikx-settings-email__divider')[0];
  const testRow = findAll('kikx-settings-email__test-row')[0];
  assert.ok(saveRow && divider && testRow, 'all three blocks render');
  assert.equal(findAll('kikx-settings-email__actions').length, 0, 'the old shared row is gone');

  assert.ok(containsAction(saveRow, 'save-email'), 'the Save block owns the Save button');
  assert.equal(containsAction(saveRow, 'test-email'), false, 'Save shares nothing with the test half');
  assert.equal(containsName(saveRow, 'testTo'), false, 'Save shares nothing with the test input');
  assert.ok(containsAction(testRow, 'test-email'), 'the test block owns Send Test Email');
  assert.ok(containsName(testRow, 'testTo'), 'the test block owns its input');
  assert.equal(containsAction(testRow, 'save-email'), false, 'Save is not in the test block');

  // The divider is a DIRECT child of the section, strictly between the blocks.
  const children = node.childNodes || [];
  assert.ok(children.includes(divider), 'the divider is a direct sibling, not nested in a block');
  const saveIndex = children.indexOf(saveRow);
  const dividerIndex = children.indexOf(divider);
  const testIndex = children.indexOf(testRow);
  assert.ok(saveIndex !== -1 && testIndex !== -1, 'both blocks are direct siblings');
  assert.ok(saveIndex < dividerIndex && dividerIndex < testIndex,
    'order: config half → divider → test half');
});

test('the sections model now carries General / Email / Plugins', async () => {
  const { settingsSections, SETTINGS_SECTIONS } = await import('../../src/client/components/kikx-system-settings-view.mjs');
  assert.deepEqual(SETTINGS_SECTIONS, [ 'General', 'Email', 'Plugins' ], 'Email joins the base trio (Xenocept order, minus Destinations)');
  assert.deepEqual(settingsSections({}), [ 'General', 'Email', 'Plugins' ]);
});
