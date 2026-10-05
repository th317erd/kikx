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
    // Scheduled frames live under each session's `interactions` directory, where
    // `scheduledAt`/`scheduledStatus` are indexed with glob `**/frames/*.json`.
    // This is a CROSS-session lookup, so the global search endpoint — which fans
    // out across every directory that indexes the requested fields — is the
    // correct API. A path-scoped `/files/query` at the sessions root has no such
    // index and returns 404 by design ("Index not found for field ... at path").
    if (typeof this.aeordb.searchFiles !== 'function')
      return null;

    let result;
    try {
      result = await this.aeordb.searchFiles({
        path: this.rootPath,
        where: {
          and: [
            { field: 'scheduledAt', op: 'gt', value: 0 },
            { not: { field: 'scheduledStatus', op: 'eq', value: 'fired' } },
            { not: { field: 'scheduledStatus', op: 'eq', value: 'cancelled' } },
          ],
        },
        limit,
        offset,
      });
    } catch (error) {
      // A missing index at a scanned path (404), an unsupported query feature
      // (400/500), or a query/search error all mean "cannot answer via the
      // index" — fall through to the authoritative per-session scan. Never treat
      // an error as an empty result set.
      if (!shouldFallbackToScheduledFrameScan(error))
        throw error;

      return null;
    }

    // `readScheduledFramePaths` re-verifies every returned frame against
    // `isPendingScheduledFrame`, so correctness does not depend on the index's
    // fired/cancelled exclusion.
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
