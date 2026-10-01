'use strict';

// =============================================================================
// createTypedFrame — factory for typed frame instances
// =============================================================================
// Given raw frame data, returns a FrameType* instance carrying behavior methods.
//
// Resolution order:
//   1. registry.getClass('FrameType' + frame.type) — lets a plugin override
//   2. the internal FRAME_TYPE_CLASSES map
//   3. FrameTypeDefault (safe unknown-frame behavior)
//
// No registry is required; the factory works standalone with the static map.
// =============================================================================

import { FrameTypeDefault } from './frame-type-default.mjs';
import { FRAME_TYPE_CLASSES } from './frame-type-classes.mjs';

// Resolve the class for a frame type, preferring a registry override.
export function frameTypeClass(type, registry = null) {
  if (!type)
    return FrameTypeDefault;

  if (registry && typeof registry.getClass === 'function') {
    let resolved = registry.getClass(`FrameType${type}`);
    if (resolved)
      return resolved;
  }

  return FRAME_TYPE_CLASSES[type] || FrameTypeDefault;
}

export function createTypedFrame(frameData, context = null) {
  let registry = context?.registry || null;
  let TypeClass = frameTypeClass(frameData?.type, registry);
  return new TypeClass(frameData || {}, context || {});
}
