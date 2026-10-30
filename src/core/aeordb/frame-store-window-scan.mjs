'use strict';

import { readJSONFiles } from './aeordb-file-utils.mjs';
import { createFrameLoadError } from './frame-store-errors.mjs';
import { frameOrderFromPath, sortFramePathsByOrder } from './frame-store-ordering.mjs';
import { encodeSegment } from './frame-store-paths.mjs';
import {
  countFilterMatches,
  frameMatchesWindowFilters,
  frameTypesForFilters,
  pathMatchesTypes,
} from '../../shared/frame-window-filters.mjs';

// ---------------------------------------------------------------------------
// Whole-session counts
// ---------------------------------------------------------------------------

// The popup's badges must describe the session, not the loaded page, and they
// must not cost a body read per frame. `countSessionFrames` walks the same
// unfiltered directory listing and classifies every path, which is the cheap
// half of the work: 17k paths is milliseconds, 17k bodies is seconds. See
// `countFilterMatches` for why the counts are not affected by the current
// selection and why one row comes back `null`.
const MAX_COUNT_SCAN_FRAMES = 200000;

// Paths per directory call. `listDirectoryPaths` clamps whatever it is asked
// for to `MAX_FRAME_LIST_LIMIT` (5000) *silently*, so asking for "everything"
// returns the first 5000 rows and looks like success. Counting through a single
// clamped call is how a 17,683-frame session was counted as 5,000 frames with
// `truncated: false` — a wrong number reported confidently, which is worse than
// no number. Paging explicitly and stopping on a short page keeps the count
// honest no matter how the clamp moves.
const COUNT_PAGE_SIZE = 1000;

export async function countSessionFrames(store, deps = {}) {
  let interactionsPath = deps.interactionsPath;
  let listOptions = deps.listOptions || { depth: -1, glob: '**/frames/*.json' };

  let probe;
  try {
    probe = await store.aeordb.listDirectory(interactionsPath, {
      ...listOptions,
      limit: 1,
      offset: 0,
    });
  } catch (error) {
    if (error?.status === 404)
      return { counts: countFilterMatches([]), total: 0, scanned: 0, truncated: false };

    throw error;
  }

  let total = Number(probe?.total);
  if (!Number.isFinite(total) || total < 0)
    total = 0;

  if (total === 0)
    return { counts: countFilterMatches([]), total: 0, scanned: 0, truncated: false };

  // We are told how many frames exist, so walk to the cap rather than guessing
  // from page sizes. Treating "a page came back shorter than requested" as the
  // end of the listing silently under-counts whenever the transport's own page
  // limit is below `COUNT_PAGE_SIZE`: every page looks like the last one, the
  // walk stops early, and the caller is handed a fraction of the session. The
  // loop below instead advances by what it actually received and stops only on
  // an empty page, the cap, or a page that told us nothing new -- all of which
  // terminate.
  let cap = Math.min(total, MAX_COUNT_SCAN_FRAMES);
  let paths = [];
  let seen = new Set();
  let cursor = 0;

  while (paths.length < cap) {
    let want = Math.min(COUNT_PAGE_SIZE, cap - paths.length);
    let page = await store.listDirectoryPaths(interactionsPath, {
      ...listOptions,
      limit: want,
      offset: cursor,
    });

    if (page.length === 0)
      break;

    cursor += page.length;

    let before = paths.length;
    for (let path of page) {
      if (seen.has(path))
        continue;

      seen.add(path);
      paths.push(path);
    }

    if (paths.length === before)
      break;
  }

  let framePaths = paths.filter((path) => String(path).includes('/frames/'));

  return {
    counts: countFilterMatches(framePaths),
    total,
    scanned: framePaths.length,
    // Honest truncation: true whenever the counts describe fewer frames than
    // the session holds, whether that is the explicit cap or a page that came
    // back short. Reporting `false` here after stopping on a short page would
    // let an incomplete count pass as a complete one.
    truncated: paths.length < total,
  };
}

// ---------------------------------------------------------------------------
// Filtered windows
// ---------------------------------------------------------------------------

// A filtered window is a different question from a raw one. Matches are not
// contiguous, so a fixed slice of raw rows can come back empty while thousands
// of matches sit just below it. This walk therefore pages the *paths* (never
// bodies) and rejects from the filename everything it can already disprove, so
// a `Hidden`-only search costs one directory walk instead of 17k body reads.
//
// Two directions, because the two questions differ:
//
//   - A plain window wants the NEWEST matches, exactly as the raw window wants
//     the newest rows, and pages backwards from there. It is walked from the
//     end of the listing towards the start.
//   - An anchored window (`start`) wants the matches *at or after* that frame,
//     so it walks forward from the anchor.
//
// In both cases the result is returned ascending, and the walk collects one
// match more than asked for so `hasMore` can describe older MATCHES rather than
// older rows.

const FILTERED_PAGE_SIZE = 1000;
const MAX_FILTERED_SCAN_FRAMES = 200000;
const DEFAULT_FILTERED_LIMIT = 100;

export async function listFilteredFrameWindow(store, sessionID, options = {}, deps = {}) {
  if (typeof sessionID !== 'string' || sessionID.trim() === '')
    throw new TypeError('listFilteredFrameWindow() requires sessionID');

  let interactionsPath = deps.interactionsPath;
  let project = typeof deps.project === 'function' ? deps.project : (frames) => frames;
  let listOptions = deps.listOptions || { depth: -1, glob: '**/frames/*.json' };
  let filters = options.filters;
  let query = options.query;
  let limit = normalizeLimit(options.limit);
  let before = normalizeOptionalOrder(options.before);
  let after = normalizeOptionalOrder(options.after);
  let startID = typeof options.start === 'string' ? options.start.trim() : '';

  let probe = await store.aeordb.listDirectory(interactionsPath, {
    ...listOptions,
    limit: 1,
    offset: 0,
  });

  let total = Number(probe?.total);
  if (!Number.isFinite(total) || total < 0)
    total = 0;

  let empty = {
    frames: [],
    total,
    hasMore: false,
    exhausted: true,
    truncated: false,
    oldestOrder: null,
    newestOrder: null,
    filtered: true,
  };

  if (total === 0)
    return empty;

  let types = frameTypesForFilters(filters);
  // An empty type list admits nothing: answer without touching a single body.
  if (Array.isArray(types) && types.length === 0)
    return empty;

  let startFound = false;
  let anchorOrder = null;
  if (startID !== '') {
    let anchorPath = await findFramePathByID(store, interactionsPath, startID, listOptions, total);
    if (anchorPath) {
      startFound = true;
      anchorOrder = frameOrderFromPath(anchorPath);
    }
  }

  let cap = Math.min(total, MAX_FILTERED_SCAN_FRAMES);
  let matches = [];
  let exhausted = false;

  // Page a window of the raw listing, descending: `[from, to)` in raw order.
  let hydrate = async (paths) => {
    if (paths.length === 0)
      return;

    // This is the only walk that hydrates bodies, so it is the only place a
    // single malformed document can reach the caller. It must not fail the
    // page: one unparseable frame used to turn a whole session's thread into an
    // HTTP 500 while every other frame on that page was readable.
    let reads = await readJSONFiles(store.aeordb, paths, {
      fallbackOnBatchError: true,
      continueOnError: true,
    });
    for (let read of reads) {
      if (read?.error) {
        // Never silently drop a frame. A body that could not be read becomes a
        // visible load-error at the order its filename implies, so the thread
        // says a frame is unreadable instead of letting a message vanish. The
        // filter predicate is deliberately not consulted: this is a marker
        // about the read, not content the user filtered on, and hiding it
        // would recreate the silence this branch exists to prevent.
        matches.push(createFrameLoadError(sessionID, read.path, read.error));
        if (matches.length > limit)
          return;
        continue;
      }

      let frame = read?.value;
      if (!frameMatchesWindowFilters(frame, filters, query))
        continue;

      matches.push(frame);
      if (matches.length > limit)
        return;
    }
  };

  if (anchorOrder != null) {
    // Anchored: forward from the anchor, oldest match first.
    let cursor = 0;
    while (cursor < cap && matches.length <= limit) {
      let want = Math.min(FILTERED_PAGE_SIZE, cap - cursor);
      let page = await store.listDirectoryPaths(interactionsPath, {
        ...listOptions,
        limit: want,
        offset: cursor,
      });

      if (page.length === 0) {
        exhausted = true;
        break;
      }

      cursor += page.length;

      let candidatePaths = [];
      for (let path of sortFramePathsByOrder(framesOnly(page))) {
        let order = frameOrderFromPath(path);
        if (order < anchorOrder)
          continue;
        if (before != null && order >= before)
          continue;
        if (after != null && order <= after)
          continue;
        if (!pathMatchesTypes(path, types))
          continue;

        candidatePaths.push(path);
      }

      await hydrate(candidatePaths);
      if (page.length < want)
        exhausted = true;
    }
  } else {
    // Plain: newest matches first, walking backwards from the end.
    let end = cap;
    while (end > 0 && matches.length <= limit) {
      let from = Math.max(0, end - FILTERED_PAGE_SIZE);
      let want = end - from;
      let page = await store.listDirectoryPaths(interactionsPath, {
        ...listOptions,
        limit: want,
        offset: from,
      });

      if (page.length === 0) {
        exhausted = true;
        break;
      }

      // Newest-first within the page, so an early break keeps the newest.
      let descending = sortFramePathsByOrder(framesOnly(page)).reverse();
      let candidatePaths = [];
      for (let path of descending) {
        let order = frameOrderFromPath(path);
        if (before != null && order >= before)
          continue;
        if (after != null && order <= after)
          continue;
        if (!pathMatchesTypes(path, types))
          continue;

        candidatePaths.push(path);
      }

      await hydrate(candidatePaths);
      end = from;
      if (page.length < want)
        exhausted = true;
    }
  }

  let hasMore = matches.length > limit;

  // Nothing left to offer means the walk is over, whether or not any page came
  // back short: a filter that matches nothing drains every page in full and so
  // would report `exhausted: false` forever, which reads to a pager as "keep
  // asking" and turns an empty result into an endless one.
  if (!hasMore)
    exhausted = true;

  let selected = hasMore ? matches.slice(0, limit) : matches;
  let orders = selected.map((frame) => Number(frame?.order));
  let ascending = [ ...selected ].sort((left, right) => (
    (Number(left?.order) || 0) - (Number(right?.order) || 0)
  ));

  let output = await project(ascending);

  return {
    frames: output,
    total,
    // `hasMore` is only meaningful for backward paging; an anchored load is
    // bounded by the anchor, and everything above it has been offered.
    hasMore: hasMore && anchorOrder == null,
    exhausted: exhausted && !hasMore,
    // Truncation means the scan cap stopped us while the listing still held
    // unread rows. It is deliberately not `!exhausted`: a filter that matches
    // nothing leaves the listing partly unread, but nothing was withheld from
    // the caller, so flagging that as truncated would report an empty result as
    // incomplete every time it legitimately matched nothing.
    truncated: cap < total && !hasMore,
    oldestOrder: orders.length > 0 ? Math.min(...orders) : null,
    newestOrder: orders.length > 0 ? Math.max(...orders) : null,
    filtered: true,
    ...(startID !== '' ? { startFound } : {}),
  };
}

function framesOnly(page) {
  return page.filter((entry) => String(entry).includes('/frames/'));
}

async function findFramePathByID(store, interactionsPath, frameID, listOptions, total) {
  let suffix = `-${encodeSegment(frameID)}.json`;

  // Prefer a targeted filename lookup; the fallback below exists for drivers
  // whose directory glob implementation cannot filter a suffix.
  let direct = await store.listDirectoryPaths(interactionsPath, {
    ...listOptions,
    glob: `**/frames/*${suffix}`,
    limit: 1,
    offset: 0,
  });
  if (direct.length > 0 && String(direct[0]).endsWith(suffix))
    return direct[0];

  let cursor = 0;
  let cap = Math.min(total, MAX_FILTERED_SCAN_FRAMES);

  while (cursor < cap) {
    let want = Math.min(COUNT_PAGE_SIZE, cap - cursor);
    let page = await store.listDirectoryPaths(interactionsPath, {
      ...listOptions,
      limit: want,
      offset: cursor,
    });

    if (page.length === 0)
      return null;

    let found = page.find((path) => String(path).endsWith(suffix));
    if (found)
      return found;

    cursor += page.length;
    if (page.length < want)
      return null;
  }

  return null;
}

function normalizeLimit(value) {
  let limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0)
    return DEFAULT_FILTERED_LIMIT;

  return Math.min(Math.floor(limit), MAX_FILTERED_SCAN_FRAMES);
}

function normalizeOptionalOrder(value) {
  if (value == null || value === '')
    return null;

  let order = Number(value);
  return Number.isFinite(order) ? order : null;
}
