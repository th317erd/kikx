'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore } from '../../../../src/core/index.mjs';
import { ShellPermissions } from '../../../../src/core/internal-plugins/shell/shell-permissions.mjs';

// =============================================================================
// Shell Tool
// =============================================================================

describe('ShellTool', () => {
  let core;

  beforeEach(async () => {
    core = createKikxCore();
    await core.start();
  });

  afterEach(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  it('should register as shell:execute tool', () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('shell:execute');
    assert.ok(ToolClass, 'shell:execute should be registered');
  });

  it('should execute a simple command', async () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('shell:execute');
    let tool      = new ToolClass(core.getContext());

    let result = await tool.execute({ command: 'echo hello' });

    assert.equal(result.stdout.trim(), 'hello');
    assert.equal(result.exitCode, 0);
  });

  it('should capture stderr', async () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('shell:execute');
    let tool      = new ToolClass(core.getContext());

    let result = await tool.execute({ command: 'echo error >&2' });

    assert.equal(result.stderr.trim(), 'error');
    assert.equal(result.exitCode, 0);
  });

  it('should return non-zero exit code for failing commands', async () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('shell:execute');
    let tool      = new ToolClass(core.getContext());

    let result = await tool.execute({ command: 'false' });

    assert.notEqual(result.exitCode, 0);
  });

  it('should throw if command is missing', async () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('shell:execute');
    let tool      = new ToolClass(core.getContext());

    await assert.rejects(
      () => tool.execute({}),
      { message: 'command is required' },
    );
  });

  it('should expose getPermissionsClass()', () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('shell:execute');
    let tool      = new ToolClass(core.getContext());

    assert.equal(tool.getPermissionsClass(), ShellPermissions);
  });

  it('should provide help information', () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('shell:execute');
    let tool      = new ToolClass(core.getContext());
    let help      = tool.getHelp();

    assert.equal(help.name, 'shell:execute');
    assert.equal(help.displayName, 'Shell');
    assert.ok(help.description);
    assert.ok(help.usage);
    assert.ok(Array.isArray(help.examples));
  });
});

// =============================================================================
// ShellPermissions
// =============================================================================

describe('ShellPermissions', () => {
  it('should check each command individually', async () => {
    let checked = [];

    let mockEngine = {
      checkPermission: async (featureName, _args, _options) => {
        checked.push(featureName);

        return featureName === 'shell:rm'; // Only rm needs permission
      },
    };

    let commands = [
      { command: 'ls', arguments: [] },
      { command: 'rm', arguments: ['-rf', '/'] },
    ];

    let result = await ShellPermissions.checkCommands(commands, mockEngine, {});

    assert.equal(result, true); // rm needs permission
    assert.ok(checked.includes('shell:ls'));
    assert.ok(checked.includes('shell:rm'));
  });

  it('should return false when all commands are allowed', async () => {
    let mockEngine = {
      checkPermission: async () => false, // All allowed
    };

    let commands = [
      { command: 'ls', arguments: [] },
      { command: 'echo', arguments: ['hello'] },
    ];

    let result = await ShellPermissions.checkCommands(commands, mockEngine, {});

    assert.equal(result, false); // All allowed
  });

  it('should block entire pipeline if any command needs permission', async () => {
    let mockEngine = {
      checkPermission: async (featureName) => {
        return featureName === 'shell:sudo'; // Only sudo blocked
      },
    };

    let commands = [
      { command: 'echo', arguments: ['hello'] },
      { command: 'sudo', arguments: ['rm', '-rf', '/'] },
      { command: 'ls', arguments: [] },
    ];

    let result = await ShellPermissions.checkCommands(commands, mockEngine, {});

    assert.equal(result, true); // Blocked because sudo needs permission
  });
});
