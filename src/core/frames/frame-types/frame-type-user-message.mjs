'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';

const COMPACTION_PROMPT_PREFIX = 'This is the context memory of another Kikx agent.';

export class FrameTypeUserMessage extends FrameTypeBase {
  buildAgentTurn(text) {
    // Replay the exact trimmed message the provider saw in the previous turn.
    // The rest of that turn's Brief B/Brief A context is intentionally not
    // persisted in history; using the same message prefix preserves KV cache.
    let captured = this.content?.modelPrompt?.messageText;
    // Defensive read for historical sessions: a compaction prompt was once
    // captured against the last user message. It is not conversation history and
    // must never be replayed as the user's turn.
    if (typeof captured === 'string' && captured.startsWith(COMPACTION_PROMPT_PREFIX))
      captured = '';
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
