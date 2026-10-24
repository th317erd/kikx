'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';

export class FrameTypeUserMessage extends FrameTypeBase {
  buildAgentTurn(text) {
    // Replay the exact trimmed message the provider saw in the previous turn.
    // The rest of that turn's Brief B/Brief A context is intentionally not
    // persisted in history; using the same message prefix preserves KV cache.
    let captured = this.content?.modelPrompt?.messageText;
    return { role: 'user', content: typeof captured === 'string' && captured !== '' ? captured : text };
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
