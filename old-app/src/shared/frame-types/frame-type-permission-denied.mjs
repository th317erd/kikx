'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';

export class FrameTypePermissionDenied extends FrameTypeBase {
  getContentForIndexing() {
    let content = this._frameData.content || {};
    let text    = content.message || content.reason;

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
    return content.message || content.reason || '';
  }
}
