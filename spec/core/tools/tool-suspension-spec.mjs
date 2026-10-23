'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { ToolExecutionService } from '../../../src/core/tools/tool-execution-service.mjs';
import { PluginInterface } from '../../../src/core/plugins/plugin-interface.mjs';

class ProbeTool extends PluginInterface {
  static pluginID = 'spec:probe';
  static displayName = 'Probe';
  static description = 'Probe';
  static inputSchema = { type: 'object', properties: {} };
  static riskLevel = 'none';
  async _execute() {
    ProbeTool.executed += 1;
    return { ok: true };
  }
}
ProbeTool.executed = 0;

function context({ suspended }) {
  return {
    agent: { id: 'agent_1' },
    session: { id: 'ses_1' },
    frame: { id: 'frame_1' },
    services: {
      frameRuntime: {
        isAgentSuspended(_sessionID, _agentID) { return suspended; },
      },
      toolOutputStore: null,
    },
  };
}

test('a suspended agent cannot start another tool call', async () => {
  ProbeTool.executed = 0;
  let service = new ToolExecutionService();
  await assert.rejects(
    () => service.executeTool({
      toolName: 'probe',
      ToolClass: ProbeTool,
      input: {},
      context: context({ suspended: true }),
    }),
    /session is suspended/,
  );
  assert.equal(ProbeTool.executed, 0);
});

test('an unsuspended agent can run tools normally', async () => {
  ProbeTool.executed = 0;
  let service = new ToolExecutionService({ toolOutputStore: null });
  let result = await service.executeTool({
    toolName: 'probe',
    ToolClass: ProbeTool,
    input: {},
    context: context({ suspended: false }),
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(ProbeTool.executed, 1);
});
