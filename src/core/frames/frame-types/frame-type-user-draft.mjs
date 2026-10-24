'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';

// Drafts are durable but never part of the visible thread or model context.
// The base class already rejects hidden frames in `toAgentMessage()`.
export class FrameTypeUserDraft extends FrameTypeBase {
  isRenderable() {
    return false;
  }

  getAlignment() {
    return 'user';
  }

  getAuthorDisplayName(_context) {
    return 'You';
  }
}
