'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';

export class FrameTypeHookBlocked extends FrameTypeBase {
  getContentForIndexing() {
    let content = this._frameData.content || {};
    let text    = content.text || content.message;

    if (!text)
      return [];

    return [{ content_text: text }];
  }

  isRenderable() {
    return false;
  }

  isIncludedInAgentContext() {
    return false;
  }

  toMessage() {
    let content = this._frameData.content || {};
    return content.text || content.message || '';
  }
}
