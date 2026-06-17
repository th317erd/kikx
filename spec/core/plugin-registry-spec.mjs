'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { PermissionRequiredError } from '../../src/core/permissions/permission-required-error.mjs';
import { AgentInterface, PluginInterface, PluginRegistry } from '../../src/core/plugins/index.mjs';

class EchoTool extends PluginInterface {
  static pluginID = 'test';
  static featureName = 'echo';
  static riskLevel = 'none';

  async _execute(params) {
    return params.text;
  }
}

class RenderedTool extends EchoTool {
  static frameType = 'RenderedToolFrame';
  static clientComponent = {
    tagName: 'kikx-rendered-tool',
    moduleURL: '/client/plugins/rendered-tool.mjs',
  };
}

class DangerousTool extends PluginInterface {
  static pluginID = 'test';
  static featureName = 'danger';
  static riskLevel = 'high';

  async _execute() {
    return 'should not run';
  }
}

class TestAgent extends AgentInterface {
  static pluginId = 'test-agent';
  static displayName = 'Test Agent';
  static configFields = [
    { name: 'model', required: true },
    { name: 'apiKey', secret: true },
  ];
}

test('PluginRegistry registers and retrieves tool classes', () => {
  let registry = new PluginRegistry({ logger: { warn() {} } });

  registry.registerTool('test:echo', EchoTool);

  assert.equal(registry.getTool('test:echo'), EchoTool);
  assert.equal(registry.getTools().get('test:echo'), EchoTool);
});

test('PluginRegistry registers client frame and tool component descriptors', () => {
  let registry = new PluginRegistry({ logger: { warn() {} } });

  let frameDescriptor = registry.registerFrameComponent('ToolResult', {
    tagName: 'kikx-tool-result-frame',
    moduleURL: '/client/components/tool-result-frame.mjs',
  });
  let toolDescriptor = registry.registerToolComponent('web-search', {
    tagName: 'kikx-web-search-result',
    moduleURL: '/client/plugins/web-search-result.mjs',
  });

  assert.equal(frameDescriptor.kind, 'frame');
  assert.equal(frameDescriptor.frameType, 'ToolResult');
  assert.equal(registry.getFrameComponents().get('ToolResult').tagName, 'kikx-tool-result-frame');
  assert.equal(toolDescriptor.kind, 'tool');
  assert.equal(toolDescriptor.toolName, 'web-search');
  assert.deepEqual(registry.listClientComponentDescriptors(), [
    frameDescriptor,
    toolDescriptor,
  ]);
});

test('PluginRegistry auto-registers tool clientComponent metadata', () => {
  let registry = new PluginRegistry({ logger: { warn() {} } });

  registry.registerTool('rendered-tool', RenderedTool);

  assert.equal(registry.getTool('rendered-tool'), RenderedTool);
  assert.deepEqual(registry.getToolComponents().get('rendered-tool'), {
    kind: 'tool',
    toolName: 'rendered-tool',
    tagName: 'kikx-rendered-tool',
    moduleURL: '/client/plugins/rendered-tool.mjs',
  });
  assert.deepEqual(registry.getFrameComponents().get('RenderedToolFrame'), {
    kind: 'frame',
    frameType: 'RenderedToolFrame',
    tagName: 'kikx-rendered-tool',
    moduleURL: '/client/plugins/rendered-tool.mjs',
  });
});

test('PluginRegistry rejects tools that do not extend PluginInterface', () => {
  let registry = new PluginRegistry();

  assert.throws(
    () => registry.registerTool('bad:tool', class BadTool {}),
    /must extend PluginInterface/,
  );
});

test('PluginRegistry registers only AgentInterface-backed agent providers', () => {
  let registry = new PluginRegistry({ logger: { warn() {} } });

  registry.registerAgentProvider('test-agent', TestAgent);

  assert.equal(registry.getAgentProvider('test-agent'), TestAgent);
  assert.equal(registry.getAgentProviders().get('test-agent'), TestAgent);
  assert.deepEqual(registry.listAgentProviderDescriptors(), [
    {
      pluginID: 'test-agent',
      agentType: 'test-agent',
      serviceType: null,
      displayName: 'Test Agent',
      description: '',
      configFields: [
        {
          name: 'model',
          label: 'model',
          type: 'text',
          required: true,
          secret: false,
          defaultValue: undefined,
          options: undefined,
          help: '',
        },
        {
          name: 'apiKey',
          label: 'apiKey',
          type: 'text',
          required: false,
          secret: true,
          defaultValue: undefined,
          options: undefined,
          help: '',
        },
      ],
    },
  ]);

  assert.throws(
    () => registry.registerAgentProvider('bad-agent', class BadAgent {}),
    /must extend AgentInterface/,
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
