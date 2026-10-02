'use strict';

// =============================================================================
// FrameTypeBase
// =============================================================================
// Base class for all frame type classes. A frame type class wraps a raw frame
// record ("data") plus an optional context and defines the behavior that other
// engine layers need: how the frame projects into a model turn, how it renders,
// how it aligns, and how it summarizes to text.
//
// Constructor takes (frameData, context):
//   frameData — the raw frame object
//   context   — optional context ({ registry, session, ... }) used by overrides
//
// Subclasses override the behavior methods below. Keep them small: override only
// what differs from these safe defaults.
// =============================================================================

import { isCompactionFrame } from './frame-type-helpers.mjs';

const FRAME_PROPERTIES = [
  'id',
  'type',
  'sessionID',
  'interactionID',
  'parentID',
  'order',
  'commitOrder',
  'groupID',
  'groupType',
  'content',
  'targets',
  'recipients',
  'authorType',
  'authorID',
  'authorDisplayName',
  'hidden',
  'deleted',
  'phantom',
  'timestamp',
  'createdAt',
  'updatedAt',
  'createdClock',
  'updatedClock',
  'state',
  'compaction',
  'responseFrameID',
  'mentions',
];

export class FrameTypeBase {
  constructor(frameData, context) {
    this._frameData = frameData || {};
    this._context = context || {};
  }

  // ---------------------------------------------------------------------------
  // Property getters — delegate to the raw frame data
  // ---------------------------------------------------------------------------

  get id() { return this._frameData.id; }
  get type() { return this._frameData.type; }
  get sessionID() { return this._frameData.sessionID; }
  get interactionID() { return this._frameData.interactionID; }
  get parentID() { return this._frameData.parentID; }
  get order() { return this._frameData.order; }
  get commitOrder() { return this._frameData.commitOrder; }
  get groupID() { return this._frameData.groupID; }
  get groupType() { return this._frameData.groupType; }
  get content() { return this._frameData.content; }
  get targets() { return this._frameData.targets; }
  get recipients() { return this._frameData.recipients; }
  get authorType() { return this._frameData.authorType; }
  get authorID() { return this._frameData.authorID; }
  get authorDisplayName() { return this._frameData.authorDisplayName; }
  get hidden() { return this._frameData.hidden; }
  get deleted() { return this._frameData.deleted; }
  get phantom() { return this._frameData.phantom; }
  get timestamp() { return this._frameData.timestamp; }
  get createdAt() { return this._frameData.createdAt; }
  get updatedAt() { return this._frameData.updatedAt; }
  get createdClock() { return this._frameData.createdClock; }
  get updatedClock() { return this._frameData.updatedClock; }
  get state() { return this._frameData.state; }
  get compaction() { return this._frameData.compaction; }
  get responseFrameID() { return this._frameData.responseFrameID; }
  get mentions() { return this._frameData.mentions; }

  // The primary text a frame contributes to model context. Matches the prior
  // `content?.text || content?.html || ''` projection exactly.
  get text() {
    let content = this._frameData.content;
    if (content == null)
      return '';

    return content.text || content.html || '';
  }

  // ---------------------------------------------------------------------------
  // Behavior — override points
  // ---------------------------------------------------------------------------

  // Map this frame to a neutral model turn `{ role, content }`, or null when the
  // frame does not belong in the model context. The compaction case is handled
  // before the hidden guard on purpose: compaction frames are hidden from the UI
  // but are the model's only memory of the turns they replaced.
  toAgentMessage(options = {}) {
    if (this.deleted)
      return null;

    if (this._isCompactionFrame())
      return this._compactionTurn();

    if (this.hidden)
      return null;

    let text = this.text;
    if (typeof text !== 'string' || text.trim() === '')
      return null;

    return this.buildAgentTurn(text, options);
  }

  // Type-specific mapping from extracted text to a model turn. Base returns null
  // so an unknown type contributes nothing.
  buildAgentTurn(_text, _options) {
    return null;
  }

  getAlignment() {
    let authorType = this._frameData.authorType;
    if (authorType === 'user' || authorType === 'agent' || authorType === 'system')
      return authorType;

    return null;
  }

  getAuthorDisplayName(_context) {
    return 'System';
  }

  isRenderable() {
    return false;
  }

  isHidden() {
    return this._frameData.hidden === true || this._frameData.deleted === true;
  }

  // Human-readable summary for compaction/display. Mirrors the prior
  // extractFrameText() fallback chain.
  toMessage() {
    let content = this._frameData.content;
    if (content == null)
      return '';

    if (typeof content === 'string')
      return content;

    if (typeof content.text === 'string')
      return content.text;

    if (typeof content.summary === 'string')
      return content.summary;

    if (typeof content.output === 'string')
      return content.output;

    try {
      return JSON.stringify(content);
    } catch (_error) {
      return '';
    }
  }

  _isCompactionFrame() {
    return isCompactionFrame(this._frameData);
  }

  _compactionTurn() {
    let content = this._frameData.content || {};
    let summary = content.summary || content.text || '';
    if (typeof summary !== 'string' || summary.trim() === '')
      return null;

    // The summary is priority-tagged ([high]/[medium]/[low]) so a small model
    // knows what it may drop. Tell it how to treat the tags on re-projection.
    return {
      role: 'user',
      content: `[Compacted context memory — earlier turns summarized]\n`
        + `Sections are priority-tagged: [high] is must-keep, [medium] is useful context, [low] is droppable if space is tight. Never drop [high].\n${summary}`,
    };
  }
}

export { FRAME_PROPERTIES };
