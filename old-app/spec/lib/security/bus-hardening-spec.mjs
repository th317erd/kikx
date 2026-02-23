'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Environment Setup
// ============================================================================

let testDir = mkdtempSync(join(tmpdir(), 'hero-bus-hardening-test-'));

process.env.HERO_JWT_SECRET     = 'test-secret-key-for-testing';
process.env.HERO_ENCRYPTION_KEY = 'test-encryption-key-32chars!!';
process.env.XDG_CONFIG_HOME     = testDir;

let database;
let busModule;

async function loadModules() {
  database  = await import('../../../server/database.mjs');
  busModule = await import('../../../server/lib/interactions/bus.mjs');
}

describe('Interaction Bus Hardening (Phase 7)', async () => {
  await loadModules();

  let bus;

  beforeEach(() => {
    // Get fresh bus instance (singleton, but we can test methods)
    bus = busModule.getInteractionBus();
    bus.clearHistory();
  });

  // ===========================================================================
  // sender_id enforcement
  // ===========================================================================
  describe('sender_id enforcement', () => {
    it('should include sender_id when provided in options', () => {
      let interaction = bus.create('@user', 'prompt', { question: 'test' }, {
        userId:   1,
        senderId: 1,
      });

      assert.strictEqual(interaction.sender_id, 1);
    });

    it('should not include sender_id when not provided', () => {
      let interaction = bus.create('@user', 'prompt', { question: 'test' }, {
        userId: 1,
      });

      assert.strictEqual(interaction.sender_id, undefined);
    });

    it('should distinguish user vs agent interactions', () => {
      let userInteraction = bus.create('@system', 'command', { cmd: 'help' }, {
        userId:   1,
        senderId: 1, // User-originated
      });

      let agentInteraction = bus.create('@system', 'command', { cmd: 'help' }, {
        userId: 1,
        // No senderId — agent-originated
      });

      assert.strictEqual(userInteraction.sender_id, 1);
      assert.strictEqual(agentInteraction.sender_id, undefined);
    });
  });

  // ===========================================================================
  // respond() user verification
  // ===========================================================================
  describe('respond() user verification', () => {
    it('should accept response from correct user', async () => {
      let interaction = bus.create('@user', 'prompt', { q: 'test' }, {
        userId: 42,
      });

      // Create pending interaction
      let responsePromise = bus.request(interaction, 5000);

      // Respond as correct user
      let success = bus.respond(interaction.interaction_id, { answer: 'yes' }, true, { userId: 42 });
      assert.strictEqual(success, true);

      let result = await responsePromise;
      assert.strictEqual(result.answer, 'yes');
    });

    it('should reject response from wrong user', async () => {
      let interaction = bus.create('@user', 'prompt', { q: 'test' }, {
        userId: 42,
      });

      let responsePromise = bus.request(interaction, 5000);

      // Try to respond as different user
      let success = bus.respond(interaction.interaction_id, { answer: 'hijacked' }, true, { userId: 99 });
      assert.strictEqual(success, false);

      // Clean up — respond as correct user
      bus.respond(interaction.interaction_id, { answer: 'real' }, true, { userId: 42 });
      await responsePromise;
    });

    it('should allow response without securityContext for backward compat', async () => {
      let interaction = bus.create('@user', 'prompt', { q: 'test' }, {
        userId: 42,
      });

      let responsePromise = bus.request(interaction, 5000);

      // Respond without security context
      let success = bus.respond(interaction.interaction_id, { answer: 'ok' });
      assert.strictEqual(success, true);

      await responsePromise;
    });

    it('should return false for nonexistent interaction', () => {
      let success = bus.respond('nonexistent-id', {}, true, { userId: 1 });
      assert.strictEqual(success, false);
    });
  });

  // ===========================================================================
  // Interaction creation integrity
  // ===========================================================================
  describe('Interaction creation integrity', () => {
    it('should always generate unique interaction_id', () => {
      let ids = new Set();
      for (let i = 0; i < 100; i++) {
        let interaction = bus.create('@system', 'test', {});
        ids.add(interaction.interaction_id);
      }
      assert.strictEqual(ids.size, 100);
    });

    it('should set timestamp on creation', () => {
      let before      = Date.now();
      let interaction = bus.create('@system', 'test', {});
      let after       = Date.now();

      assert.ok(interaction.ts >= before);
      assert.ok(interaction.ts <= after);
    });

    it('should carry through session and user context', () => {
      let interaction = bus.create('@user', 'prompt', { q: 'hello' }, {
        sessionId: 5,
        userId:    10,
        sourceId:  'func-123',
      });

      assert.strictEqual(interaction.session_id, 5);
      assert.strictEqual(interaction.user_id, 10);
      assert.strictEqual(interaction.source_id, 'func-123');
      assert.strictEqual(interaction.target_id, '@user');
      assert.strictEqual(interaction.target_property, 'prompt');
    });
  });
});
