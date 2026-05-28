'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';

export class FrameTypeCommandResult extends FrameTypeBase {
  isRenderable() {
    return true;
  }

  isIncludedInAgentContext() {
    return true;
  }

  toAgentMessage(_options) {
    let content = this._frameData.content || {};
    let text    = content.html || content.text || '';

    if (!text)
      return null;

    return { role: 'user', content: `[System: ${text}]`, frameID: this._frameData.id };
  }

  getAlignment() {
    return 'system';
  }

  getAuthorDisplayName(_context) {
    return 'System';
  }

  toMessage() {
    let content = this._frameData.content || {};
    return content.html || content.text || '';
  }
}
