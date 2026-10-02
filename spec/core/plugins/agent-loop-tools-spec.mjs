'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_TOOL_DEFINITIONS,
} from '../../../src/core/plugins/agent-tool-definitions.mjs';
import {
  createLoopToolDefinitions,
  createLoopTools,
} from '../../../src/core/plugins/agent-loop-tools.mjs';
import { createLoopState } from '../../../src/core/plugins/agent-loop-state.mjs';

test('every built-in agent tool definition carries its own help text', () => {
  assert.ok(AGENT_TOOL_DEFINITIONS.length > 0);
  for (let definition of AGENT_TOOL_DEFINITIONS) {
    assert.equal(typeof definition.name, 'string');
    assert.ok(definition.help.trim() !== '', `${definition.name} has help text`);
  }

  let helpDefinition = AGENT_TOOL_DEFINITIONS.find((definition) => definition.name === 'help');
  assert.ok(helpDefinition, 'help tool is defined');
});

test('the help tool lists all exposed tools with their help', () => {
  let definitions = createLoopToolDefinitions({ isCoordinator: true });
  let names = definitions.map((definition) => definition.name);
  assert.ok(names.includes('help'));

  let tools = createLoopTools(createLoopState(), { isCoordinator: true });
  let listed = tools['help']({});

  assert.equal(listed.type, 'ToolResult');
  assert.equal(listed.action, 'help');
  assert.ok(listed.content.tools.length > 0);
  assert.equal(listed.content.tools.every((tool) => tool.help.trim() !== ''), true);
  assert.ok(listed.content.tools.some((tool) => tool.name === 'help'));
  assert.match(listed.content.text, /- agent-respond: /);
});

test('the help tool returns the full help for a single named tool', () => {
  let tools = createLoopTools(createLoopState(), { isCoordinator: true });
  let described = tools['help']({ tool: 'agent-respond' });

  assert.equal(described.action, 'help');
  assert.equal(described.content.found, true);
  assert.equal(described.content.tool, 'agent-respond');
  assert.match(described.content.help, /completed any needed tool work/);
  assert.equal(described.content.parameters.type, 'object');
  assert.deepEqual(described.content.parameters.required, [ 'text' ]);
});

test('the help tool fails loud for an unknown tool name', () => {
  let tools = createLoopTools(createLoopState(), { isCoordinator: true });
  let missing = tools['help']({ tool: 'does-not-exist' });

  assert.equal(missing.content.found, false);
  assert.match(missing.content.message, /Unknown tool: does-not-exist/);
  assert.match(missing.content.message, /Available tools: .*agent-respond/);
});

test('the help tool includes plugin-registered tools', () => {
  let ToolClass = class {
    static description = 'Echo a value.';
    static help = 'Echo one value back to the caller.';
    static inputSchema = { type: 'object', properties: {}, additionalProperties: false };
  };
  let context = {
    isCoordinator: false,
    pluginRegistry: {
      getTools() {
        return new Map([ [ 'global-echo', ToolClass ] ]);
      },
    },
  };
  let tools = createLoopTools(createLoopState(), context);
  let described = tools['help']({ tool: 'global-echo' });

  assert.equal(described.content.found, true);
  assert.equal(described.content.help, 'Echo one value back to the caller.');
});
