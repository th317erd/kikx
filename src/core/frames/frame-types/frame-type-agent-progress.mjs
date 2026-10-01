'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';

export class FrameTypeAgentProgress extends FrameTypeBase {
  isRenderable() {
    return true;
  }

  getAlignment() {
    return 'agent';
  }

  toMessage() {
    let content = this._frameData.content || {};
    return content.text || '';
  }
}
