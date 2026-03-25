'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';

export class FrameTypeToolActivity extends FrameTypeBase {
  getContentForIndexing() {
    let content = this._frameData.content || {};

    if (!content.html)
      return [];

    return [{ content_html: content.html }];
  }

  isRenderable() {
    return true;
  }

  isIncludedInAgentContext() {
    return false;
  }

  getAlignment() {
    return 'agent';
  }

  toMessage() {
    let content = this._frameData.content || {};
    return content.html || '';
  }

  // NOTE: Full createElement with renderType dispatch (file-read, file-write,
  // command-result) will be wired in Phase 4. Returns null for now.
}
