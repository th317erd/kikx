'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';

export class FrameTypeToolCall extends FrameTypeBase {
  getContentForIndexing() {
    let content  = this._frameData.content || {};
    let toolName = content.toolName || '';
    let args     = content.arguments || {};

    return [{ content_text: `${toolName}: ${JSON.stringify(args)}` }];
  }

  toAgentMessage(options) {
    let content       = this._frameData.content || {};
    let toolUseID     = content.toolUseId || content.toolUseID;
    let toolResultMap = (options && options.toolResultMap) ? options.toolResultMap : null;

    // Only include tool-calls that have a matching tool-result.
    // Orphaned tool-calls cause API errors.
    if (!toolUseID || !toolResultMap || !toolResultMap.has(toolUseID))
      return null;

    return {
      role:    'assistant',
      content: [{
        type:  'tool_use',
        id:    toolUseID,
        name:  content.toolName,
        input: content.arguments || {},
      }],
    };
  }

  toMessage() {
    let content = this._frameData.content || {};
    return `[tool-call: ${content.toolName || ''}]`;
  }

  isRenderable() {
    return false;
  }

  isIncludedInAgentContext() {
    return true;
  }

  getAlignment() {
    return 'agent';
  }

  getToolUseID() {
    let content = this._frameData.content || {};
    return content.toolUseId || content.toolUseID || null;
  }
}
