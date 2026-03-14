'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }  from '../../../src/core/index.mjs';
import { SessionManager }  from '../../../src/core/session/index.mjs';

// =============================================================================
// Session Context Persistence & Inheritance Tests
// =============================================================================
// Verifies context methods backed by the ValueStore table:
//   getContext(), setContext(), updateContext(), getEffectiveContext()
// All methods are async. Context is stored as individual ValueStore entries
// with ownerType='Session', namespace='context'.
// getEffectiveContext() walks the parent chain, merging from root down.
// =============================================================================

describe('Session Context Persistence', () => {
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
    organization = await models.Organization.create({ name: 'Context Test Org' });
  });

  async function createSession(opts = {}) {
    return sessionManager.createSession(organization.id, opts);
  }

  // ---------------------------------------------------------------------------
  // Version bump
  // ---------------------------------------------------------------------------

  it('Session model version is 4', () => {
    let { Session } = models;
    assert.equal(Session.version, 4);
  });

  // ---------------------------------------------------------------------------
  // Column removed
  // ---------------------------------------------------------------------------

  it('Session model no longer has a context column', () => {
    let { Session } = models;
    let fields = Session.fields;
    assert.equal('context' in fields, false, 'context field should not exist in Session.fields');
  });

  // ---------------------------------------------------------------------------
  // getContext()
  // ---------------------------------------------------------------------------

  it('getContext is a function on session instances', async () => {
    let session = await createSession();
    assert.equal(typeof session.getContext, 'function');
  });

  it('getContext() with no entries returns empty object', async () => {
    let session = await createSession();
    let context = await session.getContext();

    assert.equal(typeof context, 'object');
    assert.notEqual(context, null);
    assert.deepStrictEqual(context, {});
  });

  it('getContext() with stored context returns parsed object', async () => {
    let session = await createSession();
    await session.setContext({ mood: 'focused', taskCount: 3 });

    let { Session } = models;
    let fetched = await Session.where.id.EQ(session.id).first();
    let context = await fetched.getContext();

    assert.equal(context.mood, 'focused');
    assert.equal(context.taskCount, 3);
  });

  // ---------------------------------------------------------------------------
  // setContext()
  // ---------------------------------------------------------------------------

  it('setContext(obj) round-trips via getContext()', async () => {
    let session = await createSession();
    await session.setContext({ goal: 'ship feature', priority: 'high' });

    let { Session } = models;
    let fetched = await Session.where.id.EQ(session.id).first();
    let context = await fetched.getContext();

    assert.equal(context.goal, 'ship feature');
    assert.equal(context.priority, 'high');
  });

  it('setContext(null) clears context, getContext() returns empty object', async () => {
    let session = await createSession();
    await session.setContext({ mood: 'happy' });

    await session.setContext(null);

    let context = await session.getContext();
    assert.deepStrictEqual(context, {});
  });

  it('setContext({}) stores empty object, getContext() returns empty object', async () => {
    let session = await createSession();
    await session.setContext({});

    let context = await session.getContext();
    assert.deepStrictEqual(context, {});
  });

  // ---------------------------------------------------------------------------
  // updateContext()
  // ---------------------------------------------------------------------------

  it('updateContext(partial) shallow-merges into existing context', async () => {
    let session = await createSession();
    await session.setContext({ mood: 'focused', topic: 'architecture' });

    await session.updateContext({ priority: 'high' });

    let context = await session.getContext();
    assert.equal(context.mood, 'focused');
    assert.equal(context.topic, 'architecture');
    assert.equal(context.priority, 'high');
  });

  it('updateContext on empty context creates from partial', async () => {
    let session = await createSession();
    await session.updateContext({ newKey: 'newValue' });

    let context = await session.getContext();
    assert.equal(context.newKey, 'newValue');
  });

  it('updateContext({}) is a no-op', async () => {
    let session = await createSession();
    await session.setContext({ mood: 'calm' });

    await session.updateContext({});

    let context = await session.getContext();
    assert.equal(context.mood, 'calm');
  });

  it('updateContext can override existing keys', async () => {
    let session = await createSession();
    await session.setContext({ status: 'draft' });

    await session.updateContext({ status: 'published' });

    let context = await session.getContext();
    assert.equal(context.status, 'published');
  });

  it('updateContext with null value deletes that entry', async () => {
    let session = await createSession();
    await session.setContext({ keep: 'yes', remove: 'me' });

    await session.updateContext({ remove: null });

    let context = await session.getContext();
    assert.equal(context.keep, 'yes');
    assert.equal('remove' in context, false);
  });

  // ---------------------------------------------------------------------------
  // Mutation isolation
  // ---------------------------------------------------------------------------

  it('getContext() returns fresh copies (mutation isolation)', async () => {
    let session  = await createSession();
    await session.setContext({ items: [1, 2, 3] });

    let context1 = await session.getContext();
    let context2 = await session.getContext();

    assert.notStrictEqual(context1, context2);
    assert.deepStrictEqual(context1, context2);
  });

  it('mutating getContext() result does not affect stored context', async () => {
    let session = await createSession();
    await session.setContext({ items: [1, 2], count: 5 });

    let context = await session.getContext();
    context.count = 99;
    context.items.push(3);

    let fresh = await session.getContext();
    assert.equal(fresh.count, 5);
    assert.deepStrictEqual(fresh.items, [1, 2]);
  });

  // ---------------------------------------------------------------------------
  // Independence across sessions
  // ---------------------------------------------------------------------------

  it('different sessions have independent contexts', async () => {
    let session1 = await createSession();
    let session2 = await createSession();

    await session1.setContext({ role: 'leader' });
    await session2.setContext({ role: 'follower' });

    let { Session } = models;
    let fetched1 = await Session.where.id.EQ(session1.id).first();
    let fetched2 = await Session.where.id.EQ(session2.id).first();

    let ctx1 = await fetched1.getContext();
    let ctx2 = await fetched2.getContext();
    assert.equal(ctx1.role, 'leader');
    assert.equal(ctx2.role, 'follower');
  });

  // ---------------------------------------------------------------------------
  // UTF8 content
  // ---------------------------------------------------------------------------

  it('UTF8 content round-trips through context (emoji, CJK)', async () => {
    let session = await createSession();
    await session.setContext({
      emoji:    '🚀🎉💡',
      japanese: 'こんにちは世界',
      chinese:  '你好世界',
      mixed:    'Hello 🌍 世界',
    });

    let { Session } = models;
    let fetched = await Session.where.id.EQ(session.id).first();
    let context = await fetched.getContext();

    assert.equal(context.emoji, '🚀🎉💡');
    assert.equal(context.japanese, 'こんにちは世界');
    assert.equal(context.chinese, '你好世界');
    assert.equal(context.mixed, 'Hello 🌍 世界');
  });

  // ---------------------------------------------------------------------------
  // Arbitrary keys
  // ---------------------------------------------------------------------------

  it('context supports arbitrary nested data structures', async () => {
    let session = await createSession();
    await session.setContext({
      deliberation: {
        rounds:     3,
        consensus:  true,
        votes:      [{ agent: 'a1', vote: 'yes' }, { agent: 'a2', vote: 'no' }],
      },
      tags: ['important', 'urgent'],
    });

    let { Session } = models;
    let fetched = await Session.where.id.EQ(session.id).first();
    let context = await fetched.getContext();

    assert.equal(context.deliberation.rounds, 3);
    assert.equal(context.deliberation.consensus, true);
    assert.equal(context.deliberation.votes.length, 2);
    assert.deepStrictEqual(context.tags, ['important', 'urgent']);
  });

  // ---------------------------------------------------------------------------
  // Multiple keys stored independently
  // ---------------------------------------------------------------------------

  it('multiple context keys are stored as independent ValueStore entries', async () => {
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

    let keys = entries.map((e) => e.key).sort();
    assert.deepStrictEqual(keys, ['alpha', 'beta', 'gamma']);
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

    // Await them all to prevent unhandled rejections
    await Promise.all([getResult, setResult, updateResult, effectResult]);
  });

  // ---------------------------------------------------------------------------
  // Corrupted JSON handled gracefully
  // ---------------------------------------------------------------------------

  it('corrupted JSON in ValueStore is returned as raw string', async () => {
    let session = await createSession();

    // Manually insert a corrupted entry
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
});

// =============================================================================
// Session Context Inheritance (getEffectiveContext)
// =============================================================================

describe('Session Context Inheritance', () => {
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
    organization = await models.Organization.create({ name: 'Inheritance Test Org' });
  });

  async function createSession(opts = {}) {
    return sessionManager.createSession(organization.id, opts);
  }

  // ---------------------------------------------------------------------------
  // getEffectiveContext() -- no parent
  // ---------------------------------------------------------------------------

  it('getEffectiveContext is an async function on session instances', async () => {
    let session = await createSession();
    assert.equal(typeof session.getEffectiveContext, 'function');
  });

  it('getEffectiveContext() with no parent returns own context', async () => {
    let session = await createSession();
    await session.setContext({ mood: 'calm' });

    let effective = await session.getEffectiveContext();
    assert.equal(effective.mood, 'calm');
  });

  it('getEffectiveContext() with no parent and no context returns empty object', async () => {
    let session   = await createSession();
    let effective = await session.getEffectiveContext();
    assert.deepStrictEqual(effective, {});
  });

  // ---------------------------------------------------------------------------
  // getEffectiveContext() -- single parent
  // ---------------------------------------------------------------------------

  it('getEffectiveContext() with parent merges parent context as defaults (child wins)', async () => {
    let parent = await createSession();
    await parent.setContext({ mood: 'calm', topic: 'architecture' });

    let child = await createSession({ parentSessionID: parent.id });
    await child.setContext({ mood: 'excited' });

    let effective = await child.getEffectiveContext();
    assert.equal(effective.mood, 'excited', 'child should override parent');
    assert.equal(effective.topic, 'architecture', 'parent keys should be inherited');
  });

  it('getEffectiveContext() inherits all parent keys when child has no context', async () => {
    let parent = await createSession();
    await parent.setContext({ goal: 'ship it', priority: 'high' });

    let child = await createSession({ parentSessionID: parent.id });

    let effective = await child.getEffectiveContext();
    assert.equal(effective.goal, 'ship it');
    assert.equal(effective.priority, 'high');
  });

  // ---------------------------------------------------------------------------
  // getEffectiveContext() -- multi-level ancestry
  // ---------------------------------------------------------------------------

  it('getEffectiveContext() walks multi-level ancestry (grandparent -> parent -> child)', async () => {
    let grandparent = await createSession();
    await grandparent.setContext({ level: 'grandparent', theme: 'dark', lang: 'en' });

    let parent = await createSession({ parentSessionID: grandparent.id });
    await parent.setContext({ level: 'parent', theme: 'light' });

    let child = await createSession({ parentSessionID: parent.id });
    await child.setContext({ level: 'child' });

    let effective = await child.getEffectiveContext();
    assert.equal(effective.level, 'child', 'child wins for level');
    assert.equal(effective.theme, 'light', 'parent wins over grandparent for theme');
    assert.equal(effective.lang, 'en', 'grandparent value inherited for lang');
  });

  // ---------------------------------------------------------------------------
  // getEffectiveContext() -- null contexts at various levels
  // ---------------------------------------------------------------------------

  it('getEffectiveContext() with null contexts at various levels still works', async () => {
    let grandparent = await createSession();
    await grandparent.setContext({ inherited: 'from-grandparent' });

    // Parent has no context (empty)
    let parent = await createSession({ parentSessionID: grandparent.id });

    let child = await createSession({ parentSessionID: parent.id });
    await child.setContext({ own: 'child-value' });

    let effective = await child.getEffectiveContext();
    assert.equal(effective.inherited, 'from-grandparent');
    assert.equal(effective.own, 'child-value');
  });

  // ---------------------------------------------------------------------------
  // getEffectiveContext() -- mutation isolation
  // ---------------------------------------------------------------------------

  it('getEffectiveContext() returns fresh copy (mutation isolation)', async () => {
    let parent = await createSession();
    await parent.setContext({ key: 'value' });

    let child = await createSession({ parentSessionID: parent.id });
    await child.setContext({ other: 'data' });

    let effective1 = await child.getEffectiveContext();
    let effective2 = await child.getEffectiveContext();

    assert.notStrictEqual(effective1, effective2);
    assert.deepStrictEqual(effective1, effective2);
  });
});
