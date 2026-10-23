'use strict';

import { pathsFromItems, readJSONFiles } from './aeordb-file-utils.mjs';
import { FrameStoreScheduledBase } from './frame-store-scheduled.mjs';
import {
  DEFAULT_FRAME_LIST_LIMIT,
  DIRECTORY_PAGE_LIMIT,
  MAX_FRAME_LIST_LIMIT,
  MAX_PREVIEW_RAW_FRAMES,
  PREVIEW_RAW_EXPANSION,
} from './frame-store-constants.mjs';
import {
  isPreviewVisibleFrame,
  normalizeLargeLimit,
  normalizeOptionalOrder,
  normalizePreviewCount,
  normalizePreviewTotal,
  normalizeSessionIDs,
} from './frame-store-normalizers.mjs';
import { frameOrderFromPath, sortFramePathsByOrder } from './frame-store-ordering.mjs';
import { createFrameLoadError } from './frame-store-errors.mjs';
import { encodeSegment } from './frame-store-paths.mjs';
import { projectFrameMessages } from '../../shared/frame-manager/frame-manager.mjs';

export class FrameStorePreviewBase extends FrameStoreScheduledBase {
  async listSessionPreviews(sessionIDs, options = {}) {
    let ids = normalizeSessionIDs(sessionIDs, options.maxSessions);
    if (ids.length === 0)
      return [];

    let previewCount = normalizePreviewCount(options.previewCount);
    let rawLimit = Math.min(MAX_PREVIEW_RAW_FRAMES, previewCount * PREVIEW_RAW_EXPANSION);
    let sessions = await this.loadSessionManifests(ids);
    let previews = [];

    for (let sessionID of ids) {
      let session = sessions.get(sessionID) || null;

      if (!session) {
        previews.push({
          sessionID,
          session: null,
          heads: [],
          truncated: false,
          error: 'session not found',
        });
        continue;
      }

      let entry = {
        sessionID,
        session,
        heads: [],
        truncated: false,
        error: null,
      };

      try {
        let tail = await this.loadSessionPreviewHeads(sessionID, { rawLimit, previewCount });
        entry.heads = tail.heads;
        entry.truncated = tail.truncated;
      } catch (error) {
        entry.error = error?.message || 'preview unavailable';
      }

      previews.push(entry);
    }

    return previews;
  }

  async listFrameWindow(sessionID, options = {}) {
    if (!sessionID)
      throw new TypeError('listFrameWindow() requires sessionID');

    let limit = normalizeLargeLimit(options.limit, DEFAULT_FRAME_LIST_LIMIT);
    let before = normalizeOptionalOrder(options.before);
    let after = normalizeOptionalOrder(options.after);
    let startID = typeof options.start === 'string' ? options.start.trim() : '';
    let interactionsPath = `${this.rootPath}/sessions/${encodeSegment(sessionID)}/interactions`;
    let listOptions = { depth: -1, glob: '**/frames/*.json' };
    let probe;

    try {
      probe = await this.aeordb.listDirectory(interactionsPath, {
        ...listOptions,
        limit: 1,
        offset: 0,
      });
    } catch (error) {
      if (error?.status === 404)
        return emptyFrameWindow();

      throw error;
    }

    // The window must anchor to the true tail of the session. Scanning with the
    // default limit would silently stop after the first page, so the newest frames
    // (everything after the cap) would be unreachable in large sessions. Use the
    // directory total to seek the tail, and binary-search the `before` boundary.
    let total = normalizePreviewTotal(probe?.total);
    let windowPaths;
    let startOffset;

    if (total > 0) {
      let startByID = startID
        ? await this.findFrameOffsetByID(interactionsPath, startID, total)
        : null;

      if (startByID != null && startByID < 0)
        return { ...emptyFrameWindow(), total, startFound: false };

      let endOffset;
      if (startByID != null) {
        startOffset = startByID;
        endOffset = Math.min(total, startOffset + limit);
      } else if (after != null) {
        startOffset = await this.findFrameOffsetAtOrAfter(interactionsPath, after + 1, total);
        endOffset = Math.min(total, startOffset + limit);
      } else {
        endOffset = before == null
          ? total
          : await this.findFrameOffsetAtOrAfter(interactionsPath, before, total);
        startOffset = Math.max(0, endOffset - limit);
      }

      windowPaths = await this.listDirectoryPaths(interactionsPath, {
        ...listOptions,
        limit: endOffset - startOffset,
        offset: startOffset,
      });
    } else {
      // No pagination metadata: fall back to a full (uncapped) scan.
      let allPaths = await this.listDirectoryPaths(interactionsPath, { ...listOptions, limit: MAX_FRAME_LIST_LIMIT });
      let allSorted = sortFramePathsByOrder(allPaths.filter((path) => path.includes('/frames/')));
      total = allSorted.length;
      let endOffset = before == null ? total : findOrderBoundary(allSorted, before);
      startOffset = Math.max(0, endOffset - limit);
      windowPaths = allSorted.slice(startOffset, endOffset);
    }

    windowPaths = sortFramePathsByOrder(windowPaths.filter((path) => path.includes('/frames/')));

    if (total === 0 || windowPaths.length === 0)
      return { ...emptyFrameWindow(), total };

    let frames = [];
    let reads = await readJSONFiles(this.aeordb, windowPaths, {
      fallbackOnBatchError: true,
      continueOnError: true,
    });
    for (let read of reads) {
      if (read.error) {
        // Never silently drop a frame: surface it as a visible load-error so the
        // projected stream stays truthful about what could not be read.
        frames.push(createFrameLoadError(sessionID, read.path, read.error));
        continue;
      }

      let frame = read.value;
      if (frame?.id && frame.type)
        frames.push(frame);
    }

    let heads = projectFrameMessages(frames).filter(isPreviewVisibleFrame);

    let pagedFromCursor = Boolean(startID) || after != null;
    return {
      frames: heads,
      total,
      hasMore: startOffset > 0,
      ...(pagedFromCursor ? { hasMoreNewer: startOffset + (windowPaths.length || 0) < total } : {}),
      ...(startID ? { startFound: true } : {}),
      oldestOrder: frameOrderFromPath(windowPaths[0]),
      newestOrder: frameOrderFromPath(windowPaths[windowPaths.length - 1]),
    };
  }

  // Find a frame by its stable id in the raw directory. Frame paths end with
  // `-<encoded id>.json`; scan names only (never frame bodies) in bounded pages.
  async findFrameOffsetByID(interactionsPath, frameID, total) {
    let suffix = `-${encodeSegment(frameID)}.json`;
    let cursor = 0;

    while (cursor < total) {
      let paths = await this.listDirectoryPaths(interactionsPath, {
        depth: -1,
        glob: '**/frames/*.json',
        limit: DIRECTORY_PAGE_LIMIT,
        offset: cursor,
      });
      if (paths.length === 0)
        return -1;

      for (let index = 0; index < paths.length; index++) {
        if (String(paths[index]).endsWith(suffix))
          return cursor + index;
      }

      if (paths.length < DIRECTORY_PAGE_LIMIT)
        return -1;
      cursor += paths.length;
    }

    return -1;
  }

  // First directory offset whose frame order is >= `before`. The directory lists
  // frame paths in ascending basename (zero-padded order) order, so a binary search
  // finds the boundary with O(log total) one-entry probes instead of a full scan.
  async findFrameOffsetAtOrAfter(interactionsPath, before, total) {
    let low = 0;
    let high = total;

    while (low < high) {
      let mid = Math.floor((low + high) / 2);
      let page = await this.aeordb.listDirectory(interactionsPath, {
        depth: -1,
        glob: '**/frames/*.json',
        limit: 1,
        offset: mid,
      });
      let [ path ] = pathsFromItems(page?.items);
      let order = path ? frameOrderFromPath(path) : Number.MAX_SAFE_INTEGER;

      if (order >= before)
        high = mid;
      else
        low = mid + 1;
    }

    return low;
  }

  async loadSessionPreviewHeads(sessionID, { rawLimit, previewCount }) {
    let interactionsPath = `${this.rootPath}/sessions/${encodeSegment(sessionID)}/interactions`;
    let baseOptions = { depth: -1, glob: '**/frames/*.json', limit: 1, offset: 0 };
    let probe = await this.aeordb.listDirectory(interactionsPath, baseOptions);
    let total = normalizePreviewTotal(probe?.total);

    if (total <= 0)
      return { heads: [], truncated: false };

    let offset = Math.max(0, total - rawLimit);
    let tailPaths = await this.listDirectoryPaths(interactionsPath, {
      depth: -1,
      glob: '**/frames/*.json',
      limit: rawLimit,
      offset,
    });
    tailPaths = tailPaths.filter((path) => path.includes('/frames/'));
    let sortedPaths = sortFramePathsByOrder(tailPaths);

    let reads = await readJSONFiles(this.aeordb, sortedPaths, {
      fallbackOnBatchError: true,
      continueOnError: true,
    });
    let frames = [];
    for (let read of reads) {
      if (read.error) {
        // Never silently drop a frame: surface it as a visible load-error so the
        // projected stream stays truthful about what could not be read.
        frames.push(createFrameLoadError(sessionID, read.path, read.error));
        continue;
      }

      let frame = read.value;
      if (frame?.id && frame.type)
        frames.push(frame);
    }

    let heads = projectFrameMessages(frames).filter(isPreviewVisibleFrame);
    let truncated = heads.length > previewCount || offset > 0;

    return {
      heads: heads.slice(-previewCount),
      truncated,
    };
  }
}

function emptyFrameWindow() {
  return {
    frames: [],
    total: 0,
    hasMore: false,
    oldestOrder: null,
    newestOrder: null,
  };
}

// First index in a frame-path array whose order is >= `before` (paths are sorted
// ascending by zero-padded order). Returns the array length when none match.
function findOrderBoundary(sortedPaths, before) {
  let index = sortedPaths.findIndex((path) => frameOrderFromPath(path) >= before);
  return index === -1 ? sortedPaths.length : index;
}
