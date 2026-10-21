'use strict';

// Expansion state for message frames.
//
// Why this module exists: a frame's expanded/collapsed state used to live only
// in the DOM, as the `open` property of the native `<details>` disclosure that
// renders a compact frame. That is not durable. `kikx-frame-item._render()`
// discards its whole subtree (`$(this).empty()`) and rebuilds the disclosure
// from scratch, and a rebuild happens on ordinary, frequent events:
//
//   * the full app render path replacing the chat view wholesale,
//   * `syncFrames(..., { force: true })` after a merge/reload,
//   * a frame whose `type` changes while its `id` stays the same -- the very
//     common `ToolCall` -> `ToolResult` transition,
//   * any render-window change that materializes a frame item again.
//
// Every one of those recreated the disclosure in its default state, so a frame
// the user had opened snapped shut as soon as new activity arrived. The user
// cannot tell that apart from "the UI keeps collapsing my frame".
//
// The fix is to treat expansion as model state, keyed by frame id, and have the
// item re-apply it whenever it renders. A frame id is stable across the type
// change above, so keying by id keeps the row expanded through the transition
// rather than only through an unchanged-frame update.
//
// Scope and safety: this tracks only what this tab observed the user do. It
// never opens anything on its own -- `isFrameExpanded()` returns false for an id
// that was never expanded, so the default stays collapsed. Entries are bounded
// and evicted oldest-first, so a long-lived tab cannot grow this without limit.

export const MAX_TRACKED_FRAME_EXPANSIONS = 2000;

function normalizeFrameID(frameID) {
  if (frameID == null)
    return '';

  return String(frameID);
}

/**
 * Create an isolated expansion store.
 *
 * A Map (not a Set) is used so insertion order is retained and the oldest entry
 * can be evicted once the bound is reached. Re-expanding an existing id refreshes
 * its recency, which keeps the frames the user is actually looking at.
 */
export function createFrameExpansionStore(maxEntries = MAX_TRACKED_FRAME_EXPANSIONS) {
  let limit = Number.isInteger(maxEntries) && maxEntries > 0
    ? maxEntries
    : MAX_TRACKED_FRAME_EXPANSIONS;
  let expanded = new Map();

  return {
    get size() {
      return expanded.size;
    },

    maxEntries: limit,

    has(frameID) {
      return expanded.has(normalizeFrameID(frameID));
    },

    set(frameID, value) {
      let id = normalizeFrameID(frameID);
      if (!id)
        return false;

      if (value === true) {
        // Delete first so a re-expand moves the id to the newest position.
        if (expanded.has(id))
          expanded.delete(id);
        expanded.set(id, true);
        while (expanded.size > limit) {
          let oldest = expanded.keys().next();
          if (oldest.done)
            break;
          expanded.delete(oldest.value);
        }
        return true;
      }

      expanded.delete(id);
      return false;
    },

    toggle(frameID) {
      let id = normalizeFrameID(frameID);
      if (!id)
        return false;

      return this.set(id, !expanded.has(id));
    },

    clear() {
      expanded.clear();
    },

    keys() {
      return [ ...expanded.keys() ];
    },
  };
}

// The store the running client uses. It is module-level so it outlives any
// single chat view, frame item, or full shell rebuild -- which is the entire
// point: the DOM is rebuilt constantly, this is not.
export const frameExpansionStore = createFrameExpansionStore();

export function isFrameExpanded(frameID, store = frameExpansionStore) {
  return store.has(frameID);
}

export function setFrameExpanded(frameID, expanded, store = frameExpansionStore) {
  return store.set(frameID, expanded === true);
}

export function toggleFrameExpanded(frameID, store = frameExpansionStore) {
  return store.toggle(frameID);
}
