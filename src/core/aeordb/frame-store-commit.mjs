'use strict';

import { pathsFromItems, readJSONFiles } from './aeordb-file-utils.mjs';
import { FrameStoreSessionBase } from './frame-store-base.mjs';
import { DEFAULT_FRAME_LIST_LIMIT, DIRECTORY_PAGE_LIMIT } from './frame-store-constants.mjs';
import { createFrameLoadError } from './frame-store-errors.mjs';
import { normalizeLargeLimit, normalizeOffset, uniqueStrings } from './frame-store-normalizers.mjs';
import { compareCommitOrder, compareFrameOrder, orderFramesByCommits, sortFramePathsByOrder } from './frame-store-ordering.mjs';
import { encodeSegment } from './frame-store-paths.mjs';
import { serializeCommit, serializeFrame } from './frame-store-serialization.mjs';

export class FrameStoreCommitBase extends FrameStoreSessionBase {
  async listFrames(sessionID, options = {}) {
    if (!sessionID)
      throw new TypeError('listFrames() requires sessionID');

    let limit = normalizeLargeLimit(options.limit, DEFAULT_FRAME_LIST_LIMIT);
    let offset = normalizeOffset(options.offset);
    if (options.latest === true)
      return await this.listLatestFrames(sessionID, { limit });

    let paths = await this.listDirectoryPaths(`${this.rootPath}/sessions/${encodeSegment(sessionID)}/interactions`, {
      depth: -1,
      glob: '**/*.json',
      limit,
      offset,
    });
    let framePaths = paths.filter((path) => path.includes('/frames/'));
    let frames = [];
    let reads = await readJSONFiles(this.aeordb, framePaths, {
      fallbackOnBatchError: true,
      continueOnError: true,
    });

    for (let read of reads) {
      if (read.error) {
        frames.push(createFrameLoadError(sessionID, read.path, read.error));
        continue;
      }

      let frame = read.value;
      if (frame?.id && frame.type)
        frames.push(frame);
    }

    let commits = await this.listCommits(sessionID, { limit, offset });
    if (commits.length === 0)
      return frames.sort(compareFrameOrder);

    return orderFramesByCommits(sessionID, frames, commits);
  }

  // Hydrate a live runtime from the newest frame window, not the oldest. The
  // default directory order is ascending; using it for `ensureSessionEntry()`
  // leaves the runtime's frame-order watermark below the durable tail, so new
  // frames and compaction boundaries receive stale orders and disappear from
  // the newest client window after a reload. Paging APIs keep the legacy
  // offset semantics and use the normal listFrames() path above.
  async listLatestFrames(sessionID, options = {}) {
    let limit = normalizeLargeLimit(options.limit, DEFAULT_FRAME_LIST_LIMIT);
    let interactionsPath = `${this.rootPath}/sessions/${encodeSegment(sessionID)}/interactions`;
    let listOptions = { depth: -1, glob: '**/frames/*.json' };
    let paths;

    try {
      let probe = await this.aeordb.listDirectory(interactionsPath, {
        ...listOptions,
        limit: 1,
        offset: 0,
      });
      let total = Number(probe?.total);
      if (Number.isFinite(total) && total > 0) {
        let offset = Math.max(0, Math.trunc(total) - limit);
        paths = await this.listDirectoryPaths(interactionsPath, {
          ...listOptions,
          limit,
          offset,
        });
      }
    } catch (error) {
      if (error?.status !== 404)
        throw error;
      return [];
    }

    if (!paths) {
      paths = await this.listDirectoryPaths(interactionsPath, {
        ...listOptions,
        limit: 5000,
      });
      paths = sortFramePathsByOrder(paths).slice(-limit);
    }

    paths = sortFramePathsByOrder(paths.filter((path) => path.includes('/frames/')));
    let frames = [];
    let reads = await readJSONFiles(this.aeordb, paths, {
      fallbackOnBatchError: true,
      continueOnError: true,
    });

    for (let read of reads) {
      if (read.error) {
        frames.push(createFrameLoadError(sessionID, read.path, read.error));
        continue;
      }

      let frame = read.value;
      if (frame?.id && frame.type)
        frames.push(frame);
    }

    return frames.sort(compareFrameOrder);
  }

  async listCommits(sessionID, options = {}) {
    let limit = normalizeLargeLimit(options.limit, DEFAULT_FRAME_LIST_LIMIT);
    let offset = normalizeOffset(options.offset);
    let commitPaths;

    try {
      commitPaths = await this.listDirectoryPaths(`${this.rootPath}/sessions/${encodeSegment(sessionID)}/commits`, {
        depth: -1,
        glob: '**/*.json',
        limit,
        offset,
      });
    } catch (error) {
      if (error?.status === 404)
        return [];

      throw error;
    }

    let commits = [];
    let reads = await readJSONFiles(this.aeordb, commitPaths, {
      fallbackOnBatchError: true,
      continueOnError: true,
    });

    for (let read of reads) {
      if (read.error)
        continue;

      let commit = read.value;
      if (commit?.id && typeof commit.order === 'number')
        commits.push(commit);
    }

    return commits.sort(compareCommitOrder);
  }

  async listDirectoryPaths(path, options = {}) {
    let limit = normalizeLargeLimit(options.limit, DEFAULT_FRAME_LIST_LIMIT);
    let offset = normalizeOffset(options.offset);
    let paths = [];
    let remaining = limit;
    let cursor = offset;

    while (remaining > 0) {
      let pageLimit = Math.min(DIRECTORY_PAGE_LIMIT, remaining);
      let result = await this.aeordb.listDirectory(path, {
        ...options,
        limit: pageLimit,
        offset: cursor,
      });
      let pagePaths = pathsFromItems(result?.items);

      paths.push(...pagePaths);

      if (pagePaths.length < pageLimit)
        break;

      cursor += pageLimit;
      remaining -= pageLimit;
    }

    return uniqueStrings(paths);
  }

  async saveCommit(sessionID, commit, frames, frameEngine = null) {
    if (!sessionID)
      throw new TypeError('sessionID is required to save a commit');

    if (!commit?.id || typeof commit.order !== 'number')
      throw new TypeError('saveCommit() requires a commit with id and order');

    let changedFrames = Array.isArray(frames) ? frames : [];

    for (let frame of changedFrames)
      await this.saveFrame(sessionID, frame);

    await this.aeordb.putFile(this.commitPath(sessionID, commit), serializeCommit(commit, changedFrames));

    if (frameEngine)
      await this.saveRefs(sessionID, frameEngine);
  }

  async saveFrame(sessionID, frame) {
    if (!sessionID)
      throw new TypeError('sessionID is required to save a frame');

    if (!frame?.id || !frame.type)
      throw new TypeError('saveFrame() requires frame.id and frame.type');

    await this.aeordb.putFile(this.framePath(sessionID, frame), serializeFrame(sessionID, frame));
  }

  async saveRefs(sessionID, frameEngine) {
    for (let [name, commitOrder] of frameEngine.listRefs())
      await this.aeordb.putFile(this.refPath(sessionID, name), { name, commitOrder });
  }
}
