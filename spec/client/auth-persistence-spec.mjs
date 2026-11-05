'use strict';

// Token durability (owner, 2026-11-05): "Our session tokens dying when I close
// the browser is getting REALLY annoying... tokens aren't attached to a
// _browser session_, and instead just expire naturally (after 30 days)."
//
// The server already does its half: refreshTTLSeconds defaults to 2592000
// (30 days, sliding on each rotation — auth-service.mjs:22, create-server
// parseEnvPositiveInteger fallback). What killed the session was the CLIENT
// half: the primary token lived in sessionStorage, which the browser takes
// when it closes. These tests pin the durable-storage contract:
//
//   1. a localStorage-only token boots the app (the browser-closed case);
//   2. a legacy sessionStorage copy still boots AND migrates to the durable
//      slot on read;
//   3. the newest candidate wins (sibling-tab rotation), and wins into the
//      durable slot;
//   4. persist writes all three homes; logout clears all three — a durable
//      copy left behind would log the next cold start straight back in.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);
const { document, window } = installDom();
globalThis.document = document;
globalThis.window = window;

const { loadSavedAuth } = await import('../../src/client/state/kikx-state.mjs');
const { persistAuthSession, clearAuthSession } = await import('../../src/client/components/kikx-data.mjs');

const SESSION_KEY = 'kikx.auth.session';
const SHARED_KEY = 'kikx.auth.shared';

function createStorage() {
  let values = new Map();
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    clear() { values.clear(); },
  };
}

function installStorage() {
  let session = createStorage();
  let local = createStorage();
  globalThis.sessionStorage = session;
  globalThis.localStorage = local;
  return { session, local };
}

function auth(token, refresh, expiresAt) {
  return { token, refresh_token: refresh, expires_at: expiresAt };
}

test('a localStorage-only token boots the app (the browser was closed)', () => {
  let { session, local } = installStorage();
  local.setItem(SESSION_KEY, JSON.stringify(auth('durable-access', 'durable-refresh', Date.now() + 60_000)));

  let saved = loadSavedAuth();

  assert.equal(saved.token, 'durable-access', 'a fresh browser reads the durable slot');
  assert.equal(saved.refresh_token, 'durable-refresh');
  assert.equal(session.getItem(SESSION_KEY), null, 'no sessionStorage participation was needed');
});

test('a legacy sessionStorage token still boots and migrates to the durable slot', () => {
  let { session, local } = installStorage();
  session.setItem(SESSION_KEY, JSON.stringify(auth('legacy-access', 'legacy-refresh', Date.now() + 60_000)));

  let saved = loadSavedAuth();

  assert.equal(saved.token, 'legacy-access', 'pre-change sessions keep working');
  let durable = JSON.parse(local.getItem(SESSION_KEY));
  assert.equal(durable.token, 'legacy-access', 'the copy migrates to localStorage on read');
  assert.equal(durable.refresh_token, 'legacy-refresh');
});

test('the newest candidate wins and lands in the durable slot', () => {
  let { session, local } = installStorage();
  let older = Date.now() + 60_000;
  let newer = Date.now() + 120_000;
  local.setItem(SESSION_KEY, JSON.stringify(auth('durable-old', 'refresh-old', older)));
  session.setItem(SESSION_KEY, JSON.stringify(auth('session-copy', 'refresh-session', older)));
  local.setItem(SHARED_KEY, JSON.stringify(auth('shared-rotated', 'refresh-shared', newer)));

  let saved = loadSavedAuth();

  assert.equal(saved.token, 'shared-rotated', 'a sibling tab\'s rotation supersedes stale copies');
  let durable = JSON.parse(local.getItem(SESSION_KEY));
  assert.equal(durable.token, 'shared-rotated', 'the winner is written back to the durable slot');
  assert.equal(durable.refresh_token, 'refresh-shared');
});

test('persistAuthSession writes all three homes, clearAuthSession clears them all', () => {
  let { session, local } = installStorage();

  persistAuthSession(auth('access', 'refresh', Date.now() + 60_000));
  assert.ok(local.getItem(SESSION_KEY), 'durable home written');
  assert.ok(session.getItem(SESSION_KEY), 'legacy mirror written for coherence');
  assert.ok(local.getItem(SHARED_KEY), 'shared rotation key written');

  clearAuthSession();
  assert.equal(local.getItem(SESSION_KEY), null, 'logout clears the durable token');
  assert.equal(session.getItem(SESSION_KEY), null);
  assert.equal(local.getItem(SHARED_KEY), null, 'logout leaves nothing that could re-auth a cold start');
});

test('with no tokens anywhere the boot read is empty (login screen)', () => {
  installStorage();
  assert.deepEqual(loadSavedAuth(), {});
});
