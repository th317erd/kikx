'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Permissions }            from '../../../src/core/permissions/permissions-base.mjs';
import { ShellPermissions }       from '../../../src/core/internal-plugins/shell/shell-permissions.mjs';
import { PermissionRequiredError } from '../../../src/core/permissions/permission-required-error.mjs';
import { PermissionDeniedError }   from '../../../src/core/permissions/permission-denied-error.mjs';

// =============================================================================
// ShellPermissions.checkPermission() — Tests
// =============================================================================
// Tests for the batch per-command permission checking in ShellPermissions.
//
// The checkPermission() override parses a shell command string into individual
// commands, checks each against evaluate() (via the Permissions base class), and:
//   - returns false if ALL commands are approved
//   - throws PermissionRequiredError with per-command details if any need approval
//   - rethrows PermissionDeniedError (deny-forever blocks everything)
// =============================================================================

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Stub evaluate() on ShellPermissions to return controlled results per feature
function makeShellPermissions(approvedFeatures) {
  let approved = new Set(approvedFeatures || []);

  let context = {
    getProperty() { return null; },
  };

  let perms = new ShellPermissions(context);

  // Override evaluate() to simulate rule matching without a real database
  perms.evaluate = async (featureName) => {
    if (approved.has(featureName))
      return false; // approved — no approval needed
    return true; // needs approval
  };

  return perms;
}

function makeDenyingShellPermissions(denyFeature) {
  let context = {
    getProperty() { return null; },
  };

  let perms = new ShellPermissions(context);

  perms.evaluate = async (featureName) => {
    if (featureName === denyFeature)
      throw new PermissionDeniedError(featureName, 'explicit deny rule');
    return true;
  };

  return perms;
}

// =============================================================================
// Tests
// =============================================================================

describe('ShellPermissions.checkPermission()', () => {

  // ===========================================================================
  // Class structure
  // ===========================================================================

  describe('class structure', () => {
    it('extends the base Permissions class', () => {
      let context = { getProperty() { return null; } };
      let instance = new ShellPermissions(context);
      assert.ok(instance instanceof Permissions);
    });

    it('overrides checkPermission', () => {
      assert.notEqual(
        ShellPermissions.prototype.checkPermission,
        Permissions.prototype.checkPermission,
        'checkPermission should be overridden',
      );
    });

    it('does not have a static checkCommands method (removed)', () => {
      assert.equal(typeof ShellPermissions.checkCommands, 'undefined',
        'checkCommands static should be removed');
    });
  });

  // ===========================================================================
  // Happy paths
  // ===========================================================================

  describe('happy paths', () => {
    it('single command, not approved — throws PermissionRequiredError with 1 pending detail', async () => {
      let permissions = makeShellPermissions([]); // nothing approved

      await assert.rejects(
        () => permissions.checkPermission('shell:execute', { command: 'rm -rf /tmp/test' }, {}),
        (error) => {
          assert.equal(error.name, 'PermissionRequiredError');
          assert.equal(error.featureName, 'shell:execute');
          assert.equal(error.details.length, 1);
          assert.equal(error.details[0].label, 'permission.detail.pendingCommand');
          return true;
        },
      );
    });

    it('single command, already approved — returns false', async () => {
      let permissions = makeShellPermissions(['shell:ls']);

      let result = await permissions.checkPermission('shell:execute', { command: 'ls' }, {});
      assert.equal(result, false);
    });

    it('multiple commands, all approved — returns false', async () => {
      let permissions = makeShellPermissions(['shell:ls', 'shell:cat']);

      let result = await permissions.checkPermission('shell:execute', { command: 'ls && cat foo.txt' }, {});
      assert.equal(result, false);
    });

    it('multiple commands, some approved some pending — throws with mixed details', async () => {
      let permissions = makeShellPermissions(['shell:ls']); // ls approved, cat not

      await assert.rejects(
        () => permissions.checkPermission('shell:execute', { command: 'ls && cat secret.txt' }, {}),
        (error) => {
          assert.equal(error.name, 'PermissionRequiredError');
          assert.equal(error.details.length, 2);

          // ls should be approved, cat should be pending
          let approvedDetail = error.details.find(d => d.label === 'permission.detail.approvedCommand');
          let pendingDetail  = error.details.find(d => d.label === 'permission.detail.pendingCommand');

          assert.ok(approvedDetail, 'Should have an approved detail');
          assert.ok(pendingDetail, 'Should have a pending detail');

          return true;
        },
      );
    });

    it('details show per-command status (approvedCommand vs pendingCommand)', async () => {
      let permissions = makeShellPermissions(['shell:echo', 'shell:ls']);

      await assert.rejects(
        () => permissions.checkPermission('shell:execute', { command: 'echo hi && ls -la && rm -rf /' }, {}),
        (error) => {
          assert.equal(error.details.length, 3);

          let approved = error.details.filter(d => d.label === 'permission.detail.approvedCommand');
          let pending  = error.details.filter(d => d.label === 'permission.detail.pendingCommand');

          assert.equal(approved.length, 2, 'echo and ls should be approved');
          assert.equal(pending.length, 1, 'rm should be pending');

          return true;
        },
      );
    });

    it('command string preserved in detail values', async () => {
      let permissions = makeShellPermissions([]); // nothing approved

      await assert.rejects(
        () => permissions.checkPermission('shell:execute', { command: 'ls -la /tmp' }, {}),
        (error) => {
          // The detail value should contain the command info
          assert.ok(error.details[0].value, 'Detail value should be set');
          // Value should be a string (raw or command name)
          assert.equal(typeof error.details[0].value, 'string');
          return true;
        },
      );
    });
  });

  // ===========================================================================
  // Sad paths
  // ===========================================================================

  describe('sad paths', () => {
    it('no command in args — returns null', async () => {
      let context = { getProperty() { return null; } };
      let permissions = new ShellPermissions(context);

      let result = await permissions.checkPermission('shell:execute', {}, {});
      assert.equal(result, null);
    });

    it('args is null — returns null', async () => {
      let context = { getProperty() { return null; } };
      let permissions = new ShellPermissions(context);

      let result = await permissions.checkPermission('shell:execute', null, {});
      assert.equal(result, null);
    });

    it('empty command string — returns null', async () => {
      let context = { getProperty() { return null; } };
      let permissions = new ShellPermissions(context);

      let result = await permissions.checkPermission('shell:execute', { command: '' }, {});
      assert.equal(result, null);
    });

    it('parseShellCommands returns empty — returns null', async () => {
      let context = { getProperty() { return null; } };
      let permissions = new ShellPermissions(context);

      // Whitespace-only command should produce empty parsed results
      let result = await permissions.checkPermission('shell:execute', { command: '   ' }, {});
      assert.equal(result, null);
    });

    it('PermissionDeniedError from one command — rethrows (blocks all)', async () => {
      let permissions = makeDenyingShellPermissions('shell:rm');

      await assert.rejects(
        () => permissions.checkPermission('shell:execute', { command: 'ls && rm -rf /' }, {}),
        (error) => {
          assert.equal(error.name, 'PermissionDeniedError');
          assert.equal(error.featureName, 'shell:rm');
          return true;
        },
      );
    });

    it('evaluate() errors (non-deny) — treats command as needing approval', async () => {
      let context = { getProperty() { return null; } };
      let permissions = new ShellPermissions(context);

      // Override evaluate to throw a generic error
      permissions.evaluate = async () => { throw new Error('Database connection lost'); };

      await assert.rejects(
        () => permissions.checkPermission('shell:execute', { command: 'ls' }, {}),
        (error) => {
          assert.equal(error.name, 'PermissionRequiredError');
          assert.equal(error.details.length, 1);
          assert.equal(error.details[0].label, 'permission.detail.pendingCommand');
          return true;
        },
      );
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe('edge cases', () => {
    it('single piped command — parsed correctly, each segment checked', async () => {
      let permissions = makeShellPermissions(['shell:ls']); // ls approved, grep not

      await assert.rejects(
        () => permissions.checkPermission('shell:execute', { command: 'ls | grep foo' }, {}),
        (error) => {
          assert.equal(error.name, 'PermissionRequiredError');
          assert.equal(error.details.length, 2);

          // ls approved, grep pending
          assert.equal(error.details[0].label, 'permission.detail.approvedCommand');
          assert.equal(error.details[1].label, 'permission.detail.pendingCommand');
          return true;
        },
      );
    });

    it('PermissionRequiredError has correct locale keys', async () => {
      let permissions = makeShellPermissions([]);

      await assert.rejects(
        () => permissions.checkPermission('shell:execute', { command: 'whoami' }, {}),
        (error) => {
          assert.equal(error.title, 'permission.shell.executeTitle');
          assert.equal(error.description, 'permission.shell.executeDescription');
          assert.equal(error.featureName, 'shell:execute');
          return true;
        },
      );
    });
  });

  // ===========================================================================
  // matchesRule() unchanged
  // ===========================================================================

  describe('matchesRule() still works', () => {
    it('matches when metadata has command + arguments that match args', () => {
      let context = { getProperty() { return null; } };
      let permissions = new ShellPermissions(context);
      let result = permissions.matchesRule(
        {},
        { command: 'ls', arguments: ['-la'] },
        { command: 'ls', arguments: ['-la'] },
      );
      assert.deepEqual(result, { matches: true });
    });

    it('does not match when arguments differ', () => {
      let context = { getProperty() { return null; } };
      let permissions = new ShellPermissions(context);
      let result = permissions.matchesRule(
        {},
        { command: 'ls', arguments: ['-la'] },
        { command: 'ls', arguments: ['/etc'] },
      );
      assert.deepEqual(result, { matches: false });
    });
  });
});
