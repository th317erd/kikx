'use strict';

// Settings → Email store (owner, 2026-11-13). Fetcher-injected like the
// plugins store: honest loading/saving/testing flags, server messages
// verbatim, a loaded form survives failed reloads, and — the state-integrity
// doctrine — a password only ever exists in the APP's draft holder (typed,
// never in state from a GET, omitted from POSTs when blank so the stored one
// survives).

export const EMAIL_SETTINGS_KEY = 'emailSettings';
export const EMAIL_SETTINGS_URL = '/api/v1/auth/mailer/settings';
export const EMAIL_TEST_URL = '/api/v1/auth/mailer/test';

export function createEmailSettingsState() {
  return {
    loading: false,
    error: null,
    loaded: false,
    saving: false,
    testing: false,
    testResult: null,      // { ok, mode, to } on success
    passwordSet: false,    // whether a password is stored server-side
    settings: {
      provider: 'smtp',
      host: '',
      port: 587,
      username: '',
      fromAddress: '',
      fromName: '',
      tls: 'STARTTLS',
    },
  };
}

export function ensureEmailSettingsState(state) {
  if (!state || typeof state !== 'object')
    return createEmailSettingsState();
  if (!state[EMAIL_SETTINGS_KEY] || typeof state[EMAIL_SETTINGS_KEY] !== 'object')
    state[EMAIL_SETTINGS_KEY] = createEmailSettingsState();
  return state[EMAIL_SETTINGS_KEY];
}

function messageOf(error) {
  const base = error && error.message ? String(error.message) : 'email settings unavailable';
  const hint = error && error.hint ? String(error.hint) : '';
  return hint && !base.includes(hint) ? `${base} — ${hint}` : base;
}

export async function loadEmailSettings(state, fetcher) {
  if (!state || typeof state !== 'object' || typeof fetcher !== 'function')
    return null;

  const before = ensureEmailSettingsState(state);
  state[EMAIL_SETTINGS_KEY] = { ...before, loading: true, error: null };

  try {
    const json = await fetcher(EMAIL_SETTINGS_URL);
    const data = json && typeof json === 'object' && json.data && typeof json.data === 'object'
      ? json.data
      : (json || {});
    const current = ensureEmailSettingsState(state);
    state[EMAIL_SETTINGS_KEY] = {
      ...current,
      loading: false,
      error: null,
      loaded: true,
      settings: data.settings && typeof data.settings === 'object' ? data.settings : current.settings,
      passwordSet: data.passwordSet === true,
    };
  } catch (error) {
    const current = ensureEmailSettingsState(state);
    state[EMAIL_SETTINGS_KEY] = {
      ...current,
      loading: false,
      error: messageOf(error),
      loaded: current.loaded === true, // stale-but-true beats blank
    };
  }
  return state[EMAIL_SETTINGS_KEY];
}

// Save: values come from the section's APP draft merge; the password travels
// ONLY when the user typed one (blank = keep the stored password).
export async function saveEmailSettings(app, values) {
  const state = app && app._state;
  if (!state || typeof app?._postJSON !== 'function' || !values || typeof values !== 'object')
    return null;

  const before = ensureEmailSettingsState(state);
  state[EMAIL_SETTINGS_KEY] = { ...before, saving: true, error: null };

  const typedPassword = app.__emailDraft && typeof app.__emailDraft.password === 'string'
    ? app.__emailDraft.password
    : '';
  const body = { ...values, ...(typedPassword ? { password: typedPassword } : {}) };

  try {
    const json = await app._postJSON(EMAIL_SETTINGS_URL, body);
    const data = json && json.data && typeof json.data === 'object' ? json.data : {};
    const current = ensureEmailSettingsState(state);
    state[EMAIL_SETTINGS_KEY] = {
      ...current,
      saving: false,
      error: null,
      loaded: true,
      settings: data.settings && typeof data.settings === 'object' ? data.settings : current.settings,
      passwordSet: data.passwordSet === true,
      testResult: null, // settings changed — an old test result would lie
    };
    // A successful save proves the draft is committed.
    if (app.__emailDraft && typeof app.__emailDraft === 'object' && typedPassword)
      app.__emailDraft.password = '';
    return state[EMAIL_SETTINGS_KEY];
  } catch (error) {
    const current = ensureEmailSettingsState(state);
    state[EMAIL_SETTINGS_KEY] = { ...current, saving: false, error: messageOf(error) };
    return state[EMAIL_SETTINGS_KEY];
  }
}

export async function sendTestEmail(app, to) {
  const state = app && app._state;
  if (!state || typeof app?._postJSON !== 'function')
    return null;

  const before = ensureEmailSettingsState(state);
  state[EMAIL_SETTINGS_KEY] = { ...before, testing: true, error: null, testResult: null };

  try {
    const json = await app._postJSON(EMAIL_TEST_URL, { to });
    const data = json && json.data && typeof json.data === 'object' ? json.data : json || {};
    const current = ensureEmailSettingsState(state);
    state[EMAIL_SETTINGS_KEY] = { ...current, testing: false, testResult: data };
    return state[EMAIL_SETTINGS_KEY];
  } catch (error) {
    const current = ensureEmailSettingsState(state);
    state[EMAIL_SETTINGS_KEY] = { ...current, testing: false, error: messageOf(error) };
    return state[EMAIL_SETTINGS_KEY];
  }
}
