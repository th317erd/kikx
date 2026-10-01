'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';

export class FrameTypeCommandResult extends FrameTypeBase {
  buildAgentTurn(text) {
    return { role: 'user', content: `[System command result]\n${text}` };
  }

  isRenderable() {
    return true;
  }

  getAlignment() {
    return 'system';
  }

  getAuthorDisplayName(_context) {
    return 'System';
  }
}
