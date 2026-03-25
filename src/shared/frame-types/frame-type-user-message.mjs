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

  toAgentMessage(_options) {
    let content = this._frameData.content || {};
    return { role: 'user', content: content.html || content.text || '', frameID: this._frameData.id };
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
