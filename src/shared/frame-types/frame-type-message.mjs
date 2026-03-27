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
    let html        = content.html || '';
    let forAgentID  = (options && options.forAgentID) ? options.forAgentID : null;
    let authorID    = this._frameData.authorID;

    // Multi-agent attribution: wrap other agents' messages in XML
    if (forAgentID && authorID && authorID !== forAgentID) {
      let agentName = this._resolveAgentName(authorID, options);
      let wrapped   = `<agent-message source="${authorID}" name="${agentName}">\nFrom ${agentName}:\n\n${html}</agent-message>`;
      return { role: 'user', content: wrapped, frameID: this._frameData.id, sourceAgentID: authorID };
    }

    return { role: 'assistant', content: html, frameID: this._frameData.id };
  }

  _resolveAgentName(agentID, options) {
    if (!agentID)
      return 'Agent';

    let agents = options && options.agents;
    if (!agents)
      return agentID;

    let agent = agents.get ? agents.get(agentID) : agents[agentID];
    return (agent && agent.name) ? agent.name : agentID;
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
