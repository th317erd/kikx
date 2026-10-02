'use strict';

// Retry window rebuilding (P8, ruling Q3).
//
// A retry targets the SAME boundary a prior compaction used, but the strategy
// (compactor and its window) is recomputed from the CURRENT session. Frames are
// immutable history: the stored `frameIDs` still exist, so the window is rebuilt
// from the frame's own metadata rather than re-selected. This module is pure so
// the reconstruction is independently testable.

import { serializeFramesForCompaction } from './frame-context-builder.mjs';

// Rebuild a compaction window from a stored CompactionFrame's metadata.
// `frameIDs`/`startFrameID`/`boundaryFrameID`/`boundaryOrder` are mirrored on both
// `frame.compaction` and `frame.content`; the `compaction` copy wins. Returns null
// when the frame carries no usable window (e.g. nothing to compact), so callers
// can decide how to handle a degenerate retry.
export function buildRetryWindow(frame, frameEngine) {
  let metadata = readCompactionMetadata(frame);
  let storedFrameIDs = normalizeFrameIDList(metadata.frameIDs);
  let windowFrames = [];

  for (let frameID of storedFrameIDs) {
    let storedFrame = loadFrame(frameEngine, frameID);
    if (storedFrame)
      windowFrames.push(storedFrame);
  }

  // A window with no resolvable frames cannot drive compaction. Fall back to the
  // frame IDs themselves only when the engine can resolve nothing at all, so a
  // retry still targets the same boundary instead of silently compacting nothing.
  if (windowFrames.length === 0)
    return null;

  let startFrame = windowFrames[0];
  let boundaryFrame = windowFrames[windowFrames.length - 1];
  let boundaryOrder = Number.isFinite(Number(metadata.boundaryOrder))
    ? Number(metadata.boundaryOrder)
    : (boundaryFrame?.order ?? null);
  let tokens = Number.isFinite(Number(metadata.contextTokens)) ? Number(metadata.contextTokens) : 0;

  return {
    frames: windowFrames,
    startFrameID: metadata.startFrameID || startFrame.id,
    boundaryFrameID: metadata.boundaryFrameID || boundaryFrame.id,
    boundaryOrder,
    tokens,
    contextText: serializeFramesForCompaction(windowFrames),
  };
}

export function readCompactionMetadata(frame) {
  let compaction = frame?.compaction || {};
  let content = frame?.content || {};
  return {
    frameIDs: compaction.frameIDs ?? content.frameIDs ?? [],
    startFrameID: compaction.startFrameID ?? content.startFrameID ?? null,
    boundaryFrameID: compaction.boundaryFrameID ?? content.boundaryFrameID ?? null,
    boundaryOrder: compaction.boundaryOrder ?? content.boundaryOrder ?? null,
    contextTokens: compaction.contextTokens ?? content.contextTokens ?? null,
  };
}

function loadFrame(frameEngine, frameID) {
  let id = normalizeOptionalString(frameID);
  if (!id || typeof frameEngine?.get !== 'function')
    return null;

  return frameEngine.get(id) || null;
}

function normalizeFrameIDList(values) {
  if (!Array.isArray(values))
    return [];

  let output = [];
  for (let value of values) {
    let id = normalizeOptionalString(value);
    if (id && !output.includes(id))
      output.push(id);
  }

  return output;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
