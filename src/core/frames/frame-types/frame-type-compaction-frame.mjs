'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';

export class FrameTypeCompactionFrame extends FrameTypeBase {
  isRenderable() {
    return true;
  }

  getAlignment() {
    return 'system';
  }

  getAuthorDisplayName(_context) {
    return 'Kikx compaction';
  }

  toMessage() {
    let content = this._frameData.content || {};
    return content.summary || content.text || '';
  }
}
