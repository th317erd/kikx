'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';

export class FrameTypeError extends FrameTypeBase {
  getContentForIndexing() {
    let content = this._frameData.content || {};
    let text    = content.message || content.error || content.text;

    if (!text)
      return [];

    return [{ content_text: text }];
  }

  isRenderable() {
    return true;
  }

  isIncludedInAgentContext() {
    return true;
  }

  toAgentMessage(_options) {
    let content = this._frameData.content || {};
    let message = content.message || content.error || content.text || 'Unknown error';

    return { role: 'user', content: `[System Error: ${message}]`, frameID: this._frameData.id };
  }

  getAlignment() {
    return 'system';
  }

  toMessage() {
    let content = this._frameData.content || {};
    return content.message || content.error || content.text || '';
  }
}
