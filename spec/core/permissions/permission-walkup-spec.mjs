'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore } from '../../../src/core/index.mjs';
import { PermissionEngine } from '../../../src/core/permissions/index.mjs';
import { SessionManager } from '../../../src/core/session/index.mjs';

// =============================================================================
// Permission Walk-Up
// =============================================================================
// Tests for PermissionEngine.checkPermission() ancestry walk-up behavior.
//
// When a sessionManager is available and options.scopeID references a session,
// the engine queries permission rules across ALL ancestor sessions (self first,
// then parent, grandparent, etc.). Closer ancestor rules take priority.
//
// Also tests the agent config risk-level guard: only 'medium' is supported;
// any other value throws.
// =============================================================================

describe('PermissionEngine — permission walk-up', () => {
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
    org     = await Organization.create({ name: 'Walk-Up Test Org' });
    orgID   = org.id;

    // Create a fresh SessionManager and place it on the context
    sessionManager = new SessionManager(core.getContext());
    core.getContext().setProperty('sessionManager', sessionManager);
  });

  // Helper: create a session chain [grandparent, parent, child]
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

  // ---------------------------------------------------------------------------
  // Basic walk-up: existing single-session behavior preserved
  // ---------------------------------------------------------------------------

  describe('single-session behavior (preserved)', () => {
    it('should match rule in current session', async () => {
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
      });

      assert.equal(result, false);
    });

    it('should return true (needs permission) when no rules exist in current session', async () => {
      let [session] = await createSessionChain(1);

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        session.id,
      });

      assert.equal(result, true);
    });
  });

  // ---------------------------------------------------------------------------
  // Walk-up: parent and grandparent rule resolution
  // ---------------------------------------------------------------------------

  describe('ancestry walk-up', () => {
    it('should find allow rule in parent when current session has none', async () => {
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
      });

      assert.equal(result, false);
    });

    it('should find allow rule in grandparent when current and parent have none', async () => {
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
      });

      assert.equal(result, false);
    });

    it('should find deny rule in parent and throw PermissionDeniedError', async () => {
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
        }),
        (error) => error.name === 'PermissionDeniedError',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Closer ancestor wins over distant ancestor
  // ---------------------------------------------------------------------------

  describe('closer ancestor priority', () => {
    it('should prefer allow rule in child over deny in parent', async () => {
      let sessions = await createSessionChain(2);
      let parent   = sessions[0];
      let child    = sessions[1];

      // Deny in parent
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'deny',
        scope:          'session',
        scopeID:        parent.id,
        createdBy:      'usr_test',
      });

      // Allow in child (closer)
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        child.id,
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        child.id,
      });

      assert.equal(result, false);
    });

    it('should prefer deny rule in child over allow in parent', async () => {
      let sessions = await createSessionChain(2);
      let parent   = sessions[0];
      let child    = sessions[1];

      // Allow in parent
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        parent.id,
        createdBy:      'usr_test',
      });

      // Deny in child (closer)
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'deny',
        scope:          'session',
        scopeID:        child.id,
        createdBy:      'usr_test',
      });

      await assert.rejects(
        () => engine.checkPermission('shell:execute', {}, {
          organizationID: orgID,
          scope:          'session',
          scopeID:        child.id,
        }),
        (error) => error.name === 'PermissionDeniedError',
      );
    });

    it('deny in closer ancestor overrides allow in distant ancestor (3-level)', async () => {
      let sessions    = await createSessionChain(3);
      let grandparent = sessions[0];
      let parent      = sessions[1];
      let grandchild  = sessions[2];

      // Allow in grandparent (distant)
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        grandparent.id,
        createdBy:      'usr_test',
      });

      // Deny in parent (closer)
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
          scopeID:        grandchild.id,
        }),
        (error) => error.name === 'PermissionDeniedError',
      );
    });

    it('allow in closer ancestor overrides deny in distant ancestor (3-level)', async () => {
      let sessions    = await createSessionChain(3);
      let grandparent = sessions[0];
      let parent      = sessions[1];
      let grandchild  = sessions[2];

      // Deny in grandparent (distant)
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'deny',
        scope:          'session',
        scopeID:        grandparent.id,
        createdBy:      'usr_test',
      });

      // Allow in parent (closer)
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
        scopeID:        grandchild.id,
      });

      assert.equal(result, false);
    });
  });

  // ---------------------------------------------------------------------------
  // No rules in any ancestor — needs approval
  // ---------------------------------------------------------------------------

  describe('no rules in ancestry', () => {
    it('should return true when no rules exist in any ancestor session', async () => {
      let sessions   = await createSessionChain(3);
      let grandchild = sessions[2];

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        grandchild.id,
      });

      assert.equal(result, true);
    });
  });

  // ---------------------------------------------------------------------------
  // Agent config risk-level guard
  // ---------------------------------------------------------------------------

  describe('agent config risk-level guard', () => {
    it('should throw for unsupported risk level (low)', async () => {
      let [session] = await createSessionChain(1);

      let mockAgent = {
        getConfig: () => ({ riskLevel: 'low' }),
      };

      await assert.rejects(
        () => engine.checkPermission('shell:execute', {}, {
          organizationID: orgID,
          scope:          'session',
          scopeID:        session.id,
          agent:          mockAgent,
        }),
        { message: 'Unsupported risk level: low' },
      );
    });

    it('should throw for unsupported risk level (high)', async () => {
      let [session] = await createSessionChain(1);

      let mockAgent = {
        getConfig: () => ({ riskLevel: 'high' }),
      };

      await assert.rejects(
        () => engine.checkPermission('shell:execute', {}, {
          organizationID: orgID,
          scope:          'session',
          scopeID:        session.id,
          agent:          mockAgent,
        }),
        { message: 'Unsupported risk level: high' },
      );
    });

    it('should proceed normally for medium risk level', async () => {
      let [session] = await createSessionChain(1);

      let mockAgent = {
        getConfig: () => ({ riskLevel: 'medium' }),
      };

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
        agent:          mockAgent,
      });

      assert.equal(result, false);
    });

    it('should default to medium when agent has no getConfig method', async () => {
      let [session] = await createSessionChain(1);

      let mockAgent = {};

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        session.id,
        createdBy:      'usr_test',
      });

      // Should NOT throw — defaults to medium
      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        session.id,
        agent:          mockAgent,
      });

      assert.equal(result, false);
    });

    it('should default to medium when no agent is provided', async () => {
      let [session] = await createSessionChain(1);

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        session.id,
        createdBy:      'usr_test',
      });

      // No agent in options at all — should NOT throw
      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        session.id,
      });

      assert.equal(result, false);
    });
  });

  // ---------------------------------------------------------------------------
  // Graceful fallback when no sessionManager available
  // ---------------------------------------------------------------------------

  describe('graceful fallback (no sessionManager)', () => {
    it('should fall back to single-session behavior when sessionManager is not on context', async () => {
      // Remove sessionManager from context
      core.getContext().setProperty('sessionManager', null);

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        'ses_nonexistent',
      });

      // No matching rules at all, so needs permission
      assert.equal(result, true);

      // Restore for subsequent tests
      core.getContext().setProperty('sessionManager', sessionManager);
    });

    it('should still match rules in current session when sessionManager is absent', async () => {
      let [session] = await createSessionChain(1);

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        session.id,
        createdBy:      'usr_test',
      });

      // Remove sessionManager from context
      core.getContext().setProperty('sessionManager', null);

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        session.id,
      });

      // The rule still matches via the existing _filterByScope, even without walk-up
      assert.equal(result, false);

      // Restore for subsequent tests
      core.getContext().setProperty('sessionManager', sessionManager);
    });
  });

  // ---------------------------------------------------------------------------
  // Global rules still apply during walk-up
  // ---------------------------------------------------------------------------

  describe('global rules during walk-up', () => {
    it('should still match global rules even when walking up session ancestry', async () => {
      let sessions   = await createSessionChain(3);
      let grandchild = sessions[2];

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
        scopeID:        grandchild.id,
      });

      assert.equal(result, false);
    });
  });

  // ---------------------------------------------------------------------------
  // Tool riskLevel shortcuts still work with walk-up
  // ---------------------------------------------------------------------------

  describe('riskLevel shortcuts during walk-up', () => {
    it('should auto-allow tools with riskLevel none regardless of ancestry', async () => {
      let sessions   = await createSessionChain(2);
      let child      = sessions[1];

      class SafeTool {
        static riskLevel = 'none';
      }

      let result = await engine.checkPermission('safe:tool', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        child.id,
        toolClass:      SafeTool,
      });

      assert.equal(result, false);
    });

    it('should always require approval for critical tools regardless of ancestry rules', async () => {
      let sessions = await createSessionChain(2);
      let parent   = sessions[0];
      let child    = sessions[1];

      await engine.createRule({
        organizationID: orgID,
        featureName:    'nuclear:launch',
        effect:         'allow',
        scope:          'session',
        scopeID:        parent.id,
        createdBy:      'usr_test',
      });

      class CriticalTool {
        static riskLevel = 'critical';
      }

      let result = await engine.checkPermission('nuclear:launch', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        child.id,
        toolClass:      CriticalTool,
      });

      assert.equal(result, true);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should handle walk-up when session has no parent (root session)', async () => {
      let [root] = await createSessionChain(1);

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        root.id,
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        root.id,
      });

      assert.equal(result, false);
    });

    it('should not match rules from unrelated sessions during walk-up', async () => {
      let sessions        = await createSessionChain(2);
      let child           = sessions[1];
      let unrelatedChain  = await createSessionChain(1);
      let unrelatedRoot   = unrelatedChain[0];

      // Rule in unrelated session
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        unrelatedRoot.id,
        createdBy:      'usr_test',
      });

      // Check child — should NOT find the unrelated rule
      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        child.id,
      });

      assert.equal(result, true);
    });

    it('should handle expired rules in ancestor sessions', async () => {
      let sessions = await createSessionChain(2);
      let parent   = sessions[0];
      let child    = sessions[1];
      let past     = new Date(Date.now() - 60000);

      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        parent.id,
        expiresAt:      past,
        createdBy:      'usr_test',
      });

      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        child.id,
      });

      // Expired rule should be ignored, so still needs permission
      assert.equal(result, true);
    });

    it('should handle multiple rules at different ancestor levels with priority', async () => {
      let sessions    = await createSessionChain(3);
      let grandparent = sessions[0];
      let parent      = sessions[1];
      let grandchild  = sessions[2];

      // Low-priority deny in grandparent
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'deny',
        scope:          'session',
        scopeID:        grandparent.id,
        priority:       1,
        createdBy:      'usr_test',
      });

      // High-priority allow in parent (closer ancestor)
      await engine.createRule({
        organizationID: orgID,
        featureName:    'shell:execute',
        effect:         'allow',
        scope:          'session',
        scopeID:        parent.id,
        priority:       10,
        createdBy:      'usr_test',
      });

      // Parent's allow should win (closer ancestor takes priority)
      let result = await engine.checkPermission('shell:execute', {}, {
        organizationID: orgID,
        scope:          'session',
        scopeID:        grandchild.id,
      });

      assert.equal(result, false);
    });
  });
});
