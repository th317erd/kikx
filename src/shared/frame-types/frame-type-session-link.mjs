'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';

export class FrameTypeSessionLink extends FrameTypeBase {
  isRenderable() {
    return true;
  }

  isIncludedInAgentContext() {
    return false;
  }

  getAlignment() {
    return 'system';
  }

  getAuthorDisplayName(_context) {
    return 'System';
  }

  toMessage() {
    let content = this._frameData.content || {};
    return `Session link: ${content.title || content.targetSessionID || ''}`;
  }
}
