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
    return false;
  }

  getAlignment() {
    return 'system';
  }

  toMessage() {
    let content = this._frameData.content || {};
    return content.message || content.error || content.text || '';
  }
}
