'use strict';

import { FrameTypeBase } from './frame-type-base.mjs';

export class FrameTypeUserMessage extends FrameTypeBase {
  getContentForIndexing() {
    let content = this._frameData.content || {};
    let text    = content.text || content.html;

    if (!text)
      return [];

    return [{ content_text: text }];
  }

  toAgentMessage(options) {
    let content  = this._frameData.content || {};
    let text     = content.html || content.text || '';

    // Prefix with user name so the agent knows who said what
    let authorID = this._frameData.authorID;
    let name     = this._resolveUserName(authorID, options);
    if (name)
      text = `From ${name}:\n\n${text}`;

    return { role: 'user', content: text, frameID: this._frameData.id };
  }

  _resolveUserName(userID, options) {
    if (!userID)
      return null;

    let agents = options && options.agents;
    if (!agents)
      return null;

    // Check users map (if provided)
    let users = options.users;
    if (users) {
      let user = users.get ? users.get(userID) : users[userID];
      if (user && user.name)
        return user.name;
    }

    return null;
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
    return 'user';
  }

  getAuthorDisplayName(_context) {
    return 'You';
  }

  showReplyButton() {
    return false;
  }

  getContentLength() {
    let content = this._frameData.content || {};
    return (content.html || content.text || '').length;
  }
}
