'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';

export class FrameTypeToolResult extends FrameTypeBase {
  isRenderable() {
    return true;
  }

  getAlignment() {
    return 'agent';
  }

  toMessage() {
    let content = this._frameData.content || {};
    if (content.output == null)
      return '';

    if (typeof content.output === 'string')
      return content.output;

    try {
      return JSON.stringify(content.output);
    } catch (_error) {
      return '';
    }
  }

  getToolUseID() {
    let content = this._frameData.content || {};
    return content.toolUseID || content.toolUseId || null;
  }
}
