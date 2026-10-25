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
import { windowFiltersAreDefault } from '../../shared/frame-window-filters.mjs';
import { countSessionFrames, listFilteredFrameWindow } from './frame-store-window-scan.mjs';
import { encodeSegment } from './frame-store-paths.mjs';
import { projectFrameMessages } from '../../shared/frame-manager/frame-manager.mjs';

export class FrameStorePreviewBase extends FrameStoreScheduledBase {
  async listSessionPreviews(sessionIDs, options = {}) {
    let ids = normalizeSessionIDs(sessionIDs, options.maxSessions);
    if (ids.length === 0)
      return [];

    let previewCount = normalizePreviewCount(options.previewCount);
    let maxRawLimit = Math.min(MAX_PREVIEW_RAW_FRAMES, previewCount * PREVIEW_RAW_EXPANSION);
    let sessions = await this.loadSessionManifests(ids);
    let previews = new Array(ids.length);

    // Each session preview is an independent tail read. A small worker pool
    // overlaps the database latency without opening one query per session at
    // once. Order is preserved by assigning results back to the source index.
    let cursor = 0;
    let workers = Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (cursor < ids.length) {
        let index = cursor++;
        let sessionID = ids[index];
        let session = sessions.get(sessionID) || null;

        if (!session) {
          previews[index] = {
            sessionID,
            session: null,
            heads: [],
            truncated: false,
            error: 'session not found',
          };
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
          let tail = await this.loadSessionPreviewHeads(sessionID, { maxRawLimit, previewCount });
          entry.heads = tail.heads;
          entry.truncated = tail.truncated;
        } catch (error) {
          entry.error = error?.message || 'preview unavailable';
        }

        previews[index] = entry;
      }
    });
    await Promise.all(workers);
    return previews;
  }

  async listFrameWindow(sessionID, options = {}) {
    if (!sessionID)
      throw new TypeError('listFrameWindow() requires sessionID');

    // A filtered window is a different question from a raw window: matches are
    // not contiguous, so a fixed slice of raw rows can come back empty while
    // thousands of matches sit just below it. Answer it with the bounded match
    // scan instead, so paging walks matches and `hasMore` stays truthful. The
    // default view never enters this branch, so its cost is unchanged.
    if (!windowFiltersAreDefault(options.filters, options.query)) {
      return await listFilteredFrameWindow(this, sessionID, options, {
        interactionsPath: `${this.rootPath}/sessions/${encodeSegment(sessionID)}/interactions`,
        // Deliberately NOT `isPreviewVisibleFrame`: the filter predicate has
        // already decided visibility, and re-applying the default gate here
        // would drop exactly the soft-deleted frames the user asked to see.
        project: (frames) => projectFrameMessages(frames).map(projectClientFrameForWindow),
      });
    }

    let limit = normalizeLargeLimit(options.limit, DEFAULT_FRAME_LIST_LIMIT);
    let before = normalizeOptionalOrder(options.before);
    let after = normalizeOptionalOrder(options.after);
    let startID = typeof options.start === 'string' ? options.start.trim() : '';
    let frameTypes = Array.isArray(options.frameTypes)
      ? new Set(options.frameTypes.filter((type) => typeof type === 'string' && type.trim() !== ''))
      : null;
    let interactionsPath = `${this.rootPath}/sessions/${encodeSegment(sessionID)}/interactions`;
    // Push a single-type filter into the directory range scan. Draft lookups are
    // the hot case: without this they list every frame path in a large session
    // just to discard all but a few UserDraft entries.
    let frameTypeGlob = frameTypes?.size === 1 && !startID
      ? `**/frames/*-${encodeSegment([ ...frameTypes ][0])}-*.json`
      : '';
    let listOptions = { depth: -1, glob: frameTypeGlob || '**/frames/*.json' };
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

    let readPaths = frameTypes
      ? windowPaths.filter((path) => [ ...frameTypes ].some((type) => path.includes(`-${type}-`)))
      : windowPaths;

    let frames = [];
    let reads = await readJSONFiles(this.aeordb, readPaths, {
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

    let outputFrames = options.raw === true
      ? frames
      : projectFrameMessages(frames).filter(isPreviewVisibleFrame).map(projectClientFrameForWindow);

    let pagedFromCursor = Boolean(startID) || after != null;
    return {
      frames: outputFrames,
      total,
      hasMore: startOffset > 0,
      ...(pagedFromCursor ? { hasMoreNewer: startOffset + (windowPaths.length || 0) < total } : {}),
      ...(startID ? { startFound: true } : {}),
      oldestOrder: frameOrderFromPath(windowPaths[0]),
      newestOrder: frameOrderFromPath(windowPaths[windowPaths.length - 1]),
    };
  }

  // Per-row counts for the whole session, derived from frame paths only.
  //
  // Counting the loaded page instead is what made the popup report a page-sized
  // Agent number beside zeros for kinds that happened to fall outside it. See
  // `countFilterMatches` for why the count ignores the current selection and
  // why Soft-deleted comes back `null` (it is a body field).
  async countSessionFrames(sessionID) {
    if (typeof sessionID !== 'string' || sessionID.trim() === '')
      throw new TypeError('countSessionFrames() requires sessionID');

    let interactionsPath = `${this.rootPath}/sessions/${encodeSegment(sessionID)}/interactions`;
    return await countSessionFrames(this, sessionID, {
      interactionsPath,
      listOptions: { depth: -1, glob: '**/frames/*.json' },
    });
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

  async loadSessionPreviewHeads(sessionID, { maxRawLimit, previewCount }) {
    let interactionsPath = `${this.rootPath}/sessions/${encodeSegment(sessionID)}/interactions`;
    let baseOptions = { depth: -1, glob: '**/frames/*.json', limit: 1, offset: 0 };
    let probe = await this.aeordb.listDirectory(interactionsPath, baseOptions);
    let total = normalizePreviewTotal(probe?.total);

    if (total <= 0)
      return { heads: [], truncated: false };

    // Start with a small tail and expand only when hidden/tool frames did not
    // project to enough visible heads. Most sessions stop after 2x previewCount
    // instead of always reading the 8x worst-case window.
    let rawLimit = Math.min(maxRawLimit, Math.max(previewCount, previewCount * 2));
    let allHeads = [];
    let offset = 0;

    while (true) {
      offset = Math.max(0, total - rawLimit);
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

      allHeads = projectFrameMessages(frames).filter(isPreviewVisibleFrame);
      if (allHeads.length >= previewCount || offset === 0 || rawLimit >= maxRawLimit)
        break;

      rawLimit = Math.min(maxRawLimit, rawLimit * 2);
    }

    let truncated = allHeads.length > previewCount || offset > 0;
    return {
      heads: allHeads.slice(-previewCount).map(projectClientFrameForWindow),
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

// The HTTP frame window is display state, not model memory. Completed thinking
// traces, per-response tool result copies, compaction frame-id lists, and stored
// output previews are all large and either unused by the client or fetched
// lazily when a tool card is expanded. Keep them in raw windows (model/context
// callers) and in SSE frames; only trim the projected client window.
export function projectClientFrameForWindow(frame) {
  let content = frame?.content;
  if (!content || typeof content !== 'object' || Array.isArray(content))
    return frame;

  let next = { ...content };
  let changed = false;

  if (frame.type === 'AgentMessage' && content.status !== 'streaming') {
    if ('thinking' in next) {
      delete next.thinking;
      changed = true;
    }
    if ('toolResults' in next) {
      delete next.toolResults;
      changed = true;
    }
  }

  if (frame.type === 'CompactionFrame' && Array.isArray(next.frameIDs)) {
    delete next.frameIDs;
    changed = true;
  }

  if (next.toolOutputID && typeof next.preview === 'string') {
    delete next.preview;
    changed = true;
  }

  return changed ? { ...frame, content: next } : frame;
}
