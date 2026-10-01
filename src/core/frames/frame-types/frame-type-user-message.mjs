'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';

export class FrameTypeUserMessage extends FrameTypeBase {
  buildAgentTurn(text) {
    return { role: 'user', content: text };
  }

  isRenderable() {
    return true;
  }

  getAlignment() {
    return 'user';
  }

  getAuthorDisplayName(_context) {
    return 'You';
  }
}
