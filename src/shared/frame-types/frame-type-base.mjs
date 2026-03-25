'use strict';

// =============================================================================
// FrameTypeBase
// =============================================================================
// Base class for all frame type classes. Frame types are like React components —
// frame data is "props/state", the class defines behavior.
//
// Constructor takes (frameData, context):
//   frameData — the raw frame object (22 properties)
//   context   — optional context object (registry, session info, etc.)
//
// Subclasses override the behavior methods below.
// =============================================================================

const FRAME_PROPERTIES = [
  'id',
  'type',
  'targets',
  'phantom',
  'content',
  'parentID',
  'groupID',
  'groupType',
  'order',
  'timestamp',
  'hidden',
  'deleted',
  'updatedAt',
  'createdAt',
  'authorType',
  'authorID',
  'processed',
  'processedAt',
  'state',
  'signature',
  'signingKeyFingerprint',
  'interactionID',
];

export class FrameTypeBase {
  constructor(frameData, context) {
    this._frameData = frameData || {};
    this._context   = context || {};
  }

  // ---------------------------------------------------------------------------
  // Property getters — delegate to this._frameData
  // ---------------------------------------------------------------------------

  get id()                    { return this._frameData.id; }
  get type()                  { return this._frameData.type; }
  get targets()               { return this._frameData.targets; }
  get phantom()               { return this._frameData.phantom; }
  get content()               { return this._frameData.content; }
  get parentID()              { return this._frameData.parentID; }
  get groupID()               { return this._frameData.groupID; }
  get groupType()             { return this._frameData.groupType; }
  get order()                 { return this._frameData.order; }
  get timestamp()             { return this._frameData.timestamp; }
  get hidden()                { return this._frameData.hidden; }
  get deleted()               { return this._frameData.deleted; }
  get updatedAt()             { return this._frameData.updatedAt; }
  get createdAt()             { return this._frameData.createdAt; }
  get authorType()            { return this._frameData.authorType; }
  get authorID()              { return this._frameData.authorID; }
  get processed()             { return this._frameData.processed; }
  get processedAt()           { return this._frameData.processedAt; }
  get state()                 { return this._frameData.state; }
  get signature()             { return this._frameData.signature; }
  get signingKeyFingerprint() { return this._frameData.signingKeyFingerprint; }
  get interactionID()         { return this._frameData.interactionID; }

  // ---------------------------------------------------------------------------
  // Override point methods
  // ---------------------------------------------------------------------------

  /**
   * Returns content entries for Solr indexing.
   * @returns {Array<{ content_text?: string, content_html?: string }>}
   */
  getContentForIndexing() {
    let content = this._frameData.content;

    if (content == null)
      return [];

    try {
      let stringified = JSON.stringify(content);
      if (stringified === '{}')
        return [];

      return [{ content_text: stringified }];
    } catch (_error) {
      return [];
    }
  }

  /**
   * Returns an object for the LLM API message array, or null if excluded.
   * @param {Object} [options] - { forAgentID, toolResultMap, emittedToolResults }
   * @returns {Object|null}
   */
  toAgentMessage(_options) {
    return null;
  }

  /**
   * Returns human-readable string for compaction summarization.
   * @returns {string}
   */
  toMessage() {
    let content = this._frameData.content || {};

    if (typeof content === 'string')
      return content;

    if (content.text)
      return content.text;

    if (content.html)
      return content.html;

    try {
      return JSON.stringify(content);
    } catch (_error) {
      return '';
    }
  }

  /**
   * Should this type show in the client UI?
   * @returns {boolean}
   */
  isRenderable() {
    return false;
  }

  /**
   * Creates a DOM element for client rendering.
   * @param {Object} helpers - { document, createInteraction, createMessageContent }
   * @returns {Element|null}
   */
  createElement(_helpers) {
    return null;
  }

  /**
   * Returns alignment: 'user', 'agent', or 'system'.
   * @returns {string}
   */
  getAlignment() {
    let authorType = this._frameData.authorType;

    if (authorType === 'user')
      return 'user';

    if (authorType === 'agent')
      return 'agent';

    return 'system';
  }

  /**
   * Returns display name string.
   * @param {Object} [context]
   * @returns {string}
   */
  getAuthorDisplayName(_context) {
    return 'System';
  }

  /**
   * Should reply button show?
   * @returns {boolean}
   */
  showReplyButton() {
    return false;
  }

  /**
   * Should this type be included in buildMessages()?
   * @returns {boolean}
   */
  isIncludedInAgentContext() {
    return false;
  }

  /**
   * Returns estimated token/char length for truncation budgeting.
   * @returns {number}
   */
  getContentLength() {
    return 0;
  }

  /**
   * Returns toolUseID if this frame type has one.
   * @returns {string|null}
   */
  getToolUseID() {
    return null;
  }
}

export { FRAME_PROPERTIES };
