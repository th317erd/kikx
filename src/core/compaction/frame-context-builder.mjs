'use strict';

import {
  COMPACTION_FRAME_KIND,
  COMPACTION_FRAME_TYPE,
} from './agent-compaction-template.mjs';

const DEFAULT_CHARS_PER_TOKEN = 4;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128000;
const DEFAULT_PROMPT_RESERVE_TOKENS = 8000;
const DEFAULT_COMPACTION_TRIGGER_RATIO = 0.7;
const DEFAULT_HARD_LIMIT_RATIO = 1;

export class FrameContextBuilder {
  constructor(options = {}) {
    this.contextWindowTokens = normalizePositiveInteger(options.contextWindowTokens, DEFAULT_CONTEXT_WINDOW_TOKENS);
    this.promptReserveTokens = normalizeNonNegativeInteger(options.promptReserveTokens, DEFAULT_PROMPT_RESERVE_TOKENS);
    this.compactionTriggerRatio = normalizeRatio(options.compactionTriggerRatio, DEFAULT_COMPACTION_TRIGGER_RATIO);
    this.hardLimitRatio = normalizeRatio(options.hardLimitRatio, DEFAULT_HARD_LIMIT_RATIO);
    this.estimateTokens = typeof options.estimateTokens === 'function'
      ? options.estimateTokens
      : estimateTokens;
  }

  build(frames, options = {}) {
    let allFrames = normalizeFrameArray(frames);
    let activeFrameID = normalizeOptionalString(options.activeFrameID);
    let contextWindowTokens = normalizePositiveInteger(options.contextWindowTokens, this.contextWindowTokens);
    let promptReserveTokens = normalizeNonNegativeInteger(options.promptReserveTokens, this.promptReserveTokens);
    let triggerRatio = normalizeRatio(options.compactionTriggerRatio, this.compactionTriggerRatio);
    let hardLimitRatio = normalizeRatio(options.hardLimitRatio, this.hardLimitRatio);
    let availableTokens = Math.max(1, contextWindowTokens - promptReserveTokens);
    let latestCompaction = findLatestCompletedCompaction(allFrames);
    let contextFrames = buildContextFramesAfterCompaction(allFrames, latestCompaction);
    let contextTokens = this.countFrameTokens(contextFrames);
    let activeIndex = activeFrameID
      ? allFrames.findIndex((frame) => frame.id === activeFrameID)
      : allFrames.length;
    let compactionWindow = selectCompactionWindow({
      frames: allFrames,
      latestCompaction,
      activeIndex,
      tokenBudget: normalizePositiveInteger(options.compactionContextBudgetTokens, availableTokens),
      estimateTokens: this.estimateTokens,
    });

    return {
      frames: contextFrames,
      allFrames,
      latestCompaction,
      contextTokens,
      availableTokens,
      usageRatio: contextTokens / availableTokens,
      shouldCompact: contextTokens >= Math.floor(availableTokens * triggerRatio) && compactionWindow.frames.length > 0,
      shouldWaitForCompaction: contextTokens >= Math.floor(availableTokens * hardLimitRatio) && compactionWindow.frames.length > 0,
      compactionWindow,
    };
  }

  countFrameTokens(frames) {
    let total = 0;
    for (let frame of normalizeFrameArray(frames))
      total += this.estimateTokens(serializeFrameForContext(frame));

    return total;
  }
}

export function estimateTokens(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.max(1, Math.ceil(text.length / DEFAULT_CHARS_PER_TOKEN));
}

export function serializeFrameForContext(frame) {
  if (!frame)
    return '';

  let header = [
    `type=${frame.type || ''}`,
    `id=${frame.id || ''}`,
    `authorType=${frame.authorType || ''}`,
    `authorID=${frame.authorID || ''}`,
    `authorDisplayName=${frame.authorDisplayName || ''}`,
    `createdAt=${frame.createdAt || frame.timestamp || ''}`,
  ].filter(Boolean).join(' ');

  if (frame.type === COMPACTION_FRAME_TYPE || frame.content?.kind === COMPACTION_FRAME_KIND) {
    let summary = frame.content?.summary || frame.content?.text || '';
    return `[${header}]\nCompacted context memory:\n${summary}`;
  }

  return `[${header}]\n${extractFrameText(frame)}`;
}

export function serializeFramesForCompaction(frames) {
  return normalizeFrameArray(frames)
    .map((frame) => serializeFrameForContext(frame))
    .filter((text) => text.trim() !== '')
    .join('\n\n---\n\n');
}

export function isCompactionFrame(frame) {
  return frame?.type === COMPACTION_FRAME_TYPE || frame?.content?.kind === COMPACTION_FRAME_KIND;
}

function buildContextFramesAfterCompaction(frames, latestCompaction) {
  if (latestCompaction) {
    let boundaryOrder = compactionBoundaryOrder(latestCompaction);
    return [
      latestCompaction,
      ...frames
        .filter((frame) => frame?.id !== latestCompaction.id)
        .filter((frame) => frame?.deleted !== true)
        .filter((frame) => !isCompactionFrame(frame))
        .filter((frame) => frame.hidden !== true)
        .filter((frame) => Number(frame.order || 0) > boundaryOrder),
    ];
  }

  return frames
    .filter((frame) => frame?.deleted !== true)
    .filter((frame) => frame.hidden !== true || isCompactionFrame(frame));
}

function selectCompactionWindow({ frames, latestCompaction, activeIndex, tokenBudget, estimateTokens: tokenEstimator }) {
  let candidates;
  let activeFrame = activeIndex >= 0 ? frames[activeIndex] : null;
  let activeOrder = activeFrame ? Number(activeFrame.order || 0) : Number.POSITIVE_INFINITY;
  if (latestCompaction) {
    let boundaryOrder = compactionBoundaryOrder(latestCompaction);
    candidates = [
      latestCompaction,
      ...frames
        .filter((frame) => frame?.id !== latestCompaction.id)
        .filter((frame) => !isCompactionFrame(frame))
        .filter((frame) => Number(frame.order || 0) > boundaryOrder)
        .filter((frame) => Number(frame.order || 0) < activeOrder),
    ];
  } else {
    let endExclusive = activeIndex >= 0 ? activeIndex : frames.length;
    candidates = frames.slice(0, endExclusive);
  }
  let selected = [];
  let tokens = 0;

  for (let frame of candidates) {
    if (!isCompactableFrame(frame))
      continue;

    let frameTokens = tokenEstimator(serializeFrameForContext(frame));
    if (selected.length > 0 && tokens + frameTokens > tokenBudget)
      break;

    selected.push(frame);
    tokens += frameTokens;
  }

  let startFrame = selected[0] || null;
  let boundaryFrame = selected[selected.length - 1] || null;
  return {
    frames: selected,
    tokens,
    startFrameID: startFrame?.id || null,
    boundaryFrameID: boundaryFrame?.id || null,
    boundaryOrder: boundaryFrame?.order ?? null,
    contextText: serializeFramesForCompaction(selected),
  };
}

function isCompactableFrame(frame) {
  if (!frame?.id || !frame.type || frame.deleted === true)
    return false;

  if (frame.phantom === true)
    return false;

  return frame.hidden !== true || isCompactionFrame(frame);
}

function findLatestCompletedCompaction(frames) {
  let compactFrames = normalizeFrameArray(frames)
    .filter((frame) => isCompactionFrame(frame))
    .filter((frame) => frame.content?.status !== 'started' && frame.content?.status !== 'failed')
    .filter((frame) => typeof (frame.content?.summary || frame.content?.text) === 'string');

  compactFrames.sort((a, b) => {
    return compareNumber(compactionBoundaryOrder(a), compactionBoundaryOrder(b))
      || compareNumber(a.createdAt || a.timestamp || 0, b.createdAt || b.timestamp || 0)
      || String(a.id || '').localeCompare(String(b.id || ''));
  });

  return compactFrames.at(-1) || null;
}

function compactionBoundaryOrder(frame) {
  return frame?.compaction?.boundaryOrder ?? frame?.content?.boundaryOrder ?? frame?.order ?? 0;
}

function extractFrameText(frame) {
  let content = frame?.content;
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

function normalizeFrameArray(frames) {
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

function normalizeRatio(value, fallback) {
  if (value == null)
    return fallback;

  let number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    return fallback;

  return Math.min(number, 1);
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function compareNumber(a, b) {
  return (Number(a) || 0) - (Number(b) || 0);
}
