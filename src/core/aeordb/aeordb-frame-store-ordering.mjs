'use strict';

import { createCommittedFrameLoadError } from './aeordb-frame-store-errors.mjs';

export function sortFramePathsByOrder(paths) {
  return [ ...paths ].sort((left, right) => {
    let leftOrder = frameOrderFromPath(left);
    let rightOrder = frameOrderFromPath(right);
    if (leftOrder !== rightOrder)
      return leftOrder - rightOrder;

    return String(left).localeCompare(String(right));
  });
}

export function frameOrderFromPath(path) {
  let name = String(path).split('/').pop() || '';
  let match = /^(\d+)-/.exec(name);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function compareSessionOrder(a, b) {
  return compareClock(b?.updatedClock, a?.updatedClock)
    || compareNumber(b?.updatedAt, a?.updatedAt)
    || compareClock(b?.createdClock, a?.createdClock)
    || compareNumber(b?.createdAt, a?.createdAt)
    || String(a.id || '').localeCompare(String(b.id || ''));
}

export function compareFrameOrder(a, b) {
  return compareClock(logicalSortClock(a), logicalSortClock(b))
    || compareNumber(logicalSortTime(a), logicalSortTime(b))
    || compareNumber(a?.order, b?.order)
    || compareNumber(sortCommitOrder(a), sortCommitOrder(b))
    || String(a.id).localeCompare(String(b.id));
}

export function compareScheduledFrameOrder(a, b) {
  return compareNumber(a?.scheduledAt, b?.scheduledAt)
    || compareClock(a?.updatedClock, b?.updatedClock)
    || compareNumber(a?.updatedAt, b?.updatedAt)
    || String(a?.id || '').localeCompare(String(b?.id || ''));
}

export function compareCommitOrder(a, b) {
  return ((a.order || 0) - (b.order || 0)) || String(a.id).localeCompare(String(b.id));
}

export function orderFramesByCommits(sessionID, frames, commits) {
  let frameByID = new Map();
  let outputByID = new Map();
  let ordered = [];

  for (let frame of frames) {
    if (!frame?.id)
      continue;

    let existing = frameByID.get(frame.id);
    if (!existing || compareFrameFileVersion(existing, frame) <= 0)
      frameByID.set(frame.id, frame);
  }

  for (let commit of commits) {
    for (let frameID of commitFrameIDs(commit)) {
      if (!frameID)
        continue;

      let frame = frameByID.get(frameID);
      if (!frame) {
        outputByID.set(frameID, createCommittedFrameLoadError(sessionID, commit, frameID));
        continue;
      }

      outputByID.set(frameID, {
        ...frame,
        commitOrder: commit.order,
      });
    }
  }

  for (let frame of outputByID.values())
    ordered.push(frame);

  for (let [frameID, frame] of frameByID) {
    if (!outputByID.has(frameID))
      ordered.push(frame);
  }

  return ordered.sort(compareFrameOrder);
}

export function commitFrameIDs(commit) {
  let frameIDs = [];

  if (Array.isArray(commit?.changes)) {
    for (let change of commit.changes) {
      if (change?.frameID)
        frameIDs.push(change.frameID);
    }
  }

  if (frameIDs.length === 0 && Array.isArray(commit?.frameIDs)) {
    for (let frameID of commit.frameIDs) {
      if (frameID)
        frameIDs.push(frameID);
    }
  }

  return frameIDs;
}

function logicalSortClock(frame) {
  if (isClosedAgentMessage(frame))
    return frame?.state?.lifecycle?.closedClock || sortUpdatedClock(frame);

  return frame?.createdClock;
}

function logicalSortTime(frame) {
  if (isClosedAgentMessage(frame))
    return numberOr(frame?.state?.lifecycle?.closedAt, sortUpdatedAt(frame));

  return frame?.createdAt;
}

function isClosedAgentMessage(frame) {
  return frame?.type === 'AgentMessage'
    && (
      frame?.state?.lifecycle?.status === 'closed'
      || frame?.content?.status === 'complete'
    );
}

function sortUpdatedClock(frame) {
  return stringOr(frame?.updatedClock, frame?.createdClock);
}

function sortUpdatedAt(frame) {
  return numberOr(frame?.updatedAt, frame?.createdAt || 0);
}

function sortCommitOrder(frame) {
  if (typeof frame?.commitOrder === 'number' && Number.isFinite(frame.commitOrder))
    return frame.commitOrder;

  return frame?.order || 0;
}

function compareFrameFileVersion(a, b) {
  return compareClock(sortUpdatedClock(a), sortUpdatedClock(b))
    || compareNumber(sortUpdatedAt(a), sortUpdatedAt(b))
    || compareNumber(a?.commitOrder, b?.commitOrder)
    || compareNumber(a?.order, b?.order);
}

function compareClock(a, b) {
  if (!a || !b)
    return 0;

  if (a && b && a !== b)
    return String(a).localeCompare(String(b));

  return 0;
}

function compareNumber(a, b) {
  let left = (typeof a === 'number' && Number.isFinite(a)) ? a : 0;
  let right = (typeof b === 'number' && Number.isFinite(b)) ? b : 0;
  return left - right;
}

function numberOr(value, fallback) {
  return (typeof value === 'number' && Number.isFinite(value)) ? value : fallback;
}

function stringOr(value, fallback = null) {
  return (typeof value === 'string' && value.trim() !== '') ? value : fallback;
}
