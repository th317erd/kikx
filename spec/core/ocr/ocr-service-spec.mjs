'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { OcrService } from '../../../src/core/ocr/index.mjs';

class FailingOcrProvider {
  static supportsOcr = true;
  async runOcr() {
    throw new Error('primary down');
  }
}

class WorkingOcrProvider {
  static supportsOcr = true;
  async runOcr(request) {
    return { text: `OCR:${request.images.join(',')}` };
  }
}

test('OcrService tries OCR agents in descending tag order and falls back', async () => {
  let providerRegistry = new Map([
    [ 'failing-ocr', FailingOcrProvider ],
    [ 'working-ocr', WorkingOcrProvider ],
  ]);
  let service = new OcrService({
    agentManager: {
      async listAgents() {
        return [
          { id: 'agent_1', name: 'Primary', pluginID: 'failing-ocr', enabled: true, tags: [
            { name: 'ocr_score', value: 10 },
            { name: 'ocr_priority_at', value: 200 },
          ] },
          { id: 'agent_2', name: 'Backup', pluginID: 'working-ocr', enabled: true, tags: [
            { name: 'ocr_score', value: 10 },
            { name: 'ocr_priority_at', value: 100 },
          ] },
        ];
      },
    },
    pluginRegistry: {
      getAgentProvider(pluginID) {
        return providerRegistry.get(pluginID) || null;
      },
    },
  });

  let result = await service.run({
    images: [ '/tmp/a.png', '/tmp/b.png' ],
    prompt: 'Read the labels',
  });

  assert.equal(result.text, 'OCR:/tmp/a.png,/tmp/b.png');
  assert.equal(result.agentID, 'agent_2');
  assert.equal(result.attempts.length, 1);
  assert.match(result.attempts[0].error, /primary down/);
});

test('OcrService rejects empty images and an empty OCR roster', async () => {
  let service = new OcrService({
    agentManager: { async listAgents() { return []; } },
    pluginRegistry: { getAgentProvider() { return null; } },
  });

  await assert.rejects(() => service.run({ images: [] }), /at least one image/);
  await assert.rejects(
    () => service.run({ images: [ '/tmp/a.png' ] }),
    /No OCR-capable enabled agents/,
  );
});

test('OcrService reports every failed attempt when all OCR agents fail', async () => {
  let service = new OcrService({
    agentManager: {
      async listAgents() {
        return [
          { id: 'agent_1', name: 'Primary', pluginID: 'failing-ocr', enabled: true, tags: [
            { name: 'ocr_score', value: 10 },
            { name: 'ocr_priority_at', value: 200 },
          ] },
          { id: 'agent_2', name: 'Backup', pluginID: 'failing-ocr', enabled: true, tags: [
            { name: 'ocr_score', value: 10 },
            { name: 'ocr_priority_at', value: 100 },
          ] },
        ];
      },
    },
    pluginRegistry: {
      getAgentProvider() {
        return FailingOcrProvider;
      },
    },
  });

  await assert.rejects(
    () => service.run({ images: [ '/tmp/a.png' ] }),
    (error) => {
      assert.match(error.message, /All OCR agents failed/);
      assert.equal(error.attempts.length, 2);
      return true;
    },
  );
});


test('OcrService skips a high-priority agent whose provider is not OCR-capable', async () => {
  class TextOnlyProvider {
    static supportsOcr = false;
  }

  let service = new OcrService({
    agentManager: {
      async listAgents() {
        return [
          { id: 'agent_1', name: 'Text Only', pluginID: 'text-only', enabled: true, tags: [
            { name: 'ocr_score', value: 10 },
            { name: 'ocr_priority_at', value: 200 },
          ] },
          { id: 'agent_2', name: 'Host OCR', pluginID: 'working-ocr', enabled: true, tags: [
            { name: 'ocr_score', value: 10 },
            { name: 'ocr_priority_at', value: 100 },
          ] },
        ];
      },
    },
    pluginRegistry: {
      getAgentProvider(pluginID) {
        return pluginID === 'text-only' ? TextOnlyProvider : WorkingOcrProvider;
      },
    },
  });

  let result = await service.run({ images: [ '/tmp/a.png' ] });
  assert.equal(result.agentID, 'agent_2');
});

test('OcrService gives a real OCR agent the safe tool surface', async () => {
  class ToolUsingOcrProvider {
    static supportsOcr = true;
    async runOcr(request) {
      let result = await request.tools.exec({ command: `ocr ${request.images[0]}` });
      return { text: result.text };
    }
  }
  class FakeOcrTool {
    static displayName = 'Fake OCR';
    static description = 'Fake OCR test tool';
    static inputSchema = {
      type: 'object',
      properties: { image: { type: 'string' } },
      required: [ 'image' ],
      additionalProperties: false,
    };
  }
  let executed = null;
  let service = new OcrService({
    agentManager: {
      async listAgents() {
        return [
          { id: 'agent_1', name: 'Tool Agent', pluginID: 'tool-agent', enabled: true, tags: [
            { name: 'ocr_score', value: 10 },
            { name: 'ocr_priority_at', value: 100 },
          ] },
        ];
      },
    },
    toolExecutor: {
      async executeTool(call) {
        executed = call;
        return { text: `tool:${call.input.command}` };
      },
    },
    pluginRegistry: {
      getAgentProvider() {
        return ToolUsingOcrProvider;
      },
      getTools() {
        return new Map([ [ 'exec', FakeOcrTool ] ]);
      },
    },
  });

  let result = await service.run({ images: [ '/tmp/a.png' ] });
  assert.equal(result.text, 'tool:ocr /tmp/a.png');
  assert.equal(executed.toolName, 'exec');
  assert.equal(executed.context.allowWriteFile, false);
});

test('nested OCR commands run to completion without scheduling wakes or tool frames', async () => {
  let options = null;
  let base = {
    async start(_params, _context, next = {}) {
      options = next;
      return { status: 'completed' };
    },
  };
  let service = new OcrService({
    toolExecutor: { async executeTool() {} },
    context: { require: (name) => name === 'processManager' ? base : null },
    pluginRegistry: { getAgentProvider() { return null; }, getTools() { return new Map(); } },
  });
  let tools = service.buildOcrTools({ session: { id: 'ses_1' } }, { id: 'agent_1' });

  await tools.context.processManager.start({ command: 'true' }, {}, { autoWake: true, graceMs: 10 });
  assert.equal(options.autoWake, false);
  assert.equal(options.returnCompletionIfReady, true);
  assert.equal(options.graceMs, 120000);
  assert.equal(tools.context.frameEngine.get('x'), null);
});

test('OcrService falls back to the bundled host OCR command when no tagged agent is capable', async () => {
  class HostOcrProvider {
    static supportsOcr = true;
    async runOcr() {
      return { text: 'builtin ocr text' };
    }
  }
  let service = new OcrService({
    agentManager: { async listAgents() { return []; } },
    pluginRegistry: {
      getAgentProvider(pluginID) {
        return pluginID === 'host-ocr-command' ? HostOcrProvider : null;
      },
      getTools() { return new Map(); },
    },
  });

  let result = await service.run({ images: [ '/tmp/a.png' ] });
  assert.equal(result.text, 'builtin ocr text');
  assert.equal(result.agentID, 'builtin-host-ocr');
  assert.equal(result.agentName, 'Built-in Host OCR');
});
