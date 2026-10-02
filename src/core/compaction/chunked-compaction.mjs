'use strict';

// Overflow fallback for compaction (P4, ruling R4).
//
// The serialized compaction input must fit the SELECTED compactor's real
// window. When it does not, compact in pieces rather than failing:
//
//   1. split the frames oldest-first into chunks that each fit the budget,
//   2. compact each chunk,
//   3. recursively compact the chunk summaries together until they fit.
//
// A single frame too large even for an empty budget is truncated in place with
// an explicit `[truncated: N characters omitted]` marker (never dropped). If the
// recursion cannot converge (depth guard), the oldest frames are trimmed as the
// final resort. This module is pure aside from `runChunkedCompaction` calling the
// injected `compactOnce`, which keeps the policy testable without a provider.

import {
  estimateTokens as defaultEstimateTokens,
  serializeFrameForContext,
  serializeFramesForCompaction,
} from './frame-context-builder.mjs';

export const MAX_CHUNK_DEPTH = 4;
export const DEFAULT_CHARS_PER_TOKEN = 4;
export const TRUNCATED_FRAME_TYPE = 'TruncatedFrame';
const CHUNK_SEPARATOR = '\n\n---\n\n';

// Split frames oldest-first into groups whose serialized size fits `budgetTokens`.
// Greedy: keep adding frames until the next would exceed the budget. A frame that
// alone exceeds the budget becomes its own `{ oversized: true }` chunk.
export function planCompactionChunks({ frames, budgetTokens, estimateTokens } = {}) {
  let list = normalizeFrames(frames);
  let estimate = resolveEstimator(estimateTokens);
  let budget = normalizePositiveInteger(budgetTokens, 1);
  let separatorTokens = estimate(CHUNK_SEPARATOR);
  let chunks = [];
  let current = null;
  let currentTokens = 0;

  for (let frame of list) {
    let frameTokens = estimate(serializeFrameForContext(frame));

    if (frameTokens > budget) {
      if (current) {
        chunks.push(current);
        current = null;
        currentTokens = 0;
      }

      chunks.push({ frames: [ frame ], oversized: true });
      continue;
    }

    let added = current ? frameTokens + separatorTokens : frameTokens;
    if (current && currentTokens + added > budget) {
      chunks.push(current);
      current = null;
      currentTokens = 0;
      added = frameTokens;
    }

    if (!current)
      current = { frames: [], oversized: false };

    current.frames.push(frame);
    currentTokens += added;
  }

  if (current)
    chunks.push(current);

  return chunks;
}

// Last resort: drop the OLDEST frames until the rest fits, truncating a lone
// remaining oversized frame rather than dropping it. A short marker frame is
// prepended when material was dropped so the loss is visible in the compacted
// input. Returns `{ frames, droppedCount, truncated }`.
export function trimOldestToFit({ frames, budgetTokens, estimateTokens } = {}) {
  let list = normalizeFrames(frames);
  let estimate = resolveEstimator(estimateTokens);
  let budget = normalizePositiveInteger(budgetTokens, 1);
  let working = list.slice();
  let droppedCount = 0;
  let truncated = false;

  // First, drop the oldest frames until the frames alone fit.
  while (working.length > 1 && estimate(serializeFramesForCompaction(working)) > budget) {
    working.shift();
    droppedCount++;
  }

  if (working.length === 1 && estimate(serializeFramesForCompaction(working)) > budget) {
    working = [ truncateFrameToBudget(working[0], budget, estimate) ];
    truncated = true;
  }

  // Then make room for a visible marker by dropping further oldest frames. Only
  // give up on the marker when a single frame (already truncated) is all that
  // remains.
  if (droppedCount > 0 && !truncated) {
    while (estimate(serializeFramesForCompaction(withMarker(working, droppedCount))) > budget && working.length > 1) {
      working.shift();
      droppedCount++;
    }

    if (estimate(serializeFramesForCompaction(withMarker(working, droppedCount))) <= budget) {
      working = withMarker(working, droppedCount);
    } else if (working.length === 1) {
      working = [ truncateFrameToBudget(working[0], budget, estimate) ];
      truncated = true;
    }
  }

  if (working.length === 0)
    working = [ createMarkerFrame('[trimmed: older frames omitted to fit the compactor window]') ];

  return { frames: working, droppedCount, truncated };
}

function withMarker(frames, droppedCount) {
  return [
    createMarkerFrame(`[trimmed: ${droppedCount} older frame(s) omitted to fit the compactor window]`),
    ...frames,
  ];
}

// Compact `frames` within `budgetTokens`. The common case (everything fits) is a
// single `compactOnce` call. Otherwise each chunk is compacted, and the summaries
// are recursively reduced together. `depth`/`maxDepth` bound the recursion; on
// exhaustion the oldest material is trimmed and compacted once more.
export async function runChunkedCompaction({
  frames,
  budgetTokens,
  estimateTokens,
  compactOnce,
  depth = 0,
  maxDepth = MAX_CHUNK_DEPTH,
} = {}) {
  let list = normalizeFrames(frames);
  if (list.length === 0)
    return '';

  if (typeof compactOnce !== 'function')
    throw new TypeError('runChunkedCompaction requires a compactOnce function');

  let estimate = resolveEstimator(estimateTokens);
  let budget = normalizePositiveInteger(budgetTokens, 1);
  let limit = normalizePositiveInteger(maxDepth, MAX_CHUNK_DEPTH);
  let currentDepth = normalizeNonNegativeInteger(depth, 0);

  let chunks = planCompactionChunks({ frames: list, budgetTokens: budget, estimateTokens: estimate });

  // Common case: one call, same prompt shape as the pre-chunking path.
  if (chunks.length === 1 && chunks[0].oversized === false)
    return await compactOnce(list);

  if (currentDepth >= limit) {
    let trimmed = trimOldestToFit({ frames: list, budgetTokens: budget, estimateTokens: estimate });
    return await compactOnce(trimmed.frames);
  }

  let summaries = [];
  for (let chunk of chunks) {
    let group = chunk.oversized
      ? [ truncateFrameToBudget(chunk.frames[0], budget, estimate) ]
      : chunk.frames;
    let summary = await compactOnce(group);
    if (typeof summary === 'string' && summary.trim() !== '')
      summaries.push(summary);
  }

  if (summaries.length === 0)
    return '';

  if (summaries.length === 1)
    return summaries[0];

  let summaryFrames = summaries.map((text, index) => createSummaryFrame(text, index));
  return await runChunkedCompaction({
    frames: summaryFrames,
    budgetTokens: budget,
    estimateTokens: estimate,
    compactOnce,
    depth: currentDepth + 1,
    maxDepth: limit,
  });
}

// Truncate one frame's serialized text to the budget, keeping an explicit marker
// that counts the omitted characters. Returns a synthetic frame so the original
// type-specific serialization (for example a compaction summary) cannot bypass
// the truncation.
function truncateFrameToBudget(frame, budgetTokens, estimate) {
  let serialized = serializeFrameForContext(frame);
  if (estimate(serialized) <= budgetTokens)
    return frame;

  // `estimate` returns ceil(length / charsPerToken), so fitting the budget means
  // the serialized length must be at most `budget * charsPerToken`.
  let maxChars = Math.max(0, budgetTokens * DEFAULT_CHARS_PER_TOKEN);
  let header = serializeFrameForContext({
    id: frame.id,
    type: TRUNCATED_FRAME_TYPE,
    content: { text: '' },
  });
  let omitted = serialized.length;
  let marker = '';
  let keep = 0;

  // The omitted count changes the marker width, which changes how many
  // characters are kept, which changes the omitted count. Settle it.
  for (let attempt = 0; attempt < 6; attempt++) {
    marker = `[truncated: ${omitted} characters omitted]`;
    // final length = header + keep + '\n' + marker
    keep = Math.max(0, maxChars - header.length - 1 - marker.length);
    let nextOmitted = Math.max(0, serialized.length - keep);
    if (nextOmitted === omitted)
      break;

    omitted = nextOmitted;
  }

  marker = `[truncated: ${omitted} characters omitted]`;
  keep = Math.max(0, maxChars - header.length - 1 - marker.length);
  let truncatedText = keep > 0 ? `${serialized.slice(0, keep)}\n${marker}` : marker;

  return {
    id: frame.id,
    type: TRUNCATED_FRAME_TYPE,
    content: { text: truncatedText },
  };
}

function createSummaryFrame(text, index) {
  return {
    id: `compaction-summary-${index + 1}`,
    type: 'CompactionSummary',
    content: { text },
  };
}

function createMarkerFrame(text) {
  return {
    id: `compaction-trim-marker-${text.length}`,
    type: 'TruncationNote',
    content: { text },
  };
}

function resolveEstimator(estimateTokens) {
  return typeof estimateTokens === 'function' ? estimateTokens : defaultEstimateTokens;
}

function normalizeFrames(frames) {
  if (!Array.isArray(frames))
    return [];

  return frames.filter((frame) => frame?.id && frame.type).slice();
}

function normalizePositiveInteger(value, fallback) {
  if (value == null)
    return fallback;

  let number = Number(value);
  if (!Number.isFinite(number) || number < 1)
    return fallback;

  return Math.trunc(number);
}

function normalizeNonNegativeInteger(value, fallback) {
  if (value == null)
    return fallback;

  let number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    return fallback;

  return Math.trunc(number);
}
