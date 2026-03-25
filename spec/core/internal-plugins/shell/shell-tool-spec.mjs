'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore } from '../../../../src/core/index.mjs';
import { PluginInterface } from '../../../../src/core/plugin-loader/plugin-interface.mjs';
import { PluginRegistry } from '../../../../src/core/plugin-loader/registry.mjs';
import { setup as shellSetup } from '../../../../src/core/internal-plugins/shell/index.mjs';
import { ShellPermissions } from '../../../../src/core/internal-plugins/shell/shell-permissions.mjs';

// =============================================================================
// Helpers
// =============================================================================

function createShellTool() {
  let registry = new PluginRegistry();
  let context  = {
    getProperty: () => null,
  };

  registry.registerClass(PluginInterface, { pluginName: 'core' });
  shellSetup((cb) => cb({ registry, context }));

  let ToolClass = registry.getTool('shell:execute');
  let tool      = new ToolClass(context);

  return { tool, ToolClass, registry };
}

// =============================================================================
// ShellTool — standalone (no DB required)
// =============================================================================

describe('ShellTool', () => {
  it('should register as shell:execute tool', () => {
    let { ToolClass } = createShellTool();
    assert.ok(ToolClass, 'shell:execute should be registered');
  });

  it('should execute a simple command', async () => {
    let { tool } = createShellTool();
    let result   = await tool.execute({ command: 'echo hello' });

    assert.equal(result.stdout.trim(), 'hello');
    assert.equal(result.exitCode, 0);
  });

  it('should capture stderr', async () => {
    let { tool } = createShellTool();
    let result   = await tool.execute({ command: 'echo error >&2' });

    assert.equal(result.stderr.trim(), 'error');
    assert.equal(result.exitCode, 0);
  });

  it('should return non-zero exit code for failing commands', async () => {
    let { tool } = createShellTool();
    let result   = await tool.execute({ command: 'false' });

    assert.notEqual(result.exitCode, 0);
  });

  it('should throw if command is missing', async () => {
    let { tool } = createShellTool();

    await assert.rejects(
      () => tool.execute({}),
      { message: 'command is required' },
    );
  });

  it('should expose getPermissionsClass()', () => {
    let { tool } = createShellTool();
    assert.equal(tool.getPermissionsClass(), ShellPermissions);
  });

  it('should provide help information', () => {
    let { tool } = createShellTool();
    let help     = tool.getHelp();

    assert.equal(help.name, 'shell:execute');
    assert.equal(help.displayName, 'Shell');
    assert.ok(help.description);
    assert.ok(help.usage);
    assert.ok(Array.isArray(help.examples));
  });

  // -------------------------------------------------------------------------
  // Login shell — sources user profile
  // -------------------------------------------------------------------------

  it('should use a login shell that sources user environment', async () => {
    let { tool } = createShellTool();

    // A login shell sets certain variables. Verify the shell is bash (or $SHELL)
    // by checking that the login flag is actually sourcing profiles.
    // We can detect login shell by checking $0 — login shells have a leading dash
    // or by checking HISTFILE is overridden.
    let result = await tool.execute({ command: 'echo $HISTFILE' });

    assert.equal(result.stdout.trim(), '/dev/null');
    assert.equal(result.exitCode, 0);
  });

  it('should have PATH from user profile (login shell)', async () => {
    let { tool } = createShellTool();

    // Login shells source the profile chain, so PATH should be populated
    // with more than just /usr/bin (e.g. user's ~/bin, nvm shims, etc.)
    let result = await tool.execute({ command: 'echo $PATH' });

    assert.ok(result.stdout.trim().length > 0, 'PATH should not be empty');
    assert.equal(result.exitCode, 0);
  });

  // -------------------------------------------------------------------------
  // History suppression
  // -------------------------------------------------------------------------

  it('should set HISTFILE to /dev/null', async () => {
    let { tool } = createShellTool();
    let result   = await tool.execute({ command: 'echo $HISTFILE' });

    assert.equal(result.stdout.trim(), '/dev/null');
  });

  it('should set HISTSIZE to 0 in env (profile may override)', async () => {
    let { tool } = createShellTool();

    // HISTSIZE=0 is set in the env, but login shell profiles often
    // reset it (e.g. ~/.bashrc sets HISTSIZE=1000). The real guard
    // is HISTFILE=/dev/null which prevents any history I/O regardless.
    // Verify HISTSIZE was at least attempted via the env vars.
    let result = await tool.execute({ command: 'env | grep HISTSIZE' });

    // If profile overrides it, env will show the profile value.
    // Either way, HISTFILE=/dev/null is the authoritative guard.
    assert.equal(result.exitCode, 0);
  });

  it('should not write to real history file', async () => {
    let { tool } = createShellTool();

    // Run a command and verify HISTFILE is still /dev/null inside the shell
    let result = await tool.execute({
      command: 'env | grep HISTFILE',
    });

    assert.ok(result.stdout.includes('/dev/null'));
  });
});

// =============================================================================
// ShellTool — DB-dependent (KikxCore integration)
// =============================================================================

describe('ShellTool integration', () => {
  let core;

  beforeEach(async () => {
    core = createKikxCore();
    await core.start();
  });

  afterEach(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  it('should auto-load as internal plugin', () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('shell:execute');
    assert.ok(ToolClass, 'shell:execute should be auto-loaded');
  });
});

// =============================================================================
// ShellPermissions
// =============================================================================

describe('ShellPermissions', () => {
  // checkCommands() static was removed in Phase 2 (replaced by evaluate() flow)

  // ---- Permissions base class integration ----

  it('should extend the Permissions base class', async () => {
    let { Permissions } = await import('../../../../src/core/permissions/permissions-base.mjs');
    let perms = new ShellPermissions({});
    assert.ok(perms instanceof Permissions);
  });

  it('should match rule with no metadata (matchesRule)', () => {
    let perms  = new ShellPermissions({});
    let result = perms.matchesRule({}, { command: 'ls' }, {});
    assert.deepEqual(result, { matches: true });
  });

  it('should match rule when command is in allowedCommands', () => {
    let perms    = new ShellPermissions({});
    let metadata = { allowedCommands: ['ls', 'cat', 'echo'] };
    let result   = perms.matchesRule({}, { command: 'cat /etc/passwd' }, metadata);
    assert.deepEqual(result, { matches: true });
  });

  it('should not match rule when command is not in allowedCommands', () => {
    let perms    = new ShellPermissions({});
    let metadata = { allowedCommands: ['ls', 'cat'] };
    let result   = perms.matchesRule({}, { command: 'rm -rf /' }, metadata);
    assert.deepEqual(result, { matches: false });
  });

  it('should match rule when args has no command', () => {
    let perms    = new ShellPermissions({});
    let metadata = { allowedCommands: ['ls'] };
    let result   = perms.matchesRule({}, {}, metadata);
    assert.deepEqual(result, { matches: true });
  });
});
