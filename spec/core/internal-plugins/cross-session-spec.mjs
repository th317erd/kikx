'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }   from '../../../src/core/index.mjs';
import { PluginInterface }  from '../../../src/core/plugin-loader/plugin-interface.mjs';
import { PluginRegistry }   from '../../../src/core/plugin-loader/registry.mjs';
import { SessionManager }   from '../../../src/core/session/index.mjs';
import { setup }            from '../../../src/core/internal-plugins/cross-session/index.mjs';

// =============================================================================
// Cross-Session Internal Plugin — TDD Tests
// =============================================================================
// These tests are written BEFORE the plugin exists. They define the expected
// behavior for 5 tools registered by the cross-session plugin:
//
//   1. cross-session:listSessions
//   2. cross-session:createSession
//   3. cross-session:postToSession
//   4. cross-session:readFromSession
//   5. cross-session:inviteParticipant
//
// All tests are expected to FAIL until the plugin is implemented.
// =============================================================================

describe('Cross-Session Plugin', () => {
  let core;
  let models;
  let context;
  let sessionManager;
  let registry;
  let org;

  // Shared tool classes — populated once during setup() registration
  let ListSessionsTool;
  let CreateSessionTool;
  let PostToSessionTool;
  let ReadFromSessionTool;
  let InviteParticipantTool;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    sessionManager = new SessionManager(context);
    context.setProperty('sessionManager', sessionManager);

    // Register the plugin into a fresh registry
    registry = new PluginRegistry();
    setup({
      registerTool: (name, cls) => registry.registerTool(name, cls),
      PluginInterface,
      context,
    });

    ListSessionsTool       = registry.getTool('cross-session:listSessions');
    CreateSessionTool      = registry.getTool('cross-session:createSession');
    PostToSessionTool      = registry.getTool('cross-session:postToSession');
    ReadFromSessionTool    = registry.getTool('cross-session:readFromSession');
    InviteParticipantTool  = registry.getTool('cross-session:inviteParticipant');
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function createOrg(name = 'Cross-Session Test Org') {
    return models.Organization.create({ name });
  }

  async function createAgent(orgID, name) {
    return models.Agent.create({
      organizationID: orgID,
      name,
      pluginID:       'mock-agent',
    });
  }

  async function createSessionWithParticipant(orgID, agentID, opts = {}) {
    let session = await sessionManager.createSession(orgID, opts);
    await sessionManager.addParticipant(session.id, agentID);
    return session;
  }

  function instantiateTool(ToolClass, overrides = {}) {
    let toolContext = {
      getProperty: (key) => {
        if (overrides[key] !== undefined) return overrides[key];
        return context.getProperty(key);
      },
    };
    return new ToolClass(toolContext);
  }

  // ===========================================================================
  // setup() — Registration
  // ===========================================================================

  describe('setup()', () => {
    // ---- Test 1 ----
    it('should register exactly 5 tools', () => {
      let tools = registry.getTools();
      let crossSessionTools = [...tools.keys()].filter((k) => k.startsWith('cross-session:'));
      assert.equal(crossSessionTools.length, 5);
    });

    // ---- Test 2 ----
    it('should register tools with correct names', () => {
      assert.ok(ListSessionsTool, 'cross-session:listSessions should be registered');
      assert.ok(CreateSessionTool, 'cross-session:createSession should be registered');
      assert.ok(PostToSessionTool, 'cross-session:postToSession should be registered');
      assert.ok(ReadFromSessionTool, 'cross-session:readFromSession should be registered');
      assert.ok(InviteParticipantTool, 'cross-session:inviteParticipant should be registered');
    });

    // ---- Test 3 ----
    it('all tools should extend PluginInterface', () => {
      assert.ok(ListSessionsTool.prototype instanceof PluginInterface);
      assert.ok(CreateSessionTool.prototype instanceof PluginInterface);
      assert.ok(PostToSessionTool.prototype instanceof PluginInterface);
      assert.ok(ReadFromSessionTool.prototype instanceof PluginInterface);
      assert.ok(InviteParticipantTool.prototype instanceof PluginInterface);
    });

    // ---- Test 4 ----
    it('all tools should define an inputSchema', () => {
      assert.ok(ListSessionsTool.inputSchema, 'listSessions should have inputSchema');
      assert.ok(CreateSessionTool.inputSchema, 'createSession should have inputSchema');
      assert.ok(PostToSessionTool.inputSchema, 'postToSession should have inputSchema');
      assert.ok(ReadFromSessionTool.inputSchema, 'readFromSession should have inputSchema');
      assert.ok(InviteParticipantTool.inputSchema, 'inviteParticipant should have inputSchema');
    });
  });

  // ===========================================================================
  // cross-session:listSessions
  // ===========================================================================

  describe('cross-session:listSessions', () => {
    beforeEach(async () => {
      org = await createOrg('ListSessions Org');
    });

    // ---- Test 5 ----
    it('should return sessions where the agent is a participant', async () => {
      let agent   = await createAgent(org.id, 'test-ls-agent-1');
      let session = await createSessionWithParticipant(org.id, agent.id, { name: 'Visible Session' });

      let tool   = instantiateTool(ListSessionsTool);
      let result = await tool.execute({ agentID: agent.id });

      assert.ok(Array.isArray(result.sessions));
      assert.ok(result.sessions.length >= 1);

      let found = result.sessions.find((s) => s.id === session.id);
      assert.ok(found, 'should include the session the agent participates in');
      assert.ok(found.name);
      assert.ok(found.lastActivityAt);
    });

    // ---- Test 6 ----
    it('should exclude sessions where agent is NOT a participant', async () => {
      let agent  = await createAgent(org.id, 'test-ls-agent-2');
      let other  = await createAgent(org.id, 'test-ls-agent-3');

      await createSessionWithParticipant(org.id, other.id, { name: 'Other Agent Session' });

      let tool   = instantiateTool(ListSessionsTool);
      let result = await tool.execute({ agentID: agent.id });

      assert.ok(Array.isArray(result.sessions));
      assert.equal(result.sessions.length, 0, 'should not see sessions it does not participate in');
    });

    // ---- Test 7 ----
    it('should filter by search (case-insensitive name match)', async () => {
      let agent = await createAgent(org.id, 'test-ls-agent-4');
      await createSessionWithParticipant(org.id, agent.id, { name: 'Design Review' });
      await createSessionWithParticipant(org.id, agent.id, { name: 'Code Sprint' });

      let tool   = instantiateTool(ListSessionsTool);
      let result = await tool.execute({ agentID: agent.id, search: 'design' });

      assert.equal(result.sessions.length, 1);
      assert.ok(result.sessions[0].name.toLowerCase().includes('design'));
    });

    // ---- Test 8 ----
    it('should filter by type', async () => {
      let agent = await createAgent(org.id, 'test-ls-agent-5');
      await createSessionWithParticipant(org.id, agent.id, { name: 'Chat A', type: 'chat' });
      await createSessionWithParticipant(org.id, agent.id, { name: 'DM B', type: 'dm' });

      let tool   = instantiateTool(ListSessionsTool);
      let result = await tool.execute({ agentID: agent.id, type: 'dm' });

      assert.ok(result.sessions.every((s) => s.type === 'dm'));
      assert.equal(result.sessions.length, 1);
    });

    // ---- Test 9 ----
    it('should exclude archived sessions by default', async () => {
      let agent = await createAgent(org.id, 'test-ls-agent-6');
      let ses   = await createSessionWithParticipant(org.id, agent.id, { name: 'Archived One' });
      await sessionManager.archiveSession(ses.id);

      let tool   = instantiateTool(ListSessionsTool);
      let result = await tool.execute({ agentID: agent.id });

      let found = result.sessions.find((s) => s.id === ses.id);
      assert.equal(found, undefined, 'archived session should be excluded by default');
    });

    // ---- Test 10 ----
    it('should include archived sessions when archived=true', async () => {
      let agent = await createAgent(org.id, 'test-ls-agent-7');
      let ses   = await createSessionWithParticipant(org.id, agent.id, { name: 'Archived Two' });
      await sessionManager.archiveSession(ses.id);

      let tool   = instantiateTool(ListSessionsTool);
      let result = await tool.execute({ agentID: agent.id, archived: true });

      let found = result.sessions.find((s) => s.id === ses.id);
      assert.ok(found, 'archived session should be included when archived=true');
    });

    // ---- Test 11 ----
    it('should support limit and offset pagination', async () => {
      let agent = await createAgent(org.id, 'test-ls-agent-8');
      for (let i = 0; i < 5; i++)
        await createSessionWithParticipant(org.id, agent.id, { name: `Paginated ${i}` });

      let tool    = instantiateTool(ListSessionsTool);
      let page1   = await tool.execute({ agentID: agent.id, limit: 2, offset: 0 });
      let page2   = await tool.execute({ agentID: agent.id, limit: 2, offset: 2 });

      assert.equal(page1.sessions.length, 2);
      assert.equal(page2.sessions.length, 2);

      let ids1 = page1.sessions.map((s) => s.id);
      let ids2 = page2.sessions.map((s) => s.id);
      assert.ok(!ids1.some((id) => ids2.includes(id)), 'pages should not overlap');
    });

    // ---- Test 12 ----
    it('should filter by parentSessionID', async () => {
      let agent  = await createAgent(org.id, 'test-ls-agent-9');
      let parent = await createSessionWithParticipant(org.id, agent.id, { name: 'Parent' });
      await createSessionWithParticipant(org.id, agent.id, {
        name:            'Sub-Session',
        parentSessionID: parent.id,
      });
      await createSessionWithParticipant(org.id, agent.id, { name: 'Top Level' });

      let tool   = instantiateTool(ListSessionsTool);
      let result = await tool.execute({ agentID: agent.id, parentSessionID: parent.id });

      assert.equal(result.sessions.length, 1);
      assert.equal(result.sessions[0].name, 'Sub-Session');
    });

    // ---- Test 13 ----
    it('should filter topLevelOnly (no parent)', async () => {
      let agent  = await createAgent(org.id, 'test-ls-agent-10');
      let parent = await createSessionWithParticipant(org.id, agent.id, { name: 'Top Parent' });
      await createSessionWithParticipant(org.id, agent.id, {
        name:            'Child',
        parentSessionID: parent.id,
      });

      let tool   = instantiateTool(ListSessionsTool);
      let result = await tool.execute({ agentID: agent.id, topLevelOnly: true });

      assert.ok(result.sessions.every((s) => !s.parentSessionID));
    });

    // ---- Test 14 ----
    it('should return empty array when agent has no sessions', async () => {
      let agent  = await createAgent(org.id, 'test-ls-agent-11');

      let tool   = instantiateTool(ListSessionsTool);
      let result = await tool.execute({ agentID: agent.id });

      assert.ok(Array.isArray(result.sessions));
      assert.equal(result.sessions.length, 0);
    });

    // ---- Test 15 ----
    it('should set lastActivityAt to createdAt when session has zero frames', async () => {
      let agent   = await createAgent(org.id, 'test-ls-agent-12');
      let session = await createSessionWithParticipant(org.id, agent.id, { name: 'Empty Session' });

      let tool   = instantiateTool(ListSessionsTool);
      let result = await tool.execute({ agentID: agent.id });

      let found = result.sessions.find((s) => s.id === session.id);
      assert.ok(found);
      assert.equal(found.lastActivityAt, found.createdAt);
    });

    // ---- Test 15b ----
    it('search matches frame content when session name does not match', async () => {
      let agent   = await createAgent(org.id, 'test-ls-agent-13');
      let session = await createSessionWithParticipant(org.id, agent.id, { name: 'General Chat' });

      // Add a frame with searchable content
      let fm = sessionManager.getFrameManager(session.id);
      fm.merge([
        { id: 'frm_search1', type: 'message', content: { text: 'The quick brown fox' }, authorType: 'agent', authorID: agent.id },
      ], { authorType: 'agent', authorId: agent.id });

      let tool   = instantiateTool(ListSessionsTool);
      let result = await tool.execute({ agentID: agent.id, search: 'brown fox' });

      assert.equal(result.sessions.length, 1);
      assert.equal(result.sessions[0].id, session.id);
    });

    // ---- Test 15c ----
    it('search returns empty when neither name nor content matches', async () => {
      let agent   = await createAgent(org.id, 'test-ls-agent-14');
      let session = await createSessionWithParticipant(org.id, agent.id, { name: 'General Chat' });

      let fm = sessionManager.getFrameManager(session.id);
      fm.merge([
        { id: 'frm_search2', type: 'message', content: { text: 'Hello world' }, authorType: 'agent', authorID: agent.id },
      ], { authorType: 'agent', authorId: agent.id });

      let tool   = instantiateTool(ListSessionsTool);
      let result = await tool.execute({ agentID: agent.id, search: 'nonexistent term' });

      assert.ok(Array.isArray(result.sessions));
      assert.equal(result.sessions.length, 0);
    });

    // ---- Test 15d ----
    it('search prioritizes name match and also includes content match', async () => {
      let agent = await createAgent(org.id, 'test-ls-agent-15');

      // Session whose name matches the search
      let sessionA = await createSessionWithParticipant(org.id, agent.id, { name: 'Project Alpha' });

      // Session whose name does NOT match, but has frame content that matches
      let sessionB = await createSessionWithParticipant(org.id, agent.id, { name: 'General' });
      let fm = sessionManager.getFrameManager(sessionB.id);
      fm.merge([
        { id: 'frm_search3', type: 'message', content: { text: 'Discussion about Project Alpha requirements' }, authorType: 'agent', authorID: agent.id },
      ], { authorType: 'agent', authorId: agent.id });

      let tool   = instantiateTool(ListSessionsTool);
      let result = await tool.execute({ agentID: agent.id, search: 'Project Alpha' });

      assert.equal(result.sessions.length, 2);
      let ids = result.sessions.map((s) => s.id);
      assert.ok(ids.includes(sessionA.id), 'should include name-matched session');
      assert.ok(ids.includes(sessionB.id), 'should include content-matched session');
    });
  });

  // ===========================================================================
  // cross-session:createSession
  // ===========================================================================

  describe('cross-session:createSession', () => {
    beforeEach(async () => {
      org = await createOrg('CreateSession Org');
    });

    // ---- Test 16 ----
    it('should create a top-level session with no parent', async () => {
      let agent = await createAgent(org.id, 'test-cs-agent-1');
      let tool  = instantiateTool(CreateSessionTool);

      let result = await tool.execute({
        agentID: agent.id,
        title:   'New Top-Level Session',
      });

      assert.ok(result.sessionID);
      assert.ok(result.sessionID.startsWith('ses_'));

      let session = await sessionManager.getSession(result.sessionID);
      assert.ok(session);
      assert.equal(session.name, 'New Top-Level Session');
      assert.equal(session.parentSessionID, null);
    });

    // ---- Test 17 ----
    it('should create a sub-session and insert a session-link frame in parent', async () => {
      let agent  = await createAgent(org.id, 'test-cs-agent-2');
      let parent = await createSessionWithParticipant(org.id, agent.id, { name: 'Parent For Sub' });

      let tool   = instantiateTool(CreateSessionTool);
      let result = await tool.execute({
        agentID:         agent.id,
        title:           'Sub-Session',
        parentSessionID: parent.id,
      });

      assert.ok(result.sessionID);

      let child = await sessionManager.getSession(result.sessionID);
      assert.equal(child.parentSessionID, parent.id);

      // The parent's FrameManager should have a session-link frame
      let fm     = sessionManager.getFrameManager(parent.id);
      let frames = fm.toArray();
      let linkFrame = frames.find((f) => f.type === 'session-link');
      assert.ok(linkFrame, 'parent should contain a session-link frame');
      assert.equal(linkFrame.content.targetSessionID, result.sessionID);
    });

    // ---- Test 18 ----
    it('should add listed participants and create joined frames', async () => {
      let agent1 = await createAgent(org.id, 'test-cs-agent-3');
      let agent2 = await createAgent(org.id, 'test-cs-agent-4');

      let tool   = instantiateTool(CreateSessionTool);
      let result = await tool.execute({
        agentID:      agent1.id,
        title:        'Multi-Participant',
        participants: ['test-cs-agent-3', 'test-cs-agent-4'],
      });

      let participants = await sessionManager.getParticipants(result.sessionID);
      let participantAgentIDs = participants.map((p) => p.agentID);

      assert.ok(participantAgentIDs.includes(agent1.id));
      assert.ok(participantAgentIDs.includes(agent2.id));
    });

    // ---- Test 19 ----
    it('should reject when title is missing', async () => {
      let agent = await createAgent(org.id, 'test-cs-agent-5');
      let tool  = instantiateTool(CreateSessionTool);

      await assert.rejects(
        () => tool.execute({ agentID: agent.id }),
        (err) => {
          assert.ok(err.message.toLowerCase().includes('title'));
          return true;
        },
      );
    });

    // ---- Test 20 ----
    it('should reject when parentSessionID is invalid', async () => {
      let agent = await createAgent(org.id, 'test-cs-agent-6');
      let tool  = instantiateTool(CreateSessionTool);

      await assert.rejects(
        () => tool.execute({
          agentID:         agent.id,
          title:           'Bad Parent',
          parentSessionID: 'ses_nonexistent',
        }),
        (err) => {
          assert.ok(err.message.toLowerCase().includes('session') || err.message.toLowerCase().includes('not found'));
          return true;
        },
      );
    });

    // ---- Test 21 ----
    it('should reject when a participant agent name does not exist', async () => {
      let agent = await createAgent(org.id, 'test-cs-agent-7');
      let tool  = instantiateTool(CreateSessionTool);

      await assert.rejects(
        () => tool.execute({
          agentID:      agent.id,
          title:        'Ghost Participant',
          participants: ['test-cs-agent-7', 'test-nonexistent-agent'],
        }),
        (err) => {
          assert.ok(err.message.toLowerCase().includes('not found') || err.message.toLowerCase().includes('agent'));
          return true;
        },
      );
    });

    // ---- Test 22 ----
    it('should work with empty participants array', async () => {
      let agent = await createAgent(org.id, 'test-cs-agent-8');
      let tool  = instantiateTool(CreateSessionTool);

      let result = await tool.execute({
        agentID:      agent.id,
        title:        'Solo Session',
        participants: [],
      });

      assert.ok(result.sessionID);
    });

    // ---- Test 23 ----
    it('should reject sub-session in archived parent', async () => {
      let agent  = await createAgent(org.id, 'test-cs-agent-9');
      let parent = await createSessionWithParticipant(org.id, agent.id, { name: 'Archived Parent' });
      await sessionManager.archiveSession(parent.id);

      let tool = instantiateTool(CreateSessionTool);

      await assert.rejects(
        () => tool.execute({
          agentID:         agent.id,
          title:           'Child of Archived',
          parentSessionID: parent.id,
        }),
        (err) => {
          assert.ok(err.message.toLowerCase().includes('archived'));
          return true;
        },
      );
    });

    // ---- Test 24 ----
    it('should allow depth-2 sub-sessions (grandchild)', async () => {
      let agent  = await createAgent(org.id, 'test-cs-agent-10');
      let parent = await createSessionWithParticipant(org.id, agent.id, { name: 'Grandparent' });

      let tool = instantiateTool(CreateSessionTool);

      let child = await tool.execute({
        agentID:         agent.id,
        title:           'Child',
        parentSessionID: parent.id,
      });

      let grandchild = await tool.execute({
        agentID:         agent.id,
        title:           'Grandchild',
        parentSessionID: child.sessionID,
      });

      assert.ok(grandchild.sessionID);
      let gcSession = await sessionManager.getSession(grandchild.sessionID);
      assert.equal(gcSession.parentSessionID, child.sessionID);
    });
  });

  // ===========================================================================
  // cross-session:postToSession
  // ===========================================================================

  describe('cross-session:postToSession', () => {
    beforeEach(async () => {
      org = await createOrg('PostToSession Org');
    });

    // ---- Test 25 ----
    it('should create a frame in the target session with agent as author', async () => {
      let agent   = await createAgent(org.id, 'test-post-agent-1');
      let target  = await createSessionWithParticipant(org.id, agent.id, { name: 'Target Session' });

      let tool   = instantiateTool(PostToSessionTool);
      let result = await tool.execute({
        agentID:   agent.id,
        sessionID: target.id,
        message:   'Hello from another session!',
      });

      assert.ok(result.frameID);
      assert.equal(result.sessionID, target.id);

      // Verify frame exists in target FrameManager
      let fm     = sessionManager.getFrameManager(target.id);
      let frames = fm.toArray();
      let posted = frames.find((f) => f.id === result.frameID);
      assert.ok(posted, 'frame should exist in target session');
      assert.equal(posted.authorID, agent.id);
    });

    // ---- Test 26 ----
    it('should reject when sessionID is invalid', async () => {
      let agent = await createAgent(org.id, 'test-post-agent-2');
      let tool  = instantiateTool(PostToSessionTool);

      await assert.rejects(
        () => tool.execute({
          agentID:   agent.id,
          sessionID: 'ses_does_not_exist',
          message:   'Hi',
        }),
        (err) => {
          assert.ok(err.message.toLowerCase().includes('session') || err.message.toLowerCase().includes('not found'));
          return true;
        },
      );
    });

    // ---- Test 27 ----
    it('should reject when message is empty', async () => {
      let agent  = await createAgent(org.id, 'test-post-agent-3');
      let target = await createSessionWithParticipant(org.id, agent.id, { name: 'No Empty Msgs' });

      let tool = instantiateTool(PostToSessionTool);

      await assert.rejects(
        () => tool.execute({
          agentID:   agent.id,
          sessionID: target.id,
          message:   '',
        }),
        (err) => {
          assert.ok(err.message.toLowerCase().includes('message'));
          return true;
        },
      );
    });

    // ---- Test 28 ----
    it('should reject posting to an archived session', async () => {
      let agent  = await createAgent(org.id, 'test-post-agent-4');
      let target = await createSessionWithParticipant(org.id, agent.id, { name: 'Archive Target' });
      await sessionManager.archiveSession(target.id);

      let tool = instantiateTool(PostToSessionTool);

      await assert.rejects(
        () => tool.execute({
          agentID:   agent.id,
          sessionID: target.id,
          message:   'Should not arrive',
        }),
        (err) => {
          assert.ok(err.message.toLowerCase().includes('archived'));
          return true;
        },
      );
    });

    // ---- Test 29 ----
    it('should allow posting to the same session (self-post)', async () => {
      let agent   = await createAgent(org.id, 'test-post-agent-5');
      let session = await createSessionWithParticipant(org.id, agent.id, { name: 'Self Post' });

      let tool   = instantiateTool(PostToSessionTool);
      let result = await tool.execute({
        agentID:   agent.id,
        sessionID: session.id,
        message:   'Talking to myself',
      });

      assert.ok(result.frameID);
      assert.equal(result.sessionID, session.id);
    });
  });

  // ===========================================================================
  // cross-session:readFromSession
  // ===========================================================================

  describe('cross-session:readFromSession', () => {
    beforeEach(async () => {
      org = await createOrg('ReadFromSession Org');
    });

    // ---- Test 30 ----
    it('should return frame summaries from target session', async () => {
      let agent   = await createAgent(org.id, 'test-read-agent-1');
      let session = await createSessionWithParticipant(org.id, agent.id, { name: 'Readable Session' });

      // Add frames to the session
      let fm = sessionManager.getFrameManager(session.id);
      fm.merge([
        { id: 'frm_r1', type: 'message', content: { text: 'First message' }, authorType: 'agent', authorID: agent.id },
        { id: 'frm_r2', type: 'message', content: { text: 'Second message' }, authorType: 'agent', authorID: agent.id },
      ], { authorType: 'agent', authorId: agent.id });

      let tool   = instantiateTool(ReadFromSessionTool);
      let result = await tool.execute({
        agentID:   agent.id,
        sessionID: session.id,
      });

      assert.ok(Array.isArray(result.frames));
      assert.ok(result.frames.length >= 2);
    });

    // ---- Test 31 ----
    it('should filter frames by keyword in content', async () => {
      let agent   = await createAgent(org.id, 'test-read-agent-2');
      let session = await createSessionWithParticipant(org.id, agent.id, { name: 'Keyword Session' });

      let fm = sessionManager.getFrameManager(session.id);
      fm.merge([
        { id: 'frm_k1', type: 'message', content: { text: 'The deployment was successful' }, authorType: 'agent', authorID: agent.id },
        { id: 'frm_k2', type: 'message', content: { text: 'Let us discuss testing' }, authorType: 'agent', authorID: agent.id },
      ], { authorType: 'agent', authorId: agent.id });

      let tool   = instantiateTool(ReadFromSessionTool);
      let result = await tool.execute({
        agentID:   agent.id,
        sessionID: session.id,
        keyword:   'deployment',
      });

      assert.ok(result.frames.length >= 1);
      assert.ok(result.frames.every((f) =>
        JSON.stringify(f.content).toLowerCase().includes('deployment')
      ));
    });

    // ---- Test 32 ----
    it('should filter frames by types array', async () => {
      let agent   = await createAgent(org.id, 'test-read-agent-3');
      let session = await createSessionWithParticipant(org.id, agent.id, { name: 'Types Session' });

      let fm = sessionManager.getFrameManager(session.id);
      fm.merge([
        { id: 'frm_t1', type: 'message', content: { text: 'Chat text' }, authorType: 'agent', authorID: agent.id },
        { id: 'frm_t2', type: 'tool-call', content: { toolName: 'shell:execute', arguments: {} }, authorType: 'agent', authorID: agent.id },
      ], { authorType: 'agent', authorId: agent.id });

      let tool   = instantiateTool(ReadFromSessionTool);
      let result = await tool.execute({
        agentID:   agent.id,
        sessionID: session.id,
        types:     ['tool-call'],
      });

      assert.ok(result.frames.length >= 1);
      assert.ok(result.frames.every((f) => f.type === 'tool-call'));
    });

    // ---- Test 33 ----
    it('should support limit and offset pagination', async () => {
      let agent   = await createAgent(org.id, 'test-read-agent-4');
      let session = await createSessionWithParticipant(org.id, agent.id, { name: 'Paged Read' });

      let fm = sessionManager.getFrameManager(session.id);
      let frameBatch = [];
      for (let i = 0; i < 8; i++)
        frameBatch.push({ id: `frm_p${i}`, type: 'message', content: { text: `Message ${i}` }, authorType: 'agent', authorID: agent.id });
      fm.merge(frameBatch, { authorType: 'agent', authorId: agent.id });

      let tool  = instantiateTool(ReadFromSessionTool);
      let page1 = await tool.execute({ agentID: agent.id, sessionID: session.id, limit: 3, offset: 0 });
      let page2 = await tool.execute({ agentID: agent.id, sessionID: session.id, limit: 3, offset: 3 });

      assert.equal(page1.frames.length, 3);
      assert.equal(page2.frames.length, 3);
    });

    // ---- Test 34 ----
    it('should reject when sessionID is invalid', async () => {
      let agent = await createAgent(org.id, 'test-read-agent-5');
      let tool  = instantiateTool(ReadFromSessionTool);

      await assert.rejects(
        () => tool.execute({
          agentID:   agent.id,
          sessionID: 'ses_ghost',
        }),
        (err) => {
          assert.ok(err.message.toLowerCase().includes('session') || err.message.toLowerCase().includes('not found'));
          return true;
        },
      );
    });

    // ---- Test 35 ----
    it('should return empty array when no frames match keyword', async () => {
      let agent   = await createAgent(org.id, 'test-read-agent-6');
      let session = await createSessionWithParticipant(org.id, agent.id, { name: 'No Match Session' });

      let fm = sessionManager.getFrameManager(session.id);
      fm.merge([
        { id: 'frm_nm1', type: 'message', content: { text: 'Hello world' }, authorType: 'agent', authorID: agent.id },
      ], { authorType: 'agent', authorId: agent.id });

      let tool   = instantiateTool(ReadFromSessionTool);
      let result = await tool.execute({
        agentID:   agent.id,
        sessionID: session.id,
        keyword:   'xyzzy_no_match',
      });

      assert.ok(Array.isArray(result.frames));
      assert.equal(result.frames.length, 0);
    });

    // ---- Test 36 ----
    it('should return empty array for a session with no frames', async () => {
      let agent   = await createAgent(org.id, 'test-read-agent-7');
      let session = await createSessionWithParticipant(org.id, agent.id, { name: 'Empty Read Session' });

      let tool   = instantiateTool(ReadFromSessionTool);
      let result = await tool.execute({
        agentID:   agent.id,
        sessionID: session.id,
      });

      assert.ok(Array.isArray(result.frames));
      assert.equal(result.frames.length, 0);
    });

    // ---- Test 37 ----
    it('should match keyword against JSON keys in content', async () => {
      let agent   = await createAgent(org.id, 'test-read-agent-8');
      let session = await createSessionWithParticipant(org.id, agent.id, { name: 'JSON Key Session' });

      let fm = sessionManager.getFrameManager(session.id);
      fm.merge([
        { id: 'frm_j1', type: 'tool-result', content: { exitCode: 0, stdout: 'ok' }, authorType: 'agent', authorID: agent.id },
      ], { authorType: 'agent', authorId: agent.id });

      let tool   = instantiateTool(ReadFromSessionTool);
      let result = await tool.execute({
        agentID:   agent.id,
        sessionID: session.id,
        keyword:   'exitCode',
      });

      assert.ok(result.frames.length >= 1);
    });
  });

  // ===========================================================================
  // cross-session:inviteParticipant
  // ===========================================================================

  describe('cross-session:inviteParticipant', () => {
    beforeEach(async () => {
      org = await createOrg('InviteParticipant Org');
    });

    // ---- Test 38 ----
    it('should invite an agent to the current session', async () => {
      let agentA  = await createAgent(org.id, 'test-inv-agent-1');
      let agentB  = await createAgent(org.id, 'test-inv-agent-2');
      let session = await createSessionWithParticipant(org.id, agentA.id, { name: 'Invite Current' });

      let tool   = instantiateTool(InviteParticipantTool);
      let result = await tool.execute({
        agentID:   agentA.id,
        sessionID: session.id,
        agentName: 'test-inv-agent-2',
      });

      assert.ok(result.participantID);
      assert.equal(result.sessionID, session.id);
      assert.equal(result.agentName, 'test-inv-agent-2');

      let participants = await sessionManager.getParticipants(session.id);
      let found = participants.find((p) => p.agentID === agentB.id);
      assert.ok(found, 'agentB should now be a participant');
    });

    // ---- Test 39 ----
    it('should invite an agent to a different session', async () => {
      let agentA  = await createAgent(org.id, 'test-inv-agent-3');
      let agentB  = await createAgent(org.id, 'test-inv-agent-4');
      let session = await createSessionWithParticipant(org.id, agentA.id, { name: 'Invite Different' });

      let tool   = instantiateTool(InviteParticipantTool);
      let result = await tool.execute({
        agentID:   agentA.id,
        sessionID: session.id,
        agentName: 'test-inv-agent-4',
      });

      assert.ok(result.participantID);

      let participants = await sessionManager.getParticipants(session.id);
      let found = participants.find((p) => p.agentID === agentB.id);
      assert.ok(found);
    });

    // ---- Test 40 ----
    it('should reject when agent name does not exist', async () => {
      let agent   = await createAgent(org.id, 'test-inv-agent-5');
      let session = await createSessionWithParticipant(org.id, agent.id, { name: 'Invite Ghost' });

      let tool = instantiateTool(InviteParticipantTool);

      await assert.rejects(
        () => tool.execute({
          agentID:   agent.id,
          sessionID: session.id,
          agentName: 'test-nonexistent-invite',
        }),
        (err) => {
          assert.ok(err.message.toLowerCase().includes('not found') || err.message.toLowerCase().includes('agent'));
          return true;
        },
      );
    });

    // ---- Test 41 ----
    it('should be idempotent when agent is already a participant', async () => {
      let agentA  = await createAgent(org.id, 'test-inv-agent-6');
      let agentB  = await createAgent(org.id, 'test-inv-agent-7');
      let session = await createSessionWithParticipant(org.id, agentA.id, { name: 'Invite Idempotent' });

      // Add agentB manually first
      await sessionManager.addParticipant(session.id, agentB.id);

      let tool   = instantiateTool(InviteParticipantTool);
      let result = await tool.execute({
        agentID:   agentA.id,
        sessionID: session.id,
        agentName: 'test-inv-agent-7',
      });

      // Should succeed without error (idempotent)
      assert.ok(result.participantID || result.alreadyMember);

      // Verify no duplicate participant records
      let participants = await sessionManager.getParticipants(session.id);
      let matches = participants.filter((p) => p.agentID === agentB.id);
      assert.equal(matches.length, 1, 'should not create duplicate participant');
    });

    // ---- Test 42 ----
    it('should reject inviting to an archived session', async () => {
      let agentA  = await createAgent(org.id, 'test-inv-agent-8');
      let agentB  = await createAgent(org.id, 'test-inv-agent-9');
      let session = await createSessionWithParticipant(org.id, agentA.id, { name: 'Invite Archived' });
      await sessionManager.archiveSession(session.id);

      let tool = instantiateTool(InviteParticipantTool);

      await assert.rejects(
        () => tool.execute({
          agentID:   agentA.id,
          sessionID: session.id,
          agentName: 'test-inv-agent-9',
        }),
        (err) => {
          assert.ok(err.message.toLowerCase().includes('archived'));
          return true;
        },
      );
    });

    // ---- Test 43 ----
    it('should reject when agent invites itself', async () => {
      let agent   = await createAgent(org.id, 'test-inv-agent-10');
      let session = await createSessionWithParticipant(org.id, agent.id, { name: 'Self Invite' });

      let tool = instantiateTool(InviteParticipantTool);

      await assert.rejects(
        () => tool.execute({
          agentID:   agent.id,
          sessionID: session.id,
          agentName: 'test-inv-agent-10',
        }),
        (err) => {
          assert.ok(err.message.toLowerCase().includes('self') || err.message.toLowerCase().includes('itself') || err.message.toLowerCase().includes('already'));
          return true;
        },
      );
    });
  });
});
