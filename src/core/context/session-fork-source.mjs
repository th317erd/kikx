'use strict';

// Resolve the parent frames for a fork without hydrating a second live runtime.
//
// The common case is a coordinator forking its own current session. That engine
// is already in memory and is handed to tools as `services.frameEngine`. Calling
// `ensureSessionEntry(sourceID)` on that path was redundant and, when the parent
// runtime happened to be cold, synchronously hydrated its entire frame window
// before the tool could return. Prefer the engine already in hand; only read
// durable frames when the source is genuinely a different, unloaded session.
//
// This module is deliberately small and injectable so the no-hydration contract
// can be tested without a database.

export const MAX_FORK_PARENT_FRAMES = 20_000;
const FRAME_PAGE_SIZE = 500;

export async function resolveForkParentFrames({
  runtime,
  sourceSession,
  context = {},
  maxFrames = MAX_FORK_PARENT_FRAMES,
  pageSize = FRAME_PAGE_SIZE,
} = {}) {
  let sourceSessionID = normalizeID(sourceSession?.id);
  if (!sourceSessionID)
    return [];

  let limit = Number.isFinite(Number(maxFrames)) && Number(maxFrames) > 0
    ? Math.trunc(Number(maxFrames))
    : MAX_FORK_PARENT_FRAMES;

  // The running agent's own engine is the source of truth for its current
  // session. Do not ask the runtime for it again.
  let liveEngine = context.services?.frameEngine || context.frameEngine;
  let liveFrames = normalizeID(context.session?.id) === sourceSessionID ? engineFrames(liveEngine) : null;
  if (liveFrames !== null)
    return liveFrames;

  if (!runtime)
    throw new Error('session-create requires frameRuntime to resolve parent frames');

  // If the source is already cached, use its loaded engine. `loadFrames:false`
  // prevents this probe from turning a cold cache into a full hydration.
  if (typeof runtime.ensureSessionEntry === 'function') {
    let entry = await runtime.ensureSessionEntry(sourceSessionID, { loadFrames: false });
    // Real runtime entries are explicit: `framesLoaded:false` means the engine is
    // empty and the store is the only source. Legacy/fake entries omit the flag;
    // their engine is the source they returned, so use it rather than guessing.
    let loadedFrames = entry?.framesLoaded !== false ? engineFrames(entry?.frameEngine) : null;
    if (loadedFrames !== null)
      return loadedFrames;
  }

  let frameStore = runtime.frameStore;
  if (typeof frameStore?.listFrames !== 'function')
    throw new Error('session-create cannot fork: frame store does not expose listFrames(); set freshContext:true for an empty child');

  let pageLimit = Number.isFinite(Number(pageSize)) && Number(pageSize) > 0
    ? Math.trunc(Number(pageSize))
    : FRAME_PAGE_SIZE;
  return await listAllFrames(frameStore, sourceSessionID, limit, pageLimit);
}

async function listAllFrames(frameStore, sessionID, maxFrames, pageSize) {
  let frames = [];
  let offset = 0;

  for (;;) {
    let page = await frameStore.listFrames(sessionID, {
      limit: pageSize,
      offset,
    });

    if (!Array.isArray(page) || page.length === 0)
      break;

    frames.push(...page);
    offset += page.length;

    if (frames.length > maxFrames) {
      throw new Error(
        `session-create refuses to fork more than ${maxFrames} parent frames; `
        + 'set freshContext:true for an empty child or compact the parent first',
      );
    }

    if (page.length < pageSize)
      break;
  }

  return frames;
}

function engineFrames(engine) {
  if (typeof engine?.toArray === 'function')
    return engine.toArray();

  return Array.isArray(engine?.frames) ? engine.frames : null;
}

function normalizeID(value) {
  return typeof value === 'string' ? value.trim() : '';
}
