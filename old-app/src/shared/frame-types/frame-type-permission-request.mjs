'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';

export class FrameTypePermissionRequest extends FrameTypeBase {
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
    return `Permission requested for "${content.toolName || ''}"`;
  }

  // NOTE: Full createElement with permissionContext, parsedCommands, decision
  // rendering will be wired in Phase 4. Returns null for now.
}
