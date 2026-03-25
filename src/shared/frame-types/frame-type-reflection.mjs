'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';

export class FrameTypeReflection extends FrameTypeBase {
  getContentForIndexing() {
    let content = this._frameData.content || {};
    let text    = content.text || content.html;

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
    return 'agent';
  }

  toMessage() {
    let content = this._frameData.content || {};
    return content.text || '';
  }
}
