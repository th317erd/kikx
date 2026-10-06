'use strict';

import { getJSON } from './kikx-data.mjs';

export async function onMagicLinkSubmit(app, event) {
  event.preventDefault();
  let email = app._state.authEmail.trim();
  if (!email) {
    app._state.authStatus = 'Email is required';
    app._state.authStatusKind = 'error';
    return;
  }

  app._state.authStatus = 'Requesting magic link...';
  app._state.authStatusKind = 'pending';

  try {
    await app._postJSON('/api/v1/auth/magic-link', { email });
    app._state.authStatus = 'If the account exists, a login link has been sent.';
    app._state.authStatusKind = 'ready';
  } catch (error) {
    app._state.authStatus = error.message;
    app._state.authStatusKind = 'error';
  }
}

export async function verifyMagicLink(app, code) {
  if (!code) {
    app._state.authStatus = 'Code is required';
    app._state.authStatusKind = 'error';
    return;
  }

  app._state.authStatus = 'Verifying magic link...';
  app._state.authStatusKind = 'pending';

  try {
    let result = await getJSON(app, `/api/v1/auth/magic-link/verify?code=${encodeURIComponent(code)}`);
    app._applyAuth(result.data);
  } catch (error) {
    app._state.authStatus = error.message;
    app._state.authStatusKind = 'error';
  }
}
