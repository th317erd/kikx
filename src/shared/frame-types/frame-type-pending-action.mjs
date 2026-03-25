'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';

export class FrameTypePendingAction extends FrameTypeBase {
  isRenderable() {
    return false;
  }

  isIncludedInAgentContext() {
    return true;
  }

  toAgentMessage(options) {
    let content       = this._frameData.content || {};
    let toolUseID     = content.toolUseId || content.toolUseID;
    let toolResultMap = (options && options.toolResultMap) ? options.toolResultMap : null;

    // Only include pending-actions that were approved (have a matching tool-result)
    if (!toolUseID || !toolResultMap || !toolResultMap.has(toolUseID))
      return null;

    // Strip internal fields (e.g. _parsedCommands) from arguments
    let args = content.arguments || {};
    if (args._parsedCommands) {
      let { _parsedCommands, ...cleanArgs } = args;
      args = cleanArgs;
    }

    return {
      role:    'assistant',
      content: [{
        type:  'tool_use',
        id:    toolUseID,
        name:  content.toolName,
        input: args,
      }],
    };
  }

  getToolUseID() {
    let content = this._frameData.content || {};
    return content.toolUseId || content.toolUseID || null;
  }

  toMessage() {
    let content = this._frameData.content || {};
    return `[pending: ${content.toolName || ''}]`;
  }
}
