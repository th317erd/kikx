'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';

export class FrameTypeSystemError extends FrameTypeBase {
  isRenderable() {
    return false;
  }

  isIncludedInAgentContext() {
    return false;
  }

  toMessage() {
    let content = this._frameData.content || {};
    return content.message || content.text || '';
  }
}
