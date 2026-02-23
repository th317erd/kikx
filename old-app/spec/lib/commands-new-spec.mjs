'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Environment Setup (must happen before any app module imports)
// ============================================================================

let testDir = mkdtempSync(join(tmpdir(), 'hero-new-commands-test-'));

process.env.HERO_JWT_SECRET     = 'test-secret-key-for-testing';
process.env.HERO_ENCRYPTION_KEY = 'test-encryption-key-32chars!!';
process.env.XDG_CONFIG_HOME     = testDir;

// Dynamic imports after env is configured
let commands;
let database;
let auth;
let participants;
let frames;

async function loadModules() {
  database     = await import('../../server/database.mjs');
  auth         = await import('../../server/auth.mjs');
  participants = await import('../../server/lib/participants/index.mjs');
  frames       = await import('../../server/lib/frames/index.mjs');
  commands     = await import('../../server/lib/commands/index.mjs');
}

describe('New Commands (Phase 4)', async () => {
  await loadModules();

  let db;
  let userId;
  let agentId;
  let agent2Id;
  let sessionId;

  beforeEach(async () => {
    db = database.getDatabase();

    // Clear test data
    db.exec('DELETE FROM frames');
    db.exec('DELETE FROM session_participants');
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM users');

    // Create test user
    let user = await auth.createUser('testuser', 'testpass');
    userId   = user.id;

    // Create test agents
    let agent1Result = db.prepare(`
      INSERT INTO agents (user_id, name, type, encrypted_api_key)
      VALUES (?, 'test-agent-1', 'claude', 'fake-key')
    `).run(userId);
    agentId = Number(agent1Result.lastInsertRowid);

    let agent2Result = db.prepare(`
      INSERT INTO agents (user_id, name, type, encrypted_api_key)
      VALUES (?, 'test-agent-2', 'claude', 'fake-key')
    `).run(userId);
    agent2Id = Number(agent2Result.lastInsertRowid);

    // Create session with participants
    let sessionResult = db.prepare(`
      INSERT INTO sessions (user_id, agent_id, name)
      VALUES (?, ?, 'Test Session')
    `).run(userId, agentId);
    sessionId = Number(sessionResult.lastInsertRowid);

    participants.addParticipant(sessionId, 'user', userId, 'owner', db);
    participants.addParticipant(sessionId, 'agent', agentId, 'coordinator', db);
  });

  // ===========================================================================
  // /participants
  // ===========================================================================
  describe('/participants', () => {
    it('should be registered as a command', () => {
      assert.ok(commands.getCommand('participants'));
    });

    it('should list all session participants', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('participants', '', context);

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('test-agent-1'));
      assert.ok(result.content.includes('testuser'));
      assert.ok(result.content.includes('[coordinator]'));
      assert.ok(result.content.includes('[owner]'));
    });

    it('should list multiple agents', async () => {
      // Add second agent
      participants.addParticipant(sessionId, 'agent', agent2Id, 'member', db);

      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('participants', '', context);

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('test-agent-1'));
      assert.ok(result.content.includes('test-agent-2'));
    });

    it('should fail without session', async () => {
      let context = { userId, db };
      let result  = await commands.executeCommand('participants', '', context);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('session'));
    });
  });

  // ===========================================================================
  // /invite
  // ===========================================================================
  describe('/invite', () => {
    it('should be registered as a command', () => {
      assert.ok(commands.getCommand('invite'));
    });

    it('should add an agent to the session', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('invite', String(agent2Id), context);

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('test-agent-2'));
      assert.ok(result.content.includes('member'));

      // Verify participant was actually added
      assert.strictEqual(
        participants.isParticipant(sessionId, 'agent', agent2Id, db),
        true,
      );
    });

    it('should support alias via as: syntax', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('invite', `${agent2Id} as:Helper`, context);

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('Helper'));
    });

    it('should reject unknown agent name', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('invite', 'abc', context);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not found'));
    });

    it('should reject unknown agent name with extra args', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('invite', `${agent2Id} admin`, context);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not found'));
    });

    it('should reject already-participant agent', async () => {
      let context = { sessionId, userId, db };
      // agentId is already the coordinator
      let result = await commands.executeCommand('invite', String(agentId), context);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('already a participant'));
    });

    it('should reject nonexistent agent', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('invite', '99999', context);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not found'));
    });

    it('should fail without args', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('invite', '', context);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Usage'));
    });

    it('should fail without session', async () => {
      let context = { userId, db };
      let result  = await commands.executeCommand('invite', String(agent2Id), context);

      assert.strictEqual(result.success, false);
    });
  });

  // ===========================================================================
  // /kick
  // ===========================================================================
  describe('/kick', () => {
    it('should be registered as a command', () => {
      assert.ok(commands.getCommand('kick'));
    });

    it('should remove an agent from the session', async () => {
      // First add agent2
      participants.addParticipant(sessionId, 'agent', agent2Id, 'member', db);

      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('kick', String(agent2Id), context);

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('test-agent-2'));
      assert.ok(result.content.includes('removed'));

      // Verify participant was actually removed
      assert.strictEqual(
        participants.isParticipant(sessionId, 'agent', agent2Id, db),
        false,
      );
    });

    it('should reject non-participant agent', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('kick', String(agent2Id), context);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not a participant'));
    });

    it('should reject unknown agent name', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('kick', 'abc', context);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not found'));
    });

    it('should fail without args', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('kick', '', context);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Usage'));
    });

    it('should fail without session', async () => {
      let context = { userId, db };
      let result  = await commands.executeCommand('kick', String(agentId), context);

      assert.strictEqual(result.success, false);
    });
  });

  // ===========================================================================
  // /history
  // ===========================================================================
  describe('/history', () => {
    it('should be registered as a command', () => {
      assert.ok(commands.getCommand('history'));
    });

    it('should show message history', async () => {
      // Create some frames
      frames.createFrame({
        sessionId: sessionId,
        type:      'message',
        authorType: 'user',
        authorId:  userId,
        payload:   { role: 'user', content: 'Hello there', hidden: false },
      }, db);

      frames.createFrame({
        sessionId: sessionId,
        type:      'message',
        authorType: 'agent',
        authorId:  agentId,
        payload:   { role: 'assistant', content: 'Hi! How can I help?', hidden: false },
      }, db);

      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('history', '', context);

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('Hello there'));
      assert.ok(result.content.includes('Hi! How can I help?'));
    });

    it('should respect count argument', async () => {
      // Create 5 messages
      for (let i = 0; i < 5; i++) {
        frames.createFrame({
          sessionId:  sessionId,
          type:       'message',
          authorType: 'user',
          authorId:   userId,
          payload:    { role: 'user', content: `Message ${i}`, hidden: false },
        }, db);
      }

      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('history', '3', context);

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('last 3'));
    });

    it('should skip hidden messages', async () => {
      frames.createFrame({
        sessionId:  sessionId,
        type:       'message',
        authorType: 'system',
        payload:    { role: 'system', content: 'Secret system message', hidden: true },
      }, db);

      frames.createFrame({
        sessionId:  sessionId,
        type:       'message',
        authorType: 'user',
        authorId:   userId,
        payload:    { role: 'user', content: 'Visible message', hidden: false },
      }, db);

      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('history', '', context);

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('Visible message'));
      assert.ok(!result.content.includes('Secret system message'));
    });

    it('should handle empty session', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('history', '', context);

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('No messages'));
    });

    it('should fail without session', async () => {
      let context = { userId, db };
      let result  = await commands.executeCommand('history', '', context);

      assert.strictEqual(result.success, false);
    });

    it('should cap count at 100', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('history', '500', context);

      // Should not error, just silently cap
      assert.strictEqual(result.success, true);
    });
  });

  // ===========================================================================
  // /export
  // ===========================================================================
  describe('/export', () => {
    it('should be registered as a command', () => {
      assert.ok(commands.getCommand('export'));
    });

    it('should export as text by default', async () => {
      frames.createFrame({
        sessionId:  sessionId,
        type:       'message',
        authorType: 'user',
        authorId:   userId,
        payload:    { role: 'user', content: 'Test export message', hidden: false },
      }, db);

      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('export', '', context);

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('Test export message'));
      assert.ok(result.content.includes('Test Session'));
    });

    it('should export as JSON', async () => {
      frames.createFrame({
        sessionId:  sessionId,
        type:       'message',
        authorType: 'user',
        authorId:   userId,
        payload:    { role: 'user', content: 'JSON export test', hidden: false },
      }, db);

      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('export', 'json', context);

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('```json'));
      assert.ok(result.content.includes('JSON export test'));
      assert.ok(result.content.includes('exportedAt'));
    });

    it('should export as markdown', async () => {
      frames.createFrame({
        sessionId:  sessionId,
        type:       'message',
        authorType: 'user',
        authorId:   userId,
        payload:    { role: 'user', content: 'Markdown export test', hidden: false },
      }, db);

      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('export', 'markdown', context);

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('# Test Session'));
      assert.ok(result.content.includes('###'));
      assert.ok(result.content.includes('Markdown export test'));
    });

    it('should reject unknown format', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('export', 'pdf', context);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Unknown format'));
    });

    it('should skip hidden messages in export', async () => {
      frames.createFrame({
        sessionId:  sessionId,
        type:       'message',
        authorType: 'system',
        payload:    { role: 'system', content: 'Hidden system msg', hidden: true },
      }, db);

      frames.createFrame({
        sessionId:  sessionId,
        type:       'message',
        authorType: 'user',
        authorId:   userId,
        payload:    { role: 'user', content: 'Visible msg', hidden: false },
      }, db);

      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('export', 'text', context);

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('Visible msg'));
      assert.ok(!result.content.includes('Hidden system msg'));
    });

    it('should handle empty session', async () => {
      let context = { sessionId, userId, db };
      let result  = await commands.executeCommand('export', '', context);

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('No messages'));
    });

    it('should fail without session', async () => {
      let context = { userId, db };
      let result  = await commands.executeCommand('export', '', context);

      assert.strictEqual(result.success, false);
    });
  });

  // ===========================================================================
  // Command registry completeness
  // ===========================================================================
  describe('Command registry', () => {
    it('should have all new commands registered', () => {
      let allCommands = commands.getAllCommands();
      let names       = allCommands.map((c) => c.name);

      assert.ok(names.includes('participants'), 'participants should be registered');
      assert.ok(names.includes('invite'), 'invite should be registered');
      assert.ok(names.includes('kick'), 'kick should be registered');
      assert.ok(names.includes('history'), 'history should be registered');
      assert.ok(names.includes('export'), 'export should be registered');
    });

    it('should include new commands in /help output', async () => {
      let result = await commands.executeCommand('help', '', { userId: 1 });

      assert.strictEqual(result.success, true);
      assert.ok(result.content.includes('/participants'));
      assert.ok(result.content.includes('/invite'));
      assert.ok(result.content.includes('/kick'));
      assert.ok(result.content.includes('/history'));
      assert.ok(result.content.includes('/export'));
    });
  });
});
