'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { PermissionRequiredError } from '../../src/core/permissions/permission-required-error.mjs';
import { PluginInterface, PluginRegistry } from '../../src/core/plugins/index.mjs';

class EchoTool extends PluginInterface {
  static pluginID = 'test';
  static featureName = 'echo';
  static riskLevel = 'none';

  async _execute(params) {
    return params.text;
  }
}

class DangerousTool extends PluginInterface {
  static pluginID = 'test';
  static featureName = 'danger';
  static riskLevel = 'high';

  async _execute() {
    return 'should not run';
  }
}

test('PluginRegistry registers and retrieves tool classes', () => {
  let registry = new PluginRegistry({ logger: { warn() {} } });

  registry.registerTool('test:echo', EchoTool);

  assert.equal(registry.getTool('test:echo'), EchoTool);
  assert.equal(registry.getTools().get('test:echo'), EchoTool);
});

test('PluginRegistry rejects tools that do not extend PluginInterface', () => {
  let registry = new PluginRegistry();

  assert.throws(
    () => registry.registerTool('bad:tool', class BadTool {}),
    /must extend PluginInterface/,
  );
});

test('PluginInterface permits riskLevel none without permission boundary', async () => {
  let tool = new EchoTool();

  assert.equal(await tool.execute({ text: 'hello' }), 'hello');
});

test('PluginInterface is deny-by-default when no permission boundary is registered', async () => {
  let tool = new DangerousTool();

  await assert.rejects(
    () => tool.execute({ command: 'rm -rf /tmp/example', _sessionID: 'ses_1' }),
    (error) => {
      assert.ok(error instanceof PermissionRequiredError);
      assert.equal(error.featureName, 'test:danger');
      assert.deepEqual(error.details, [
        { label: 'command', value: 'rm -rf /tmp/example' },
      ]);
      return true;
    },
  );
});

test('PluginInterface executes through an explicit permission boundary', async () => {
  let calls = [];
  let tool = new DangerousTool({
    permissions: {
      async check(request) {
        calls.push(request);
        return { allowed: true };
      },
    },
  });

  assert.equal(await tool.execute({ command: 'date' }), 'should not run');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].featureName, 'test:danger');
});

