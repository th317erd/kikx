'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }  from '../../../src/core/index.mjs';
import { SessionManager }  from '../../../src/core/session/index.mjs';

// =============================================================================
// Session Context Persistence & Inheritance Tests
// =============================================================================
// Verifies the `context` field and associated methods:
//   getContext(), setContext(), updateContext(), getEffectiveContext()
// Session context is persisted as JSON TEXT.
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

  it('Session model version is 3', () => {
    let { Session } = models;
    assert.equal(Session.version, 3);
  });

  // ---------------------------------------------------------------------------
  // Field existence
  // ---------------------------------------------------------------------------

  it('context field exists on session instances and defaults to null', async () => {
    let session = await createSession();
    assert.equal(session.context == null, true, 'context should be null or undefined by default');
  });

  // ---------------------------------------------------------------------------
  // getContext()
  // ---------------------------------------------------------------------------

  it('getContext is a function on session instances', async () => {
    let session = await createSession();
    assert.equal(typeof session.getContext, 'function');
  });

  it('getContext() with null returns empty object', async () => {
    let session = await createSession();
    let context = session.getContext();

    assert.equal(typeof context, 'object');
    assert.notEqual(context, null);
    assert.deepStrictEqual(context, {});
  });

  it('getContext() with stored context returns parsed object', async () => {
    let session = await createSession();
    session.setContext({ mood: 'focused', taskCount: 3 });
    await session.save();

    let { Session } = models;
    let fetched = await Session.where.id.EQ(session.id).first();
    let context = fetched.getContext();

    assert.equal(context.mood, 'focused');
    assert.equal(context.taskCount, 3);
  });

  it('getContext() with invalid JSON returns empty object', async () => {
    let session = await createSession();
    session.context = 'not valid json {{{';

    let context = session.getContext();
    assert.deepStrictEqual(context, {});
  });

  // ---------------------------------------------------------------------------
  // setContext()
  // ---------------------------------------------------------------------------

  it('setContext(obj) + save() round-trips via getContext()', async () => {
    let session = await createSession();
    session.setContext({ goal: 'ship feature', priority: 'high' });
    await session.save();

    let { Session } = models;
    let fetched = await Session.where.id.EQ(session.id).first();
    let context = fetched.getContext();

    assert.equal(context.goal, 'ship feature');
    assert.equal(context.priority, 'high');
  });

  it('setContext(null) clears context, getContext() returns empty object', async () => {
    let session = await createSession();
    session.setContext({ mood: 'happy' });
    await session.save();

    session.setContext(null);
    await session.save();

    let context = session.getContext();
    assert.deepStrictEqual(context, {});
  });

  it('setContext({}) stores empty object, getContext() returns empty object', async () => {
    let session = await createSession();
    session.setContext({});
    await session.save();

    let context = session.getContext();
    assert.deepStrictEqual(context, {});
  });

  // ---------------------------------------------------------------------------
  // updateContext()
  // ---------------------------------------------------------------------------

  it('updateContext(partial) shallow-merges into existing context', async () => {
    let session = await createSession();
    session.setContext({ mood: 'focused', topic: 'architecture' });
    await session.save();

    session.updateContext({ priority: 'high' });
    await session.save();

    let context = session.getContext();
    assert.equal(context.mood, 'focused');
    assert.equal(context.topic, 'architecture');
    assert.equal(context.priority, 'high');
  });

  it('updateContext on null context creates from partial', async () => {
    let session = await createSession();
    session.updateContext({ newKey: 'newValue' });
    await session.save();

    let context = session.getContext();
    assert.equal(context.newKey, 'newValue');
  });

  it('updateContext({}) is a no-op', async () => {
    let session = await createSession();
    session.setContext({ mood: 'calm' });
    await session.save();

    session.updateContext({});
    await session.save();

    let context = session.getContext();
    assert.equal(context.mood, 'calm');
  });

  it('updateContext can override existing keys', async () => {
    let session = await createSession();
    session.setContext({ status: 'draft' });
    await session.save();

    session.updateContext({ status: 'published' });
    await session.save();

    let context = session.getContext();
    assert.equal(context.status, 'published');
  });

  // ---------------------------------------------------------------------------
  // Mutation isolation
  // ---------------------------------------------------------------------------

  it('getContext() returns fresh copies (mutation isolation)', async () => {
    let session  = await createSession();
    session.setContext({ items: [1, 2, 3] });
    await session.save();

    let context1 = session.getContext();
    let context2 = session.getContext();

    assert.notStrictEqual(context1, context2);
    assert.deepStrictEqual(context1, context2);
  });

  it('mutating getContext() result does not affect stored context', async () => {
    let session = await createSession();
    session.setContext({ items: [1, 2], count: 5 });
    await session.save();

    let context = session.getContext();
    context.count = 99;
    context.items.push(3);

    let fresh = session.getContext();
    assert.equal(fresh.count, 5);
    assert.deepStrictEqual(fresh.items, [1, 2]);
  });

  // ---------------------------------------------------------------------------
  // Independence across sessions
  // ---------------------------------------------------------------------------

  it('different sessions have independent contexts', async () => {
    let session1 = await createSession();
    let session2 = await createSession();

    session1.setContext({ role: 'leader' });
    await session1.save();

    session2.setContext({ role: 'follower' });
    await session2.save();

    let { Session } = models;
    let fetched1 = await Session.where.id.EQ(session1.id).first();
    let fetched2 = await Session.where.id.EQ(session2.id).first();

    assert.equal(fetched1.getContext().role, 'leader');
    assert.equal(fetched2.getContext().role, 'follower');
  });

  // ---------------------------------------------------------------------------
  // UTF8 content
  // ---------------------------------------------------------------------------

  it('UTF8 content round-trips through context (emoji, CJK)', async () => {
    let session = await createSession();
    session.setContext({
      emoji:    '🚀🎉💡',
      japanese: 'こんにちは世界',
      chinese:  '你好世界',
      mixed:    'Hello 🌍 世界',
    });
    await session.save();

    let { Session } = models;
    let fetched = await Session.where.id.EQ(session.id).first();
    let context = fetched.getContext();

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
    session.setContext({
      deliberation: {
        rounds:     3,
        consensus:  true,
        votes:      [{ agent: 'a1', vote: 'yes' }, { agent: 'a2', vote: 'no' }],
      },
      tags: ['important', 'urgent'],
    });
    await session.save();

    let { Session } = models;
    let fetched = await Session.where.id.EQ(session.id).first();
    let context = fetched.getContext();

    assert.equal(context.deliberation.rounds, 3);
    assert.equal(context.deliberation.consensus, true);
    assert.equal(context.deliberation.votes.length, 2);
    assert.deepStrictEqual(context.tags, ['important', 'urgent']);
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
  // getEffectiveContext() — no parent
  // ---------------------------------------------------------------------------

  it('getEffectiveContext is an async function on session instances', async () => {
    let session = await createSession();
    assert.equal(typeof session.getEffectiveContext, 'function');
  });

  it('getEffectiveContext() with no parent returns own context', async () => {
    let session = await createSession();
    session.setContext({ mood: 'calm' });
    await session.save();

    let effective = await session.getEffectiveContext();
    assert.equal(effective.mood, 'calm');
  });

  it('getEffectiveContext() with no parent and no context returns empty object', async () => {
    let session   = await createSession();
    let effective = await session.getEffectiveContext();
    assert.deepStrictEqual(effective, {});
  });

  // ---------------------------------------------------------------------------
  // getEffectiveContext() — single parent
  // ---------------------------------------------------------------------------

  it('getEffectiveContext() with parent merges parent context as defaults (child wins)', async () => {
    let parent = await createSession();
    parent.setContext({ mood: 'calm', topic: 'architecture' });
    await parent.save();

    let child = await createSession({ parentSessionID: parent.id });
    child.setContext({ mood: 'excited' });
    await child.save();

    let effective = await child.getEffectiveContext();
    assert.equal(effective.mood, 'excited', 'child should override parent');
    assert.equal(effective.topic, 'architecture', 'parent keys should be inherited');
  });

  it('getEffectiveContext() inherits all parent keys when child has no context', async () => {
    let parent = await createSession();
    parent.setContext({ goal: 'ship it', priority: 'high' });
    await parent.save();

    let child = await createSession({ parentSessionID: parent.id });

    let effective = await child.getEffectiveContext();
    assert.equal(effective.goal, 'ship it');
    assert.equal(effective.priority, 'high');
  });

  // ---------------------------------------------------------------------------
  // getEffectiveContext() — multi-level ancestry
  // ---------------------------------------------------------------------------

  it('getEffectiveContext() walks multi-level ancestry (grandparent -> parent -> child)', async () => {
    let grandparent = await createSession();
    grandparent.setContext({ level: 'grandparent', theme: 'dark', lang: 'en' });
    await grandparent.save();

    let parent = await createSession({ parentSessionID: grandparent.id });
    parent.setContext({ level: 'parent', theme: 'light' });
    await parent.save();

    let child = await createSession({ parentSessionID: parent.id });
    child.setContext({ level: 'child' });
    await child.save();

    let effective = await child.getEffectiveContext();
    assert.equal(effective.level, 'child', 'child wins for level');
    assert.equal(effective.theme, 'light', 'parent wins over grandparent for theme');
    assert.equal(effective.lang, 'en', 'grandparent value inherited for lang');
  });

  // ---------------------------------------------------------------------------
  // getEffectiveContext() — null contexts at various levels
  // ---------------------------------------------------------------------------

  it('getEffectiveContext() with null contexts at various levels still works', async () => {
    let grandparent = await createSession();
    grandparent.setContext({ inherited: 'from-grandparent' });
    await grandparent.save();

    // Parent has no context (null)
    let parent = await createSession({ parentSessionID: grandparent.id });

    let child = await createSession({ parentSessionID: parent.id });
    child.setContext({ own: 'child-value' });
    await child.save();

    let effective = await child.getEffectiveContext();
    assert.equal(effective.inherited, 'from-grandparent');
    assert.equal(effective.own, 'child-value');
  });

  // ---------------------------------------------------------------------------
  // getEffectiveContext() — mutation isolation
  // ---------------------------------------------------------------------------

  it('getEffectiveContext() returns fresh copy (mutation isolation)', async () => {
    let parent = await createSession();
    parent.setContext({ key: 'value' });
    await parent.save();

    let child = await createSession({ parentSessionID: parent.id });
    child.setContext({ other: 'data' });
    await child.save();

    let effective1 = await child.getEffectiveContext();
    let effective2 = await child.getEffectiveContext();

    assert.notStrictEqual(effective1, effective2);
    assert.deepStrictEqual(effective1, effective2);
  });
});
