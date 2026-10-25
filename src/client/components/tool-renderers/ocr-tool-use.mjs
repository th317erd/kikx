'use strict';

import { ToolUse } from './tool-use-base.mjs';

export class OcrToolUse extends ToolUse {
  static toolName = 'ocr';

  displayName() {
    return 'OCR';
  }

  callSummary() {
    let count = Array.isArray(this.input.images) ? this.input.images.length : 0;
    return count > 0 ? `Running OCR on ${count} image${count === 1 ? '' : 's'}...` : 'Running OCR...';
  }

  resultSummary() {
    if (this.status === 'error')
      return 'OCR failed.';

    let result = this.content.result;
    return result?.agentName ? `OCR completed by ${result.agentName}.` : 'OCR completed.';
  }

  renderOutput(output) {
    let text = output?.content || '';
    try {
      let parsed = JSON.parse(text);
      text = parsed?.text ?? parsed?.result?.text ?? text;
    } catch (_error) {}
    return this.renderPlainOutput(text, output);
  }
}
