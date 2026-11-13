'use strict';

// Settings → Email section (owner, 2026-11-13 — ported from the Xenocept
// reference screenshot): Email Configuration form — Provider(SMTP)/Host/
// Port/Username/Password(stored on save)/From Address/From Name/TLS +
// Save + Send Test Email. The fields render EVEN WHEN THE GET FAILED (an
// error banner rides above them — an empty panel reads as a bug). Typed
// values live in the APP's draft holder (never only in DOM nodes); rebuilds
// restore from draft → store, and keystrokes never touch ReactiveState.

import { elements } from '../lib/aeor-ui.mjs';
import {
  ensureEmailSettingsState,
  loadEmailSettings,
  saveEmailSettings,
  sendTestEmail,
} from '../state/email-settings.mjs';

const { button, div, h3, input, p, span } = elements;

const FIELD_LABELS = {
  host: 'Host',
  port: 'Port',
  username: 'Username',
  password: 'Password',
  fromAddress: 'From Address',
  fromName: 'From Name',
};

const FIELD_TYPES = {
  host: 'text',
  port: 'number',
  username: 'text',
  password: 'password',
  fromAddress: 'text',
  fromName: 'text',
};

const FIELD_PLACEHOLDERS = {
  host: 'smtp.example.com',
  port: '587',
  username: 'user@example.com',
  password: '(stored on save)',
  fromAddress: 'noreply@example.com',
  fromName: 'Kikx',
};

export function buildEmailSection(app) {
  const state = (app && app._state) || {};
  const store = ensureEmailSettingsState(state);
  const draft = app.__emailDraft && typeof app.__emailDraft === 'object' ? app.__emailDraft : {};
  const value = (key) => (typeof draft[key] === 'string' || typeof draft[key] === 'number'
    ? String(draft[key])
    : String(store.settings?.[key] ?? ''));

  const setDraft = (key, next) => {
    // Draft on the APP: keystrokes never touch ReactiveState (no rebuild can
    // destroy the focused input), and rebuilds restore draft → store.
    app.__emailDraft = { ...(app.__emailDraft || {}), [key]: next };
  };

  return div.class('kikx-settings-email')(
    h3('Email Configuration'),
    p.class('kikx-settings-email__desc')(
      'Configure an email server so Kikx can deliver magic links by email. The password is stored on save and never sent back.',
    ),
    store.error
      ? p.class('kikx-settings-email__error')(store.error)
      : null,
    store.loading && !store.loaded
      ? p.class('kikx-settings-email__loading')('Loading email settings…')
      : null,

    div.class('kikx-settings-email__field')(
      span.class('kikx-settings-email__label')('Provider'),
      buildSelect('provider', [ { value: 'smtp', label: 'SMTP' } ], value('provider'), app, setDraft),
    ),
    div.class('kikx-settings-email__field')(
      span.class('kikx-settings-email__label')('TLS'),
      buildSelect('tls', [
        { value: 'STARTTLS', label: 'STARTTLS' },
        { value: 'SSL', label: 'SSL' },
        { value: 'none', label: 'None' },
      ], value('tls'), app, setDraft),
    ),

    ...Object.keys(FIELD_LABELS).map((key) => div.class('kikx-settings-email__field')(
      span.class('kikx-settings-email__label')(FIELD_LABELS[key]),
      input.type(FIELD_TYPES[key])
        .class('kikx-settings-email__input')
        .name(key)
        .placeholder(FIELD_PLACEHOLDERS[key])
        .value(value(key))
        .onInput((event) => setDraft(key, event?.target?.value ?? ''))(),
    )),

    div.class('kikx-settings-email__actions')(
      button.type('button')['data-action']('save-email')
        .class('kikx-settings-email__save')
        .disabled(store.saving)
        .onClick(() => runSave(app))(
        store.saving ? 'Saving…' : 'Save',
      ),
      input.type('text')
        .class('kikx-settings-email__input kikx-settings-email__test-to')
        .name('testTo')
        .placeholder('test@example.com')
        .value(typeof draft.testTo === 'string' ? draft.testTo : '')
        .onInput((event) => setDraft('testTo', event?.target?.value ?? ''))(),
      button.type('button')['data-action']('test-email')
        .class('kikx-settings-email__save')
        .disabled(store.testing)
        .onClick(() => runTest(app))(
        store.testing ? 'Sending…' : 'Send Test Email',
      ),
    ),

    store.testResult && store.testResult.ok
      ? p.class('kikx-settings-email__result kikx-settings-email__result--ok')(
        `Test email sent (${store.testResult.mode} mode).`,
      )
      : null,
    store.testResult && !store.testResult.ok
      ? p.class('kikx-settings-email__result kikx-settings-email__result--fail')('Test email failed.')
      : null,
  );
}

// <aeor-select> as a real element (the DSL has no select builder): options are
// <option> children, value rides the attribute, change feeds the APP draft.
function buildSelect(name, options, current, app, setDraft) {
  const select = document.createElement('aeor-select');
  select.setAttribute('name', name);
  select.setAttribute('value', current || (options[0] && options[0].value) || '');
  select.setAttribute('aria-label', name === 'tls' ? 'TLS' : 'Provider');
  for (const option of options) {
    const node = document.createElement('option');
    node.setAttribute('value', option.value);
    node.textContent = option.label;
    select.appendChild(node);
  }
  select.addEventListener('change', (event) => {
    const next = event?.target?.value ?? event?.detail?.value;
    if (typeof next === 'string')
      setDraft(name, next);
  });
  return select;
}

function collectValues(app) {
  const store = ensureEmailSettingsState((app && app._state) || {});
  const draft = app.__emailDraft && typeof app.__emailDraft === 'object' ? app.__emailDraft : {};
  const merged = { ...(store.settings || {}), ...draft };
  // The password is NEVER part of store.settings — only the typed draft.
  return merged;
}

async function runSave(app) {
  await saveEmailSettings(app, collectValues(app));
}

async function runTest(app) {
  const draft = app.__emailDraft && typeof app.__emailDraft === 'object' ? app.__emailDraft : {};
  const to = typeof draft.testTo === 'string' ? draft.testTo.trim() : '';
  await sendTestEmail(app, to);
}

// Re-exported for the store's first-open wiring (view calls this on section
// build, mirroring maybeLoadSystemSettingsPlugins).
export function maybeLoadEmailSettings(app, fetcher) {
  const state = app && app._state;
  if (!state || typeof fetcher !== 'function')
    return;
  const store = ensureEmailSettingsState(state);
  if (store.loaded || store.loading)
    return;
  void loadEmailSettings(state, fetcher).catch(() => {});
}
