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

test('model-facing tool descriptions carry the communication contract', () => {
  let descriptions = new Map(AGENT_TOOL_DEFINITIONS.map((definition) => [ definition.name, definition.description ]));

  assert.match(descriptions.get('progress'), /before a new phase or related batch/);
  assert.match(descriptions.get('progress'), /after a meaningful result/);
  assert.match(descriptions.get('end-turn'), /REQUIRED short summary of the goals completed/);
  assert.match(descriptions.get('end-turn'), /detail/);
  assert.match(descriptions.get('continue-turn'), /visible progress report/);
});

test('end-turn keeps a goals paragraph before the step bullets and long details expandable', () => {
  let state = createLoopState();
  let tools = createLoopTools(state, { isCoordinator: false });
  let control = tools['end-turn']({
    summary: 'Synced the branch and verified it with the focused spec.\n\n- Synced the branch.\n- Ran the focused spec.',
    details: 'Full evidence:\n\n| Step | Result |\n| --- | --- |\n| fetch | 0 0 |',
  });

  assert.equal(control.type, 'LoopControl');
  assert.equal(control.action, 'finalize');
  assert.equal(state.finalFrame.type, 'AgentMessage');
  assert.equal(
    state.finalFrame.content.summary,
    'Synced the branch and verified it with the focused spec.\n\n- Synced the branch.\n- Ran the focused spec.',
  );
  assert.doesNotMatch(state.finalFrame.content.summary, /^- Synced the branch and verified/m, 'the goals paragraph stays prose');
  assert.match(state.finalFrame.content.text, /Full evidence/);
  assert.equal(state.finalFrame.content.turnReport, true);

  let definition = AGENT_TOOL_DEFINITIONS.find((entry) => entry.name === 'end-turn');
  assert.deepEqual(definition.parameters.required, [ 'summary' ]);
  assert.ok(definition.parameters.properties.summary);
  assert.ok(definition.parameters.properties.details);
  assert.equal(definition.parameters.properties.text, undefined);
});

test('progress and continue-turn require a mood score', () => {
  let defs = new Map(AGENT_TOOL_DEFINITIONS.map((definition) => [ definition.name, definition ]));
  for (let name of [ 'progress', 'continue-turn' ]) {
    let definition = defs.get(name);
    assert.ok(definition.parameters.required.includes('mood'), `${name} requires mood`);
    assert.ok(definition.parameters.required.includes('moodWord'), `${name} requires moodWord`);
    assert.equal(definition.parameters.properties.moodWord.type, 'string');
    assert.equal(definition.parameters.properties.mood.minimum, -3);
    assert.equal(definition.parameters.properties.mood.maximum, 3);
  }
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
  assert.match(listed.content.text, /- end-turn: /);
});

test('the help tool returns the full help for a single named tool', () => {
  let tools = createLoopTools(createLoopState(), { isCoordinator: true });
  let described = tools['help']({ tool: 'end-turn' });

  assert.equal(described.action, 'help');
  assert.equal(described.content.found, true);
  assert.equal(described.content.tool, 'end-turn');
  assert.match(described.content.help, /when the request is satisfied/);
  assert.equal(described.content.parameters.type, 'object');
  assert.deepEqual(described.content.parameters.required, [ 'summary' ]);
});

test('the help tool fails loud for an unknown tool name', () => {
  let tools = createLoopTools(createLoopState(), { isCoordinator: true });
  let missing = tools['help']({ tool: 'does-not-exist' });

  assert.equal(missing.content.found, false);
  assert.match(missing.content.message, /Unknown tool: does-not-exist/);
  assert.match(missing.content.message, /Available tools: .*end-turn/);
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


test('write tools make an explicit session target part of the model schema', () => {
  let ToolClass = class {
    static description = 'Write into one session.';
    static help = 'Resolve the session id first.';
    static requiresTargetSessionID = true;
    static inputSchema = {
      type: 'object',
      properties: {
        text: { type: 'string' },
      },
      required: [ 'text' ],
      additionalProperties: false,
    };
  };
  let definitions = createLoopToolDefinitions({
    isCoordinator: true,
    session: { id: 'ses_1', generation: 0 },
    pluginRegistry: {
      getTools() {
        return new Map([ [ 'session-message', ToolClass ] ]);
      },
    },
  });
  let definition = definitions.find((entry) => entry.name === 'session-message');
  assert.ok(definition, 'the write tool is exposed');
  assert.deepEqual(definition.parameters.required, [ 'text', 'session_id' ]);
  assert.match(definition.parameters.properties.session_id.description, /Required target Kikx session ID/);
  assert.match(definition.parameters.properties.session_id.description, /session-list/);
});
