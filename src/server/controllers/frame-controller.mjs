'use strict';

// =============================================================================
// FrameController — list frames, update frame content
// =============================================================================

import { ControllerAuthBase } from './controller-auth-base.mjs';

export class FrameController extends ControllerAuthBase {
  // ---------------------------------------------------------------------------
  // GET /api/v2/sessions/:sessionId/frames
  // ---------------------------------------------------------------------------

  async list({ params, query }) {
    let framePersistence = this.getFramePersistence();
    let frameManager     = await framePersistence.loadFrames(params.sessionId, query || {});
    let frames           = frameManager.toArray();

    return { data: { frames } };
  }

  // ---------------------------------------------------------------------------
  // PATCH /api/v2/sessions/:sessionId/frames/:frameId
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
    let frame = await Frame.where.id.EQ(params.frameId).first();
    if (!frame)
      this.throwNotFoundError('Frame not found');

    // Verify session ownership
    if (frame.sessionID !== params.sessionId)
      this.throwNotFoundError('Frame not found in this session');

    // Re-sanitize HTML content before storing
    let sanitizer = this.getCore().getContext().getProperty('contentSanitizer');
    if (content && typeof content === 'object' && content.html && sanitizer)
      content.html = sanitizer.sanitize(content.html);

    // Serialize and update
    let serialized = (typeof content === 'string') ? content : JSON.stringify(content);
    frame.content  = serialized;

    await frame.save();

    return { data: { frame: { id: frame.id, content } } };
  }
}
