'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';

export class FrameTypeToolResult extends FrameTypeBase {
  getContentForIndexing() {
    let content = this._frameData.content || {};
    let result  = content.result;

    if (result == null)
      return [];

    let text = (typeof result === 'string') ? result : JSON.stringify(result);
    return [{ content_text: text }];
  }

  toAgentMessage(options) {
    let content            = this._frameData.content || {};
    let toolUseID          = content.toolUseID || content.toolUseId;
    let emittedToolResults = (options && options.emittedToolResults) ? options.emittedToolResults : null;

    // Deduplicate: skip if already emitted
    if (toolUseID && emittedToolResults && emittedToolResults.has(toolUseID))
      return null;

    if (toolUseID && emittedToolResults)
      emittedToolResults.add(toolUseID);

    return { type: 'ToolResult', content, frameID: this._frameData.id };
  }

  toMessage() {
    let content = this._frameData.content || {};
    let output  = content.output;

    if (output == null)
      return '';

    if (typeof output === 'string')
      return output;

    return JSON.stringify(output);
  }

  isRenderable() {
    return false;
  }

  isIncludedInAgentContext() {
    return true;
  }

  getToolUseID() {
    let content = this._frameData.content || {};
    return content.toolUseID || content.toolUseId || null;
  }

  getContentLength() {
    let content = this._frameData.content || {};
    let output  = content.output;

    if (output == null)
      return 0;

    if (typeof output === 'string')
      return output.length;

    return JSON.stringify(output).length;
  }
}
