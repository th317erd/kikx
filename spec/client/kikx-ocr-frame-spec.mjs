'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);
const { registry: customElements } = installDom();
globalThis.fetch = async () => {
  throw new Error('offline');
};

await import('../../src/client/components/kikx-ocr-frame.mjs');

test('OcrFrame renders the question above the image and the response below', () => {
  let OcrFrame = customElements.get('kikx-ocr-frame');
  assert.ok(OcrFrame, 'expected kikx-ocr-frame to be registered');

  let frame = {
    id: 'ocr_1',
    type: 'OcrFrame',
    sessionID: 'ses_1',
    authorDisplayName: 'Zav',
    content: {
      toolName: 'ocr',
      phase: 'result',
      status: 'success',
      input: {
        images: [ '/tmp/screenshot.png' ],
        prompt: 'What does this label say?',
      },
      result: {
        text: 'The label says hello.',
        agentName: 'Host OCR',
      },
    },
  };
  let element = new OcrFrame();
  element.updateFrame(frame, {});

  assert.match(element.textContent, /Question from Zav/);
  assert.match(element.textContent, /What does this label say\?/);
  assert.match(element.textContent, /\/tmp\/screenshot\.png/);
  assert.match(element.textContent, /The label says hello\./);
  assert.match(element.textContent, /OCR response from Host OCR/);
  assert.equal(element.querySelector('img')?.src?.startsWith('data:image/svg+xml'), true);
});
