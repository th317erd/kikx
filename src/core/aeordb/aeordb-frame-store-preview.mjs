'use strict';

import { readJSONFiles } from './aeordb-file-utils.mjs';
import { AeorDBFrameStoreScheduledBase } from './aeordb-frame-store-scheduled.mjs';
import {
  DEFAULT_FRAME_LIST_LIMIT,
  MAX_PREVIEW_RAW_FRAMES,
  PREVIEW_RAW_EXPANSION,
} from './aeordb-frame-store-constants.mjs';
import {
  isPreviewVisibleFrame,
  normalizeLargeLimit,
  normalizeOptionalOrder,
  normalizePreviewCount,
  normalizePreviewTotal,
  normalizeSessionIDs,
} from './aeordb-frame-store-normalizers.mjs';
import { frameOrderFromPath, sortFramePathsByOrder } from './aeordb-frame-store-ordering.mjs';
import { encodeSegment } from './aeordb-frame-store-paths.mjs';
import { projectFrameMessages } from '../../shared/frame-manager/frame-manager.mjs';

export class AeorDBFrameStorePreviewBase extends AeorDBFrameStoreScheduledBase {
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

    let allPaths = await this.listDirectoryPaths(interactionsPath, listOptions);
    let framePaths = allPaths.filter((path) => path.includes('/frames/'));
    let sortedPaths = sortFramePathsByOrder(framePaths);
    let total = sortedPaths.length;

    if (total === 0)
      return emptyFrameWindow();

    let endIndex = total;
    if (before != null) {
      let beforeIndex = sortedPaths.findIndex((path) => frameOrderFromPath(path) >= before);
      endIndex = beforeIndex === -1 ? total : beforeIndex;
    }

    let startIndex = Math.max(0, endIndex - limit);
    let windowPaths = sortedPaths.slice(startIndex, endIndex);

    let frames = [];
    let reads = await readJSONFiles(this.aeordb, windowPaths, {
      fallbackOnBatchError: true,
      continueOnError: true,
    });
    for (let read of reads) {
      if (read.error)
        continue;

      let frame = read.value;
      if (frame?.id && frame.type)
        frames.push(frame);
    }

    let heads = projectFrameMessages(frames).filter(isPreviewVisibleFrame);

    return {
      frames: heads,
      total,
      hasMore: startIndex > 0,
      oldestOrder: frameOrderFromPath(windowPaths[0]),
      newestOrder: frameOrderFromPath(windowPaths[windowPaths.length - 1]),
    };
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
      if (read.error)
        continue;

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
