'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';

export class FrameTypeToolCall extends FrameTypeBase {
  isRenderable() {
    return true;
  }

  getAlignment() {
    return 'agent';
  }

  toMessage() {
    let content = this._frameData.content || {};
    return `[tool-call: ${content.toolName || ''}]`;
  }

  getToolUseID() {
    let content = this._frameData.content || {};
    return content.toolUseID || content.toolUseId || null;
  }
}
