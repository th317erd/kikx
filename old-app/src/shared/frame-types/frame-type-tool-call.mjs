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
    let toolUseID     = content.toolUseID || content.toolUseId;
    let toolResultMap = (options && options.toolResultMap) ? options.toolResultMap : null;

    // Only include tool-calls that have a matching tool-result.
    // Orphaned tool-calls (from permission hardBreak, crashes, or errors)
    // cause API errors: "tool_use ids found without tool_result blocks."
    // But if there's no toolUseID at all, let it through (no orphan check possible).
    if (toolUseID && !toolResultMap)
      return null;

    if (toolUseID && toolResultMap && !toolResultMap.has(toolUseID))
      return null;

    return { type: 'ToolCall', content, authorType: 'agent', frameID: this._frameData.id };
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
