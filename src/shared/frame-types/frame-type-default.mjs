'use strict';

// =============================================================================
// FrameTypeDefault
// =============================================================================
// Used for unknown/unrecognized frame types. Renders a simple notice.
// =============================================================================

import { FrameTypeBase } from './frame-type-base.mjs';

export class FrameTypeDefault extends FrameTypeBase {
  isRenderable() {
    return true;
  }

  createElement(helpers) {
    if (!helpers || !helpers.document)
      return null;

    let element     = helpers.document.createElement('div');
    element.className = 'frame-type-unsupported';
    element.textContent = 'This frame type is not supported in this version.';

    return element;
  }
}
