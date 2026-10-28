'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameRuntime } from '../../../src/core/runtime/frame-runtime.mjs';
import {
  normalizePreferences,
  OCR_IMAGE_PROXY_PREFERENCE,
  resolvePreferencesFromSessions,
  SESSION_PREFERENCE_DEFAULTS,
} from '../../../src/core/preferences/index.mjs';
import {
  createIDGenerator,
  createMemoryFrameStore,
  quietLogger,
} from './support/memory-frame-store.mjs';

test('normalizePreferences accepts booleans, finite numbers, and strings; unknown keys are allowed', () => {
  assert.deepEqual(normalizePreferences({
    'ocr.image_proxy': false,
    'custom.count': 3,
    'custom.ratio': -0.5,
    'custom.label': 'compact mode',
  }), {
    'ocr.image_proxy': false,
    'custom.count': 3,
    'custom.ratio': -0.5,
    'custom.label': 'compact mode',
  });

  assert.deepEqual(normalizePreferences(null), {});
  assert.deepEqual(normalizePreferences(undefined), {});
});

test('normalizePreferences rejects malformed keys and non-scalar/unsafe values', () => {
  assert.throws(() => normalizePreferences({ '': true }), /non-empty/);
  assert.throws(() => normalizePreferences({ 'bad key': true }), /Invalid preference key/);
  assert.throws(() => normalizePreferences({ ['__proto__']: true }), /Reserved preference key/);
  assert.throws(() => normalizePreferences({ constructor: true }), /Reserved preference key/);
  assert.throws(() => normalizePreferences({ 'k': null }), /boolean, number, or string/);
  assert.throws(() => normalizePreferences({ 'k': { nested: true } }), /boolean, number, or string/);
  assert.throws(() => normalizePreferences({ 'k': NaN }), /finite/);
  assert.throws(() => normalizePreferences({ 'k': Infinity }), /finite/);
  assert.throws(() => normalizePreferences([]), /must be an object/);
});

test('resolvePreferencesFromSessions lets the nearest ancestor override without freezing inherited keys', () => {
  let sessions = {
    root: { id: 'root', parentSessionID: null, preferences: { 'ocr.image_proxy': false, theme: 'dark', size: 12 } },
    child: { id: 'child', parentSessionID: 'root', preferences: { theme: 'blue' } },
    grandchild: { id: 'grandchild', parentSessionID: 'child', preferences: {} },
    sibling: { id: 'sibling', parentSessionID: 'root', preferences: { size: 14 } },
  };

  assert.deepEqual(resolvePreferencesFromSessions(sessions, 'grandchild').preferences, {
    ...SESSION_PREFERENCE_DEFAULTS,
    'ocr.image_proxy': false,
    theme: 'blue',
    size: 12,
  });
  assert.deepEqual(resolvePreferencesFromSessions(sessions, 'sibling').preferences, {
    ...SESSION_PREFERENCE_DEFAULTS,
    'ocr.image_proxy': false,
    theme: 'dark',
    size: 14,
  });
  assert.deepEqual(resolvePreferencesFromSessions(sessions, 'root').chain, [ 'root' ]);
});

test('FrameRuntime inherits preferences parent-to-child and returns the nearest override', async () => {
  let store = createMemoryFrameStore();
  let runtime = createRuntime(store, [ 'root', 'child', 'grandchild', 'sibling' ]);

  await runtime.createSession({ id: 'root', title: 'Root', preferences: { 'ocr.image_proxy': false, theme: 'dark' } });
  await runtime.createSession({ id: 'child', title: 'Child', parentSessionID: 'root', preferences: { theme: 'blue' } });
  await runtime.createSession({ id: 'grandchild', title: 'Grandchild', parentSessionID: 'child', preferences: {} });
  await runtime.createSession({ id: 'sibling', title: 'Sibling', parentSessionID: 'root', preferences: { 'ocr.image_proxy': true } });

  assert.deepEqual((await runtime.getEffectivePreferences('grandchild')).preferences, {
    ...SESSION_PREFERENCE_DEFAULTS,
    'ocr.image_proxy': false,
    theme: 'blue',
  });
  assert.deepEqual((await runtime.getEffectivePreferences('sibling')).preferences, {
    ...SESSION_PREFERENCE_DEFAULTS,
    'ocr.image_proxy': true,
    theme: 'dark',
  });
});

test('disabling the OCR image-proxy security preference on a parent disables it for descendants unless overridden', async () => {
  let store = createMemoryFrameStore();
  let runtime = createRuntime(store, [ 'root', 'child', 'override', 'overrideChild' ]);

  await runtime.createSession({ id: 'root', title: 'Root' });
  await runtime.createSession({ id: 'child', title: 'Child', parentSessionID: 'root' });
  await runtime.createSession({ id: 'override', title: 'Override', parentSessionID: 'child', preferences: { [OCR_IMAGE_PROXY_PREFERENCE]: true } });
  await runtime.createSession({ id: 'overrideChild', title: 'Override child', parentSessionID: 'override' });

  assert.equal(await runtime.getEffectivePreference('root', OCR_IMAGE_PROXY_PREFERENCE), true);
  await runtime.updateSession('root', { preferences: { [OCR_IMAGE_PROXY_PREFERENCE]: false } });

  assert.equal(await runtime.getEffectivePreference('root', OCR_IMAGE_PROXY_PREFERENCE), false);
  assert.equal(await runtime.getEffectivePreference('child', OCR_IMAGE_PROXY_PREFERENCE), false);
  assert.equal(await runtime.getEffectivePreference('override', OCR_IMAGE_PROXY_PREFERENCE), true);
  assert.equal(await runtime.getEffectivePreference('overrideChild', OCR_IMAGE_PROXY_PREFERENCE), true);
});

test('preferences persist in the session manifest and survive a runtime reload', async () => {
  let store = createMemoryFrameStore();
  let runtime = createRuntime(store, [ 'root', 'child' ]);

  await runtime.createSession({ id: 'root', title: 'Root', preferences: { 'ocr.image_proxy': false } });
  await runtime.createSession({ id: 'child', title: 'Child', parentSessionID: 'root' });
  await runtime.updateSession('child', { preferences: { 'custom.label': 'inherited check' } });
  await store.flush();

  let persistedRoot = store.sessions.get('root');
  let persistedChild = store.sessions.get('child');
  assert.deepEqual(persistedRoot.preferences, { 'ocr.image_proxy': false });
  assert.deepEqual(persistedChild.preferences, { 'custom.label': 'inherited check' });

  // A fresh runtime has no live session cache; resolution must read the manifest
  // chain back from durable storage.
  let reloaded = createRuntime(store, []);
  assert.deepEqual((await reloaded.getEffectivePreferences('child')).preferences, {
    ...SESSION_PREFERENCE_DEFAULTS,
    'ocr.image_proxy': false,
    'custom.label': 'inherited check',
  });
  assert.equal(await reloaded.getEffectivePreference('child', 'missing.key', 'fallback'), 'fallback');
});

test('listSessions attaches effective preferences without persisting derived values', async () => {
  let store = createMemoryFrameStore();
  let runtime = createRuntime(store, [ 'root', 'child' ]);

  await runtime.createSession({ id: 'root', title: 'Root', preferences: { 'ocr.image_proxy': false } });
  await runtime.createSession({ id: 'child', title: 'Child', parentSessionID: 'root' });

  let listed = await runtime.listSessions();
  let child = listed.find((session) => session.id === 'child');
  assert.equal(child.effectivePreferences[OCR_IMAGE_PROXY_PREFERENCE], false);
  assert.deepEqual(store.sessions.get('child').preferences, {}, 'effective preferences are not written back');
});

test('FrameRuntime rejects malformed preference writes', async () => {
  let store = createMemoryFrameStore();
  let runtime = createRuntime(store, [ 'ses_1' ]);
  await runtime.createSession({ id: 'ses_1', title: 'Scratch' });

  await assert.rejects(
    () => runtime.updateSession('ses_1', { preferences: { 'bad key': true } }),
    /Invalid preference key/,
  );
  await assert.rejects(
    () => runtime.updateSession('ses_1', { preferences: { valid: { object: true } } }),
    /boolean, number, or string/,
  );
});

test('getEffectivePreferences reports unknown sessions with a 404', async () => {
  let runtime = createRuntime(createMemoryFrameStore(), []);

  await assert.rejects(
    () => runtime.getEffectivePreferences('missing'),
    (error) => error.status === 404 && /Unknown session/.test(error.message),
  );
});

function createRuntime(store, ids) {
  return new FrameRuntime({
    frameStore: store,
    logger: quietLogger(),
    clock: () => 1000,
    idGenerator: createIDGenerator(ids),
  });
}

test('FrameRuntime inherits session agents and teams from ancestors in the stored session record', async () => {
  let store = createMemoryFrameStore();
  let runtime = createRuntime(store, [ 'root', 'child', 'grandchild' ]);

  await runtime.createSession({
    id: 'root',
    title: 'Root',
    participantAgentIDs: [ 'agent_root' ],
    teamIDs: [ 'team_root' ],
  });
  await runtime.createSession({
    id: 'child',
    title: 'Child',
    parentSessionID: 'root',
    participantAgentIDs: [ 'agent_child' ],
    teamIDs: [ 'team_child' ],
  });
  await runtime.createSession({
    id: 'grandchild',
    title: 'Grandchild',
    parentSessionID: 'child',
    participantAgentIDs: [ 'agent_grandchild' ],
  });

  let child = runtime.sessions.get('child').session;
  let grandchild = runtime.sessions.get('grandchild').session;
  assert.deepEqual(child.participantAgentIDs, [ 'agent_root', 'agent_child' ]);
  assert.deepEqual(child.teamIDs, [ 'team_root', 'team_child' ]);
  assert.deepEqual(grandchild.participantAgentIDs, [ 'agent_root', 'agent_child', 'agent_grandchild' ]);
  assert.deepEqual(grandchild.teamIDs, [ 'team_root', 'team_child' ]);

  let persisted = await store.loadSession('grandchild');
  assert.deepEqual(persisted.teamIDs, [ 'team_root', 'team_child' ]);
});
