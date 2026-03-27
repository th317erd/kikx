'use strict';

import { describe, it }          from 'node:test';
import assert                     from 'node:assert/strict';

import { SystemCommandPermissions } from '../../../src/core/internal-plugins/system-command/system-command-permissions.mjs';
import { PermissionRequiredError }  from '../../../src/core/permissions/permission-required-error.mjs';

// =============================================================================
// SystemCommandPermissions
// =============================================================================
// Tests for the tool-owned permission logic in system:command.
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

describe('SystemCommandPermissions', () => {

  // ---------------------------------------------------------------------------
  // Happy path: help → auto-approved
  // ---------------------------------------------------------------------------

  it('should auto-approve "help" command (returns false)', async () => {
    let perms  = new SystemCommandPermissions(makeContext());
    let result = await perms.checkPermission('command:help', {});
    assert.strictEqual(result, false);
  });

  // ---------------------------------------------------------------------------
  // Happy path: safe capability (riskLevel 'none') → auto-approved
  // ---------------------------------------------------------------------------

  it('should auto-approve capability with riskLevel "none"', async () => {
    let registry = makeRegistry({ status: { riskLevel: 'none' } });
    let perms    = new SystemCommandPermissions(makeContext(registry));
    let result   = await perms.checkPermission('command:status', {});
    assert.strictEqual(result, false);
  });

  // ---------------------------------------------------------------------------
  // Happy path: safe capability (riskLevel 'low') → auto-approved
  // ---------------------------------------------------------------------------

  it('should auto-approve capability with riskLevel "low"', async () => {
    let registry = makeRegistry({ ping: { riskLevel: 'low' } });
    let perms    = new SystemCommandPermissions(makeContext(registry));
    let result   = await perms.checkPermission('command:ping', {});
    assert.strictEqual(result, false);
  });

  // ---------------------------------------------------------------------------
  // Happy path: unknown command → throws PermissionRequiredError with command name
  // ---------------------------------------------------------------------------

  it('should throw PermissionRequiredError for unknown command', async () => {
    let registry = makeRegistry();
    let perms    = new SystemCommandPermissions(makeContext(registry));

    await assert.rejects(
      () => perms.checkPermission('command:deploy', {}),
      (error) => {
        assert.ok(error instanceof PermissionRequiredError);
        assert.equal(error.featureName, 'command:deploy');
        assert.equal(error.title, 'Run Command: /deploy');
        assert.ok(error.description.includes('Agent is requesting to run the command'));
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Happy path: command with args → details include full command string
  // ---------------------------------------------------------------------------

  it('should include args in details when provided', async () => {
    let registry = makeRegistry();
    let perms    = new SystemCommandPermissions(makeContext(registry));

    await assert.rejects(
      () => perms.checkPermission('command:invite', { args: '@test-claude' }),
      (error) => {
        assert.ok(error instanceof PermissionRequiredError);
        let detail = error.details.find(d => d.label === 'Command');
        assert.ok(detail, 'should have command detail');
        assert.equal(detail.value, '/invite @test-claude');
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Sad path: no commandName → returns null
  // ---------------------------------------------------------------------------

  it('should return null when no commandName can be extracted', async () => {
    let perms  = new SystemCommandPermissions(makeContext());
    let result = await perms.checkPermission('unknown', {});
    assert.strictEqual(result, null);
  });

  // ---------------------------------------------------------------------------
  // Sad path: no pluginRegistry on context → falls through to throw
  // ---------------------------------------------------------------------------

  it('should throw PermissionRequiredError when no pluginRegistry on context', async () => {
    let perms = new SystemCommandPermissions(makeContext(null));

    await assert.rejects(
      () => perms.checkPermission('command:restart', {}),
      (error) => {
        assert.ok(error instanceof PermissionRequiredError);
        assert.equal(error.featureName, 'command:restart');
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Sad path: PermissionRequiredError has correct locale keys
  // ---------------------------------------------------------------------------

  it('should use correct locale keys in PermissionRequiredError', async () => {
    let registry = makeRegistry({ reload: { riskLevel: 'high' } });
    let perms    = new SystemCommandPermissions(makeContext(registry));

    await assert.rejects(
      () => perms.checkPermission('command:reload', {}),
      (error) => {
        assert.ok(error instanceof PermissionRequiredError);
        assert.equal(error.title, 'Run Command: /reload');
        assert.ok(error.description.includes('Agent is requesting to run the command'));
        assert.ok(Array.isArray(error.details));
        assert.equal(error.details[0].label, 'Command');
        assert.equal(error.details[0].value, '/reload');
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Edge case: command name with whitespace → trimmed
  // ---------------------------------------------------------------------------

  it('should trim whitespace from command name', async () => {
    let perms = new SystemCommandPermissions(makeContext());

    // 'help' with whitespace should still auto-approve
    let result = await perms.checkPermission('command:  help  ', {});
    assert.strictEqual(result, false);
  });

  // ---------------------------------------------------------------------------
  // Edge case: featureName without 'command:' prefix → extracts from args.command
  // ---------------------------------------------------------------------------

  it('should extract commandName from args.command when featureName lacks prefix', async () => {
    let registry = makeRegistry();
    let perms    = new SystemCommandPermissions(makeContext(registry));

    await assert.rejects(
      () => perms.checkPermission('system:command', { command: 'deploy', args: '--force' }),
      (error) => {
        assert.ok(error instanceof PermissionRequiredError);
        assert.equal(error.featureName, 'command:deploy');
        let detail = error.details.find(d => d.label === 'Command');
        assert.equal(detail.value, '/deploy --force');
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Edge case: command with no args → details show only /command (no trailing space)
  // ---------------------------------------------------------------------------

  it('should not have trailing space in details when args are empty', async () => {
    let registry = makeRegistry();
    let perms    = new SystemCommandPermissions(makeContext(registry));

    await assert.rejects(
      () => perms.checkPermission('command:deploy', {}),
      (error) => {
        let detail = error.details.find(d => d.label === 'Command');
        assert.equal(detail.value, '/deploy');
        return true;
      },
    );
  });
});
