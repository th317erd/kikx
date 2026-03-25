'use strict';

// =============================================================================
// createTypedFrame — factory function for typed frame instances
// =============================================================================
// Given raw frame data, returns a FrameType* instance with behavior methods.
//
// Lookup:  registry.getClass('FrameType' + frame.type)
// Fallback: FrameTypeDefault (renders "unsupported" on client)
// No registry: uses FRAME_TYPE_CLASSES map directly
// =============================================================================

import { FrameTypeDefault }    from './frame-type-default.mjs';
import { FRAME_TYPE_CLASSES }  from './index.mjs';

export function createTypedFrame(frameData, context) {
  if (!frameData || !frameData.type)
    return new FrameTypeDefault(frameData || {}, context);

  let FrameTypeClass = null;
  let registry       = context && context.registry;

  // Prefer registry lookup (allows plugin overrides)
  if (registry && typeof registry.getClass === 'function') {
    let key = `FrameType${frameData.type}`;

    if (registry.hasClass(key))
      FrameTypeClass = registry.getClass(key);
  }

  // Fallback to static map
  if (!FrameTypeClass)
    FrameTypeClass = FRAME_TYPE_CLASSES[frameData.type];

  // Ultimate fallback
  if (!FrameTypeClass)
    FrameTypeClass = FrameTypeDefault;

  return new FrameTypeClass(frameData, context);
}
