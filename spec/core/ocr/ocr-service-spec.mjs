'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { OcrService } from '../../../src/core/ocr/index.mjs';

class FailingOcrProvider {
  async runOcr() {
    throw new Error('primary down');
  }
}

class WorkingOcrProvider {
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
      async listTaggedAgents(name) {
        assert.equal(name, 'ocr_score');
        return [
          { id: 'agent_1', name: 'Primary', pluginID: 'failing-ocr', tagValue: 10 },
          { id: 'agent_2', name: 'Backup', pluginID: 'working-ocr', tagValue: 5 },
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
    agentManager: { async listTaggedAgents() { return []; } },
    pluginRegistry: { getAgentProvider() { return null; } },
  });

  await assert.rejects(() => service.run({ images: [] }), /at least one image/);
  await assert.rejects(
    () => service.run({ images: [ '/tmp/a.png' ] }),
    /No enabled OCR agents/,
  );
});

test('OcrService reports every failed attempt when all OCR agents fail', async () => {
  let service = new OcrService({
    agentManager: {
      async listTaggedAgents() {
        return [
          { id: 'agent_1', name: 'Primary', pluginID: 'failing-ocr', tagValue: 10 },
          { id: 'agent_2', name: 'Backup', pluginID: 'failing-ocr', tagValue: 5 },
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
