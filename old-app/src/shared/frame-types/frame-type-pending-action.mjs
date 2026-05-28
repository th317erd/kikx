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
    let toolUseID     = content.toolUseID || content.toolUseId;
    let toolResultMap = (options && options.toolResultMap) ? options.toolResultMap : null;

    // Only include pending-actions that were approved (have a matching tool-result)
    if (!toolUseID || !toolResultMap || !toolResultMap.has(toolUseID))
      return null;

    // Strip internal fields (e.g. _parsedCommands) from arguments
    let cleanContent = content;
    if (content.arguments && content.arguments._parsedCommands) {
      let { _parsedCommands, ...cleanArgs } = content.arguments;
      cleanContent = { ...content, arguments: cleanArgs };
    }

    return { type: 'ToolCall', content: cleanContent, authorType: 'agent', frameID: this._frameData.id };
  }

  /**
   * After emitting the tool-call, immediately emit the matching tool-result
   * to keep the pair adjacent. Returns a ToolResult message or null.
   * @param {Object} options - { toolResultMap, emittedToolResults, toolResultFrames }
   * @returns {Object|null}
   */
  emitAdjacentToolResult(options) {
    let content            = this._frameData.content || {};
    let toolUseID          = content.toolUseID || content.toolUseId;
    let toolResultFrames   = (options && options.toolResultFrames) ? options.toolResultFrames : null;
    let emittedToolResults = (options && options.emittedToolResults) ? options.emittedToolResults : null;

    if (!toolUseID || !toolResultFrames)
      return null;

    let resultFrame = toolResultFrames.get(toolUseID);
    if (!resultFrame)
      return null;

    if (emittedToolResults && emittedToolResults.has(toolUseID))
      return null;

    if (emittedToolResults)
      emittedToolResults.add(toolUseID);

    return { type: 'ToolResult', content: resultFrame.content || {}, frameID: resultFrame.id };
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
