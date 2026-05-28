'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }  from '../../../src/core/index.mjs';
import { SessionManager }  from '../../../src/core/session/index.mjs';

// =============================================================================
// Session Context -> ValueStore Migration Tests
// =============================================================================
// Validates that Session context has been migrated from an inline JSON column
// to the ValueStore table. All context methods are now async.
// =============================================================================

describe('Session Context ValueStore Migration', () => {
  let core;
  let models;
  let sessionManager;
  let organization;

  before(async () => {
    core = createKikxCore();
    await core.start();
    models = core.getModels();
    sessionManager = new SessionManager(core.getContext());
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  beforeEach(async () => {
    organization = await models.Organization.create({ name: 'Migration Test Org' });
  });

  async function createSession(opts = {}) {
    return sessionManager.createSession(organization.id, opts);
  }

  // ---------------------------------------------------------------------------
  // Schema changes
  // ---------------------------------------------------------------------------

  it('Session model no longer has a context column', () => {
    let { Session } = models;
    assert.equal('context' in Session.fields, false, 'context field should not exist');
  });

  it('Session model version is 4', () => {
    let { Session } = models;
    assert.equal(Session.version, 4);
  });

  // ---------------------------------------------------------------------------
  // getContext() -- basic
  // ---------------------------------------------------------------------------

  it('getContext() returns empty object when no entries exist', async () => {
    let session = await createSession();
    let context = await session.getContext();

    assert.deepStrictEqual(context, {});
  });

  it('getContext() returns stored values', async () => {
    let session = await createSession();
    await session.setContext({ mood: 'focused', taskCount: 3 });

    let context = await session.getContext();
    assert.equal(context.mood, 'focused');
    assert.equal(context.taskCount, 3);
  });

  // ---------------------------------------------------------------------------
  // updateContext() -- store, upsert, delete
  // ---------------------------------------------------------------------------

  it('updateContext() stores values in ValueStore', async () => {
    let session = await createSession();
    await session.updateContext({ alpha: 'one', beta: 'two' });

    let ValueStore = models.ValueStore;
    let entries = await ValueStore
      .where.ownerType.EQ('Session')
      .ownerID.EQ(session.id)
      .namespace.EQ('context')
      .scopeID.EQ('')
      .all();

    assert.equal(entries.length, 2);
    let keys = entries.map((e) => e.key).sort();
    assert.deepStrictEqual(keys, ['alpha', 'beta']);
  });

  it('updateContext() upserts existing values', async () => {
    let session = await createSession();
    await session.setContext({ status: 'draft', priority: 'low' });

    await session.updateContext({ status: 'published' });

    let context = await session.getContext();
    assert.equal(context.status, 'published');
    assert.equal(context.priority, 'low');
  });

  it('updateContext() with null value deletes the entry', async () => {
    let session = await createSession();
    await session.setContext({ keep: 'yes', remove: 'me' });

    await session.updateContext({ remove: null });

    let context = await session.getContext();
    assert.equal(context.keep, 'yes');
    assert.equal('remove' in context, false);
  });

  it('updateContext() with undefined value deletes the entry', async () => {
    let session = await createSession();
    await session.setContext({ keep: 'yes', remove: 'me' });

    await session.updateContext({ remove: undefined });

    let context = await session.getContext();
    assert.equal(context.keep, 'yes');
    assert.equal('remove' in context, false);
  });

  // ---------------------------------------------------------------------------
  // setContext() -- replace and clear
  // ---------------------------------------------------------------------------

  it('setContext() replaces all entries', async () => {
    let session = await createSession();
    await session.setContext({ first: 1, second: 2 });
    await session.setContext({ third: 3 });

    let context = await session.getContext();
    assert.equal('first' in context, false, 'old key should be gone');
    assert.equal('second' in context, false, 'old key should be gone');
    assert.equal(context.third, 3);
  });

  it('setContext(null) clears all entries', async () => {
    let session = await createSession();
    await session.setContext({ mood: 'happy', topic: 'testing' });
    await session.setContext(null);

    let context = await session.getContext();
    assert.deepStrictEqual(context, {});

    // Verify ValueStore is actually empty
    let ValueStore = models.ValueStore;
    let entries = await ValueStore
      .where.ownerType.EQ('Session')
      .ownerID.EQ(session.id)
      .namespace.EQ('context')
      .scopeID.EQ('')
      .all();
    assert.equal(entries.length, 0);
  });

  // ---------------------------------------------------------------------------
  // getEffectiveContext() -- parent chain
  // ---------------------------------------------------------------------------

  it('getEffectiveContext() merges parent context with child context', async () => {
    let parent = await createSession();
    await parent.setContext({ parentKey: 'parentValue', shared: 'from-parent' });

    let child = await createSession({ parentSessionID: parent.id });
    await child.setContext({ childKey: 'childValue' });

    let effective = await child.getEffectiveContext();
    assert.equal(effective.parentKey, 'parentValue');
    assert.equal(effective.childKey, 'childValue');
    assert.equal(effective.shared, 'from-parent');
  });

  it('getEffectiveContext() child overrides parent', async () => {
    let parent = await createSession();
    await parent.setContext({ mood: 'calm', topic: 'design' });

    let child = await createSession({ parentSessionID: parent.id });
    await child.setContext({ mood: 'excited' });

    let effective = await child.getEffectiveContext();
    assert.equal(effective.mood, 'excited', 'child should override parent');
    assert.equal(effective.topic, 'design', 'parent-only keys should be inherited');
  });

  it('getEffectiveContext() works with deep parent chains', async () => {
    let grandparent = await createSession();
    await grandparent.setContext({ level: 'grandparent', theme: 'dark', lang: 'en' });

    let parent = await createSession({ parentSessionID: grandparent.id });
    await parent.setContext({ level: 'parent', theme: 'light' });

    let child = await createSession({ parentSessionID: parent.id });
    await child.setContext({ level: 'child' });

    let effective = await child.getEffectiveContext();
    assert.equal(effective.level, 'child');
    assert.equal(effective.theme, 'light');
    assert.equal(effective.lang, 'en');
  });

  it('getEffectiveContext() returns empty when no context anywhere', async () => {
    let parent = await createSession();
    let child  = await createSession({ parentSessionID: parent.id });

    let effective = await child.getEffectiveContext();
    assert.deepStrictEqual(effective, {});
  });

  // ---------------------------------------------------------------------------
  // Corrupted JSON handled gracefully
  // ---------------------------------------------------------------------------

  it('corrupted JSON in ValueStore is returned as raw string', async () => {
    let session = await createSession();

    let ValueStore = models.ValueStore;
    await ValueStore.create({
      organizationID: session.organizationID,
      ownerType:      'Session',
      ownerID:        session.id,
      namespace:      'context',
      scopeID:        '',
      key:            'broken',
      value:          'not valid json {{{',
    });

    let context = await session.getContext();
    assert.equal(context.broken, 'not valid json {{{');
  });

  // ---------------------------------------------------------------------------
  // Multiple context keys store independently
  // ---------------------------------------------------------------------------

  it('multiple context keys store as separate ValueStore entries', async () => {
    let session = await createSession();
    await session.setContext({ alpha: 1, beta: 2, gamma: 3 });

    let ValueStore = models.ValueStore;
    let entries = await ValueStore
      .where.ownerType.EQ('Session')
      .ownerID.EQ(session.id)
      .namespace.EQ('context')
      .scopeID.EQ('')
      .all();

    assert.equal(entries.length, 3);
  });

  // ---------------------------------------------------------------------------
  // All methods return Promises
  // ---------------------------------------------------------------------------

  it('all context methods return Promises', async () => {
    let session = await createSession();

    let getResult    = session.getContext();
    let setResult    = session.setContext({ test: true });
    let updateResult = session.updateContext({ test: false });
    let effectResult = session.getEffectiveContext();

    assert.ok(getResult instanceof Promise, 'getContext should return a Promise');
    assert.ok(setResult instanceof Promise, 'setContext should return a Promise');
    assert.ok(updateResult instanceof Promise, 'updateContext should return a Promise');
    assert.ok(effectResult instanceof Promise, 'getEffectiveContext should return a Promise');

    await Promise.all([getResult, setResult, updateResult, effectResult]);
  });
});
