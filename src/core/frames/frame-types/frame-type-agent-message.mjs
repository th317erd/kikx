'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';
import { escapeAttribute, normalizeAgentDisplayName } from './frame-type-helpers.mjs';

export class FrameTypeAgentMessage extends FrameTypeBase {
  buildAgentTurn(text, options = {}) {
    if (!this.authorID || this.authorID === options.currentAgentID)
      return { role: 'assistant', content: text };

    let displayName = normalizeAgentDisplayName(this._frameData);
    return {
      role: 'user',
      content: `<agent-message source="${escapeAttribute(this.authorID)}" display-name="${escapeAttribute(displayName)}">${text}</agent-message>`,
    };
  }

  isRenderable() {
    return true;
  }

  getAlignment() {
    return 'agent';
  }

  getAuthorDisplayName(_context) {
    return normalizeAgentDisplayName(this._frameData);
  }
}
