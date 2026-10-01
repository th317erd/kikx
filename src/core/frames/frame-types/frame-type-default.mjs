'use strict';

// =============================================================================
// FrameTypeDefault
// =============================================================================
// Fallback for unknown/unrecognized frame types. Renders a simple notice and
// contributes nothing to the model context.
// =============================================================================

import { FrameTypeBase } from './frame-type-base.mjs';

export class FrameTypeDefault extends FrameTypeBase {
  isRenderable() {
    return true;
  }
}
