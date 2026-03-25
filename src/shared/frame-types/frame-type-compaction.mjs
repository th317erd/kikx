'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';

export class FrameTypeCompaction extends FrameTypeBase {
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
    return content.summary || '';
  }
}
