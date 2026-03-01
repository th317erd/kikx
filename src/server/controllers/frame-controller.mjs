'use strict';

// =============================================================================
// FrameController — list frames for a session
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
}
