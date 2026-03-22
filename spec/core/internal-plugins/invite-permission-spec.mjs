'use strict';

import { describe, it }              from 'node:test';
import assert                         from 'node:assert/strict';

import { SystemCommandPermissions }   from '../../../src/core/internal-plugins/system-command/system-command-permissions.mjs';
import { PermissionRequiredError }    from '../../../src/core/permissions/permission-required-error.mjs';

// =============================================================================
// Invite Capability — Permission Verification
// =============================================================================
// The invite capability (riskLevel 'high') is executed through system:command.
// SystemCommandPermissions handles the permission check and throws
// PermissionRequiredError with rich context. These tests verify that the
// invite capability is correctly handled by the existing system:command
// permission flow — no separate PermissionsClass needed.
// =============================================================================

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(pluginRegistry) {
  return {
    getProperty(name) {
      if (name === 'pluginRegistry') return pluginRegistry || null;
      return null;
    },
  };
}

function makeRegistry(capabilities = {}) {
  return {
    getCapabilityBySlashCommand(name) {
      return capabilities[name] || null;
    },
  };
}

describe('Invite capability via SystemCommandPermissions', () => {

  // ---------------------------------------------------------------------------
  // invite has riskLevel 'high' → should throw PermissionRequiredError
  // ---------------------------------------------------------------------------

  it('should throw PermissionRequiredError for invite (riskLevel high)', async () => {
    let registry = makeRegistry({ invite: { riskLevel: 'high' } });
    let perms    = new SystemCommandPermissions(makeContext(registry));

    await assert.rejects(
      () => perms.checkPermission('command:invite', { args: '@test-claude' }),
      (error) => {
        assert.ok(error instanceof PermissionRequiredError);
        assert.equal(error.featureName, 'command:invite');
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Details include the /invite @agentName command string
  // ---------------------------------------------------------------------------

  it('should include /invite @agentName in details', async () => {
    let registry = makeRegistry({ invite: { riskLevel: 'high' } });
    let perms    = new SystemCommandPermissions(makeContext(registry));

    await assert.rejects(
      () => perms.checkPermission('command:invite', { args: '@test-claude' }),
      (error) => {
        let detail = error.details.find(d => d.label === 'permission.detail.command');
        assert.ok(detail, 'should have command detail');
        assert.equal(detail.value, '/invite @test-claude');
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // invite with riskLevel 'low' would be auto-approved (hypothetical)
  // ---------------------------------------------------------------------------

  it('should auto-approve if invite had riskLevel "low"', async () => {
    let registry = makeRegistry({ invite: { riskLevel: 'low' } });
    let perms    = new SystemCommandPermissions(makeContext(registry));

    let result = await perms.checkPermission('command:invite', {});
    assert.strictEqual(result, false);
  });

  // ---------------------------------------------------------------------------
  // invite without registry → still throws (not in ALWAYS_ALLOWED)
  // ---------------------------------------------------------------------------

  it('should throw PermissionRequiredError even without registry', async () => {
    let perms = new SystemCommandPermissions(makeContext(null));

    await assert.rejects(
      () => perms.checkPermission('command:invite', { args: '@someone' }),
      (error) => {
        assert.ok(error instanceof PermissionRequiredError);
        assert.equal(error.featureName, 'command:invite');
        return true;
      },
    );
  });
});
