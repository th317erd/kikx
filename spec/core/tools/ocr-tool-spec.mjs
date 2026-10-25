'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { OcrTool } from '../../../src/core/tools/index.mjs';

test('OcrTool delegates to ocrService with the image paths', async () => {
  let request = null;
  let tool = new OcrTool({
    services: {
      ocrService: {
        async run(input) {
          request = input;
          return { text: 'recognized', agentID: 'agent_1' };
        },
      },
    },
  });

  let result = await tool.execute({ images: [ '/tmp/a.png' ], prompt: 'Read it' });
  assert.equal(result.text, 'recognized');
  assert.deepEqual(request.images, [ '/tmp/a.png' ]);
  assert.equal(request.prompt, 'Read it');
});

test('OcrTool requires an ocrService', async () => {
  await assert.rejects(
    () => new OcrTool().execute({ images: [ '/tmp/a.png' ] }),
    /ocr requires an ocrService/,
  );
});
