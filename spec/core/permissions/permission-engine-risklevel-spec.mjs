'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }    from '../../../src/core/index.mjs';
import { PermissionEngine }  from '../../../src/core/permissions/index.mjs';
import { SessionManager }    from '../../../src/core/session/index.mjs';

// =============================================================================
// PermissionEngine — Risk Level 3-Way Branch
// =============================================================================
// Tests the danger-level resolution chain and the three behavioral branches:
//   - 'strict'     — no ancestry walk-up, default deny
//   - 'normal'     — full ancestry walk-up, default deny
//   - 'permissive' — full ancestry walk-up, no-match auto-allows
//
// Also covers the resolution chain priority:
//   options.riskLevel > agent.getConfig().riskLevel > user.getSettings().riskLevel > 'strict'
// =============================================================================

describe('PermissionEngine — risk level 3-way branch', () => {
  let core;
  let engine;
  let sessionManager;
  let org;
  let orgID;

  before(async () => {
    core = createKikxCore();
    await core.start();
    engine = core.getPermissionEngine();
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  beforeEach(async () => {
    let { Organization } = core.getModels();
    org     = await Organization.create({ name: 'Risk Level Test Org' });
    orgID   = org.id;

    // Create a fresh SessionManager and place it on the context
    sessionManager = new SessionManager(core.getContext());
    core.getContext().setProperty('sessionManager', sessionManager);
  });

  // Helper: create a session chain [grandparent, parent, child, ...]
  async function createSessionChain(depth) {
    let sessions = [];
    let previous = null;

    for (let index = 0; index < depth; index++) {
      let options = { name: `Level ${index}` };

      if (previous)
        options.parentSessionID = previous.id;

      let session = await sessionManager.createSession(orgID, options);
      sessions.push(session);
      previous = session;
    }

    return sessions;
  }

  // Helper: mock agent with async getConfig
  function mockAgent(riskLevel) {
    if (riskLevel === undefined)
      return { getConfig: async () => ({}) };

    return { getConfig: async () => ({ riskLevel }) };
  }

  // Helper: mock user with async getSettings
  function mockUser(riskLevel) {
    if (riskLevel === undefined)
      return { getSettings: async () => ({}) };

    return { getSettings: async () => ({ riskLevel }) };
  }

  // ===========================================================================
  // Resolution chain tests
  // ===========================================================================

  describe('_resolveRiskLevel — resolution chain', () => {
    it('should use explicit options.riskLevel when provided', async () => {
      let result = await engine._resolveRiskLevel({ riskLevel: 'permissive' });
      assert.equal(result, 'permissive');
    });

    it('should use agent config riskLevel when no explicit override', async () => {
      let result = await engine._resolveRiskLevel({ agent: mockAgent('normal') });
      assert.equal(result, 'normal');
    });

    it('should fall back to user settings when agent has no riskLevel', async () => {
      let result = await engine._resolveRiskLevel({
        agent: mockAgent(undefined),
        user:  mockUser('permissive'),
      });

      assert.equal(result, 'permissive');
    });

    it('should fall back to strict when neither agent nor user has riskLevel', async () => {
      let result = await engine._resolveRiskLevel({
        agent: mockAgent(undefined),
        user:  mockUser(undefined),
      });

      assert.equal(result, 'strict');
    });

    it('should fall back to strict when no agent and no user provided', async () => {
      let result = await engine._resolveRiskLevel({});
      assert.equal(result, 'strict');
    });

    it('should treat medium as normal (backward compat)', async () => {
      let result = await engine._resolveRiskLevel({ agent: mockAgent('medium') });
      assert.equal(result, 'normal');
    });

    it('should treat medium from options.riskLevel as normal', async () => {
      let result = await engine._resolveRiskLevel({ riskLevel: 'medium' });
      assert.equal(result, 'normal');
    });

    it('should treat medium from user settings as normal', async () => {
      let result = await engine._resolveRiskLevel({ user: mockUser('medium') });
      assert.equal(result, 'normal');
    });

    it('should throw for invalid riskLevel value', async () => {
      await assert.rejects(
        () => engine._resolveRiskLevel({ riskLevel: 'yolo' }),
        { message: 'Invalid risk level: yolo' },
      );
    });

    it('should throw for invalid riskLevel from agent config', async () => {
      await assert.rejects(
        () => engine._resolveRiskLevel({ agent: mockAgent('high') }),
        { message: 'Invalid risk level: high' },
      );
    });

    it('should throw for invalid riskLevel from user settings', async () => {
      await assert.rejects(
        () => engine._resolveRiskLevel({ user: mockUser('low') }),
        { message: 'Invalid risk level: low' },
      );
    });

    it('options.riskLevel takes priority over agent config', async () => {
      let result = await engine._resolveRiskLevel({
        riskLevel: 'strict',
        agent:     mockAgent('permissive'),
      });

      assert.equal(result, 'strict');
    });

    it('agent config takes priority over user settings', async () => {
      let result = await engine._resolveRiskLevel({
        agent: mockAgent('strict'),
        user:  mockUser('permissive'),
      });

      assert.equal(result, 'strict');
    });
  });

  // ===========================================================================
  // Resolution chain — edge cases
  // ===========================================================================

  describe('_resolveRiskLevel — edge cases', () => {
    it('should handle agent without getConfig method', async () => {
      let result = await engine._resolveRiskLevel({ agent: {} });
      assert.equal(result, 'strict');
    });

    it('should handle user without getSettings method', async () => {
      let result = await engine._resolveRiskLevel({ user: {} });
      assert.equal(result, 'strict');
    });

    it('should handle agent with getConfig returning null riskLevel', async () => {
      let agent = { getConfig: async () => ({ riskLevel: null }) };
      // null is falsy, so falls through to user
      let result = await engine._resolveRiskLevel({ agent });
      assert.equal(result, 'strict');
    });

    it('should handle agent with getConfig returning empty string riskLevel', async () => {
      let agent = { getConfig: async () => ({ riskLevel: '' }) };
      // empty string is falsy, so falls through to user
      let result = await engine._resolveRiskLevel({ agent });
      assert.equal(result, 'strict');
    });

    it('should handle user with getSettings returning null riskLevel', async () => {
      let user = { getSettings: async () => ({ riskLevel: null }) };
      let result = await engine._resolveRiskLevel({ user });
      assert.equal(result, 'strict');
    });

    it('should handle no options at all', async () => {
      let result = await engine._resolveRiskLevel();
      assert.equal(result, 'strict');
    });
  });

  // ===========================================================================
  // 'strict' behavior tests
  // ===========================================================================

  describe('strict mode behavior', () => {
    it('should not walk up ancestor sessions', async () => {
      let sessions = await createSessionChain(2);
      let parent   = sessions[0];
      let child    = sessions[1];

      // Allow rule in parent session
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        parent.id,
        createdBy:      'usr_test',
      });

      // Strict mode: parent rule should NOT be visible
      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        child.id,
        riskLevel:      'strict',
      });

      assert.equal(result, true); // Needs permission — parent rule invisible
    });

    it('should still match rules scoped to the exact current session', async () => {
      let [session] = await createSessionChain(1);

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        session.id,
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        session.id,
        riskLevel:      'strict',
      });

      assert.equal(result, false); // Same-session rule still works
    });

    it('should still apply global rules in strict mode', async () => {
      let sessions = await createSessionChain(2);
      let child    = sessions[1];

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'global',
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        child.id,
        riskLevel:      'strict',
      });

      assert.equal(result, false); // Global rules always apply
    });

    it('should default deny when no rules match (no match = needs permission)', async () => {
      let [session] = await createSessionChain(1);

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        session.id,
        riskLevel:      'strict',
      });

      assert.equal(result, true); // Default deny
    });

    it('should not walk up grandparent sessions', async () => {
      let sessions    = await createSessionChain(3);
      let grandparent = sessions[0];
      let grandchild  = sessions[2];

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        grandparent.id,
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        grandchild.id,
        riskLevel:      'strict',
      });

      assert.equal(result, true); // Grandparent rule invisible in strict mode
    });

    it('should still throw PermissionDeniedError for deny rules in current session', async () => {
      let [session] = await createSessionChain(1);

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'deny',
        scope:          'session',
        scopeID:        session.id,
        createdBy:      'usr_test',
      });

      await assert.rejects(
        () => engine.checkPermission('shell:execute', {}, {
          organizationID: orgID,
          scope:          'session',
          scopeID:        session.id,
          riskLevel:      'strict',
        }),
        (error) => error.name === 'PermissionDeniedError',
      );
    });
  });

  // ===========================================================================
  // 'normal' behavior tests
  // ===========================================================================

  describe('normal mode behavior', () => {
    it('should walk up ancestor sessions (full ancestry)', async () => {
      let sessions = await createSessionChain(2);
      let parent   = sessions[0];
      let child    = sessions[1];

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        parent.id,
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        child.id,
        riskLevel:      'normal',
      });

      assert.equal(result, false); // Parent rule visible
    });

    it('should default deny when no rules match', async () => {
      let [session] = await createSessionChain(1);

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        session.id,
        riskLevel:      'normal',
      });

      assert.equal(result, true); // Default deny
    });

    it('should still throw PermissionDeniedError for deny rules', async () => {
      let [session] = await createSessionChain(1);

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'deny',
        scope:          'session',
        scopeID:        session.id,
        createdBy:      'usr_test',
      });

      await assert.rejects(
        () => engine.checkPermission('shell:execute', {}, {
          organizationID: orgID,
          scope:          'session',
          scopeID:        session.id,
          riskLevel:      'normal',
        }),
        (error) => error.name === 'PermissionDeniedError',
      );
    });

    it('should walk up to grandparent sessions', async () => {
      let sessions    = await createSessionChain(3);
      let grandparent = sessions[0];
      let grandchild  = sessions[2];

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        grandparent.id,
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        grandchild.id,
        riskLevel:      'normal',
      });

      assert.equal(result, false);
    });

    it('medium backward compat behaves same as normal', async () => {
      let sessions = await createSessionChain(2);
      let parent   = sessions[0];
      let child    = sessions[1];

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        parent.id,
        createdBy:      'usr_test',
      });

      // 'medium' resolves to 'normal' — walk-up should work
      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        child.id,
        agent:          mockAgent('medium'),
      });

      assert.equal(result, false);
    });
  });

  // ===========================================================================
  // 'permissive' behavior tests
  // ===========================================================================

  describe('permissive mode behavior', () => {
    it('should walk up ancestor sessions', async () => {
      let sessions = await createSessionChain(2);
      let parent   = sessions[0];
      let child    = sessions[1];

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        parent.id,
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        child.id,
        riskLevel:      'permissive',
      });

      assert.equal(result, false);
    });

    it('should auto-allow when no rules match (no-match = false)', async () => {
      let [session] = await createSessionChain(1);

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        session.id,
        riskLevel:      'permissive',
      });

      assert.equal(result, false); // Auto-allowed — no explicit deny
    });

    it('should still throw PermissionDeniedError for explicit deny rules', async () => {
      let [session] = await createSessionChain(1);

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'deny',
        scope:          'session',
        scopeID:        session.id,
        createdBy:      'usr_test',
      });

      await assert.rejects(
        () => engine.checkPermission('shell:execute', {}, {
          organizationID: orgID,
          scope:          'session',
          scopeID:        session.id,
          riskLevel:      'permissive',
        }),
        (error) => error.name === 'PermissionDeniedError',
      );
    });

    it('should still throw PermissionDeniedError for deny in ancestor session', async () => {
      let sessions = await createSessionChain(2);
      let parent   = sessions[0];
      let child    = sessions[1];

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'deny',
        scope:          'session',
        scopeID:        parent.id,
        createdBy:      'usr_test',
      });

      await assert.rejects(
        () => engine.checkPermission('shell:execute', {}, {
          organizationID: orgID,
          scope:          'session',
          scopeID:        child.id,
          riskLevel:      'permissive',
        }),
        (error) => error.name === 'PermissionDeniedError',
      );
    });

    it('should still apply explicit allow rules normally', async () => {
      let [session] = await createSessionChain(1);

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        session.id,
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        session.id,
        riskLevel:      'permissive',
      });

      assert.equal(result, false);
    });

    it('should auto-allow with no rules at all (no org rules exist)', async () => {
      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        riskLevel:      'permissive',
      });

      assert.equal(result, false); // Auto-allowed
    });

    it('should still throw for global deny rule in permissive mode', async () => {
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'deny',
        scope:          'global',
        createdBy:      'usr_test',
      });

      await assert.rejects(
        () => engine.checkPermission('shell:execute', {}, {
          organizationID: orgID,
          riskLevel:      'permissive',
        }),
        (error) => error.name === 'PermissionDeniedError',
      );
    });
  });

  // ===========================================================================
  // Safety net unchanged — riskLevel none/critical bypass risk level branch
  // ===========================================================================

  describe('safety net unchanged', () => {
    it('toolClass.riskLevel none auto-allows regardless of agent risk level (strict)', async () => {
      class SafeTool {
        static riskLevel = 'none';
      }

      let result = await engine.checkPermission('safe:tool', {}, {
        organizationID: orgID,
        toolClass:      SafeTool,
        riskLevel:      'strict',
      });

      assert.equal(result, false);
    });

    it('toolClass.riskLevel none auto-allows regardless of agent risk level (permissive)', async () => {
      class SafeTool {
        static riskLevel = 'none';
      }

      let result = await engine.checkPermission('safe:tool', {}, {
        organizationID: orgID,
        toolClass:      SafeTool,
        riskLevel:      'permissive',
      });

      assert.equal(result, false);
    });

    it('toolClass.riskLevel critical always needs approval in strict mode', async () => {
      await engine.createRule({
        organizationID: orgID,
        featureName:    'nuclear:launch',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      class CriticalTool {
        static riskLevel = 'critical';
      }

      let result = await engine.checkPermission('nuclear:launch', {}, {
        organizationID: orgID,
        toolClass:      CriticalTool,
        riskLevel:      'strict',
      });

      assert.equal(result, true);
    });

    it('toolClass.riskLevel critical always needs approval in normal mode', async () => {
      await engine.createRule({
        organizationID: orgID,
        featureName:    'nuclear:launch',
        effect:         'allow',
        createdBy:      'usr_test',
      });

      class CriticalTool {
        static riskLevel = 'critical';
      }

      let result = await engine.checkPermission('nuclear:launch', {}, {
        organizationID: orgID,
        toolClass:      CriticalTool,
        riskLevel:      'normal',
      });

      assert.equal(result, true);
    });

    it('toolClass.riskLevel critical always needs approval in permissive mode', async () => {
      class CriticalTool {
        static riskLevel = 'critical';
      }

      let result = await engine.checkPermission('nuclear:launch', {}, {
        organizationID: orgID,
        toolClass:      CriticalTool,
        riskLevel:      'permissive',
      });

      assert.equal(result, true); // Even permissive can't override critical
    });
  });

  // ===========================================================================
  // Integration: risk level resolved via agent passed in checkPermission
  // ===========================================================================

  describe('integration — risk level from agent in checkPermission', () => {
    it('strict agent blocks ancestry walk-up', async () => {
      let sessions = await createSessionChain(2);
      let parent   = sessions[0];
      let child    = sessions[1];

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        parent.id,
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        child.id,
        agent:          mockAgent('strict'),
      });

      assert.equal(result, true); // Parent rule invisible
    });

    it('normal agent allows ancestry walk-up', async () => {
      let sessions = await createSessionChain(2);
      let parent   = sessions[0];
      let child    = sessions[1];

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        parent.id,
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        child.id,
        agent:          mockAgent('normal'),
      });

      assert.equal(result, false); // Parent rule visible
    });

    it('permissive agent auto-allows on no match', async () => {
      let [session] = await createSessionChain(1);

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        session.id,
        agent:          mockAgent('permissive'),
      });

      assert.equal(result, false); // Auto-allowed
    });

    it('permissive agent still throws for deny rules', async () => {
      let [session] = await createSessionChain(1);

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'deny',
        scope:          'session',
        scopeID:        session.id,
        createdBy:      'usr_test',
      });

      await assert.rejects(
        () => engine.checkPermission('shell:execute', {}, {
          organizationID: orgID,
          scope:          'session',
          scopeID:        session.id,
          agent:          mockAgent('permissive'),
        }),
        (error) => error.name === 'PermissionDeniedError',
      );
    });
  });

  // ===========================================================================
  // Integration: risk level resolved via user in checkPermission
  // ===========================================================================

  describe('integration — risk level from user in checkPermission', () => {
    it('user with strict setting blocks ancestry walk-up', async () => {
      let sessions = await createSessionChain(2);
      let parent   = sessions[0];
      let child    = sessions[1];

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        parent.id,
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        child.id,
        user:           mockUser('strict'),
      });

      assert.equal(result, true); // Parent rule invisible
    });

    it('user with permissive setting auto-allows on no match', async () => {
      let [session] = await createSessionChain(1);

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        session.id,
        user:           mockUser('permissive'),
      });

      assert.equal(result, false); // Auto-allowed
    });

    it('agent config overrides user settings', async () => {
      let sessions = await createSessionChain(2);
      let parent   = sessions[0];
      let child    = sessions[1];

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        parent.id,
        createdBy:      'usr_test',
      });

      // Agent says strict, user says normal — agent should win
      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        child.id,
        agent:          mockAgent('strict'),
        user:           mockUser('normal'),
      });

      assert.equal(result, true); // Agent's strict blocks walk-up
    });
  });

  // ===========================================================================
  // Contrast tests — same setup, different risk levels produce different results
  // ===========================================================================

  describe('contrast — same rules, different risk levels', () => {
    it('strict vs normal vs permissive with parent rule', async () => {
      let sessions = await createSessionChain(2);
      let parent   = sessions[0];
      let child    = sessions[1];

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        parent.id,
        createdBy:      'usr_test',
      });

      // Strict: can't see parent rule → needs permission
      let strictResult = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        child.id,
        riskLevel:      'strict',
      });
      assert.equal(strictResult, true);

      // Normal: sees parent rule → allowed
      let normalResult = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        child.id,
        riskLevel:      'normal',
      });
      assert.equal(normalResult, false);

      // Permissive: sees parent rule → allowed (also would auto-allow even without it)
      let permissiveResult = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        child.id,
        riskLevel:      'permissive',
      });
      assert.equal(permissiveResult, false);
    });

    it('strict vs normal vs permissive with no rules', async () => {
      let [session] = await createSessionChain(1);

      // Strict: no rules → needs permission
      let strictResult = await engine.checkPermission('unknown:tool', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        session.id,
        riskLevel:      'strict',
      });
      assert.equal(strictResult, true);

      // Normal: no rules → needs permission
      let normalResult = await engine.checkPermission('unknown:tool', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        session.id,
        riskLevel:      'normal',
      });
      assert.equal(normalResult, true);

      // Permissive: no rules → auto-allowed
      let permissiveResult = await engine.checkPermission('unknown:tool', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        session.id,
        riskLevel:      'permissive',
      });
      assert.equal(permissiveResult, false);
    });
  });
});
