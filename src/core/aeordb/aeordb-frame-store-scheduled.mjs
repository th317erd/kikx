'use strict';

import { pathsFromItems, readJSONFiles } from './aeordb-file-utils.mjs';
import { AeorDBFrameStoreCommitBase } from './aeordb-frame-store-commit.mjs';
import { normalizeLimit, normalizeOffset, shouldFallbackToScheduledFrameScan, isPendingScheduledFrame, uniqueStrings } from './aeordb-frame-store-normalizers.mjs';
import { compareScheduledFrameOrder } from './aeordb-frame-store-ordering.mjs';

export class AeorDBFrameStoreScheduledBase extends AeorDBFrameStoreCommitBase {
  async listScheduledFrames(options = {}) {
    let limit = normalizeLimit(options.limit, 500);
    let offset = normalizeOffset(options.offset);
    let frames = await this.searchScheduledFrames({ limit, offset });

    if (frames)
      return frames;

    return await this.listScheduledFramesFallback({ limit, offset });
  }

  async searchScheduledFrames({ limit, offset }) {
    let hasQuery = typeof this.aeordb.queryFiles === 'function';
    let hasSearch = typeof this.aeordb.searchFiles === 'function';
    if (!hasQuery && !hasSearch)
      return null;

    let query = {
      path: `${this.rootPath}/sessions`,
      where: {
        and: [
          { field: 'scheduledAt', op: 'gt', value: 0 },
          { not: { field: 'scheduledStatus', op: 'eq', value: 'fired' } },
          { not: { field: 'scheduledStatus', op: 'eq', value: 'cancelled' } },
        ],
      },
      limit,
      offset,
    };

    // Prefer the structured query endpoint, but an unavailable endpoint must not
    // be read as "no results" (AeorDB 0.9.5 has no /files/query and 404s). Fall
    // through to search, then to the scan fallback in `listScheduledFrames`.
    let result = null;
    if (hasQuery) {
      try {
        result = await this.aeordb.queryFiles(query);
      } catch (error) {
        if (!shouldFallbackToScheduledFrameScan(error))
          throw error;

        result = null;
      }
    }

    if (result == null && hasSearch) {
      try {
        result = await this.aeordb.searchFiles(query);
      } catch (error) {
        if (!shouldFallbackToScheduledFrameScan(error))
          throw error;

        result = null;
      }
    }

    if (result == null)
      return null;

    return await this.readScheduledFramePaths(pathsFromItems(result?.results || result?.items || []));
  }

  async listScheduledFramesFallback({ limit, offset }) {
    let sessions = await this.listSessions({ limit: 500, offset: 0 });
    let frames = [];

    for (let session of sessions) {
      let sessionFrames = await this.listFrames(session.id, { limit: 500, offset: 0 });
      for (let frame of sessionFrames) {
        if (isPendingScheduledFrame(frame))
          frames.push(frame);
      }
    }

    return frames
      .sort(compareScheduledFrameOrder)
      .slice(offset, offset + limit);
  }

  async readScheduledFramePaths(paths) {
    let framePaths = uniqueStrings(paths)
      .filter((path) => path.includes('/frames/'));
    let reads = await readJSONFiles(this.aeordb, framePaths, {
      fallbackOnBatchError: true,
      continueOnError: true,
    });
    let frames = [];

    for (let read of reads) {
      if (read.error)
        continue;

      let frame = read.value;
      if (isPendingScheduledFrame(frame))
        frames.push(frame);
    }

    return frames.sort(compareScheduledFrameOrder);
  }
}
