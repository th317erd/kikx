'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';

export class FrameTypeMessage extends FrameTypeBase {
  getContentForIndexing() {
    let content = this._frameData.content || {};
    let text    = content.text || content.html;

    if (!text)
      return [];

    return [{ content_text: text }];
  }

  toAgentMessage(options) {
    let content     = this._frameData.content || {};
    let text        = content.html || content.text || '';
    let forAgentID  = (options && options.forAgentID) ? options.forAgentID : null;
    let authorID    = this._frameData.authorID;

    // Multi-agent attribution: wrap other agents' messages in XML
    if (forAgentID && authorID && authorID !== forAgentID) {
      return {
        role:    'user',
        content: `<agent-message from="${authorID}">${text}</agent-message>`,
      };
    }

    return {
      role:    'assistant',
      content: [{ type: 'text', text }],
    };
  }

  toMessage() {
    let content = this._frameData.content || {};
    return content.text || content.html || '';
  }

  isRenderable() {
    return true;
  }

  isIncludedInAgentContext() {
    return true;
  }

  getAlignment() {
    if (this._frameData.authorType === 'user')
      return 'user';

    return 'agent';
  }

  getAuthorDisplayName(context) {
    if (this._frameData.authorType === 'user')
      return 'You';

    let authorID = this._frameData.authorID;

    if (authorID && context && context.agents) {
      let agent = context.agents.get
        ? context.agents.get(authorID)
        : context.agents[authorID];

      if (agent && agent.name)
        return agent.name;
    }

    return 'Agent';
  }

  showReplyButton() {
    return true;
  }

  getContentLength() {
    let content = this._frameData.content || {};
    return (content.html || content.text || '').length;
  }
}
