'use strict';

// =============================================================================
// FrameController — list frames, update frame content
// =============================================================================

import { ControllerAuthBase } from './controller-auth-base.mjs';

export class FrameController extends ControllerAuthBase {
  // ---------------------------------------------------------------------------
  // GET /api/v2/sessions/:sessionID/frames
  // ---------------------------------------------------------------------------

  async list({ params, query }) {
    let framePersistence = this.getFramePersistence();

    // Sanitize query string params before passing to ORM
    let options = {};
    if (query) {
      if (query.interactionID)
        options.interactionID = query.interactionID;

      if (query.afterOrder !== undefined && query.afterOrder !== '') {
        let parsed = parseInt(query.afterOrder, 10);
        if (!isNaN(parsed))
          options.afterOrder = parsed;
      }

      if (query.beforeOrder !== undefined && query.beforeOrder !== '') {
        let parsed = parseInt(query.beforeOrder, 10);
        if (!isNaN(parsed))
          options.beforeOrder = parsed;
      }

      if (query.limit !== undefined && query.limit !== '') {
        let parsed = parseInt(query.limit, 10);
        if (!isNaN(parsed) && parsed > 0)
          options.limit = parsed;
      }
    }

    let frameManager = await framePersistence.loadFrames(params.sessionID, options);
    let frames       = frameManager.toArray();

    // Strip compaction summaries from list responses (lazy-loaded via single GET)
    for (let frame of frames) {
      if (frame.type === 'compaction' && frame.content)
        frame.content = { ...frame.content, summary: null };
    }

    return { data: { frames } };
  }

  // ---------------------------------------------------------------------------
  // GET /api/v2/sessions/:sessionID/frames/:frameID
  // ---------------------------------------------------------------------------
  // Returns a single frame with full content (including compaction summary).
  // ---------------------------------------------------------------------------

  async show({ params }) {
    let { Frame } = this.getCoreModels();

    let frame = await Frame.where.id.EQ(params.frameID).first();
    if (!frame)
      this.throwNotFoundError('Frame not found');

    if (frame.sessionID !== params.sessionID)
      this.throwNotFoundError('Frame not found in this session');

    // Deserialize content if stored as JSON string
    let content = frame.content;
    if (typeof content === 'string') {
      try {
        content = JSON.parse(content);
      } catch (_e) { /* not JSON, use as-is */ }
    }

    return {
      data: {
        frame: {
          id:            frame.id,
          type:          frame.type,
          sessionID:     frame.sessionID,
          interactionID: frame.interactionID,
          authorType:    frame.authorType,
          authorID:      frame.authorID,
          content,
          order:         frame.order,
          createdAt:     frame.createdAt,
        },
      },
    };
  }

  // ---------------------------------------------------------------------------
  // PATCH /api/v2/sessions/:sessionID/frames/:frameID
  // ---------------------------------------------------------------------------
  // Updates a frame's content (e.g., persisting prompt answers).
  // Accepts { content } where content is the frame content object
  // (e.g. { html: "..." }).
  // ---------------------------------------------------------------------------

  async update({ params, body }) {
    let { content } = body || {};

    if (content === undefined)
      this.throwBadRequestError('content is required');

    let { Frame }        = this.getCoreModels();
    let framePersistence = this.getFramePersistence();

    // Look up the frame
    let frame = await Frame.where.id.EQ(params.frameID).first();
    if (!frame)
      this.throwNotFoundError('Frame not found');

    // Verify session ownership
    if (frame.sessionID !== params.sessionID)
      this.throwNotFoundError('Frame not found in this session');

    // Merge with existing content (PATCH semantics — partial update)
    let existing = {};
    if (frame.content) {
      try {
        existing = (typeof frame.content === 'string') ? JSON.parse(frame.content) : frame.content;
      } catch (_e) { /* non-JSON content, replace entirely */ }
    }

    let merged = (typeof content === 'object' && typeof existing === 'object')
      ? { ...existing, ...content }
      : content;

    // Re-sanitize HTML content before storing
    let sanitizer = this.getCore().getContext().getProperty('contentSanitizer');
    if (merged && typeof merged === 'object' && merged.html && sanitizer)
      merged.html = sanitizer.sanitize(merged.html);

    // Serialize and update
    let serialized = (typeof merged === 'string') ? merged : JSON.stringify(merged);
    frame.content  = serialized;

    await frame.save();

    return { data: { frame: { id: frame.id, content } } };
  }
}
