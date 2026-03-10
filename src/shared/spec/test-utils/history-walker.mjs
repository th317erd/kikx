'use strict';

export class HistoryWalker {
  /**
   * Walk from the first version (oldest) to the most recent (head).
   * Returns an array of Frame objects in chronological order.
   */
  static walk(frameManager, frameID) {
    let pointer = frameManager._pointers.get(frameID);

    if (!pointer)
      return [];

    // The stored pointer IS the first node in the chain.
    // Walk forward via `next` from the stored pointer itself.
    let frames  = [];
    let current = pointer;

    while (current) {
      frames.push(current.frame);
      current = current.next;
    }

    return frames;
  }

  /**
   * Walk from head (most recent) to the first version (oldest).
   * Returns an array of Frame objects in reverse chronological order.
   */
  static walkReverse(frameManager, frameID) {
    let pointer = frameManager._pointers.get(frameID);

    if (!pointer)
      return [];

    // pointer.head is the most recent node
    let frames  = [];
    let current = pointer.head;

    while (current) {
      frames.push(current.frame);
      current = current.previous;
    }

    return frames;
  }

  static assertChainLength(frameManager, frameID, n) {
    let frames = HistoryWalker.walk(frameManager, frameID);

    if (frames.length !== n)
      throw new Error(`Expected chain length ${n} for frame "${frameID}", but got ${frames.length}`);
  }

  /**
   * Verify chain integrity:
   * - No broken links: walk forward from stored pointer reaches head
   * - Walk backward from head reaches stored pointer
   * - No cycles (via visited set)
   * - Every pointer node has a non-null frame
   */
  static assertChainIntegrity(frameManager, frameID) {
    let pointer = frameManager._pointers.get(frameID);

    if (!pointer)
      throw new Error(`No pointer found for frame "${frameID}"`);

    // Walk forward from stored pointer (first node)
    let visited = new Set();
    let current = pointer;
    let last    = null;

    while (current) {
      if (visited.has(current))
        throw new Error(`Cycle detected in chain for frame "${frameID}" (forward walk)`);

      visited.add(current);

      if (!current.frame)
        throw new Error(`Pointer node in chain for frame "${frameID}" has null frame`);

      last    = current;
      current = current.next;
    }

    // last should be the head
    if (last !== pointer.head)
      throw new Error(`Forward walk did not reach head for frame "${frameID}"`);

    // Walk backward from head
    let visitedReverse = new Set();
    current = pointer.head;
    let first = null;

    while (current) {
      if (visitedReverse.has(current))
        throw new Error(`Cycle detected in chain for frame "${frameID}" (backward walk)`);

      visitedReverse.add(current);

      if (!current.frame)
        throw new Error(`Pointer node in chain for frame "${frameID}" has null frame (backward walk)`);

      first   = current;
      current = current.previous;
    }

    // first should be the stored pointer (original node)
    if (first !== pointer)
      throw new Error(`Backward walk did not reach stored pointer for frame "${frameID}"`);

    // Both walks should visit the same number of nodes
    if (visited.size !== visitedReverse.size)
      throw new Error(`Forward walk visited ${visited.size} nodes but backward walk visited ${visitedReverse.size} for frame "${frameID}"`);
  }

  /**
   * Deep-check that HEAD frame's content matches expected (subset match).
   * Every key in `expected` must exist and match in the head frame's content.
   */
  static assertHeadContent(frameManager, frameID, expected) {
    let pointer = frameManager._pointers.get(frameID);

    if (!pointer)
      throw new Error(`No pointer found for frame "${frameID}"`);

    let headFrame = pointer.head.frame;
    let content   = headFrame.content;

    HistoryWalker._assertSubset(content, expected, `frame "${frameID}" head content`);
  }

  static _assertSubset(actual, expected, path) {
    let keys = Object.keys(expected);

    for (let i = 0; i < keys.length; i++) {
      let key      = keys[i];
      let expValue = expected[key];
      let actValue = actual ? actual[key] : undefined;
      let subPath  = `${path}.${key}`;

      if (expValue && typeof expValue === 'object' && !Array.isArray(expValue)) {
        if (!actValue || typeof actValue !== 'object')
          throw new Error(`Expected ${subPath} to be an object, got ${typeof actValue}`);

        HistoryWalker._assertSubset(actValue, expValue, subPath);
      } else if (Array.isArray(expValue)) {
        if (!Array.isArray(actValue))
          throw new Error(`Expected ${subPath} to be an array, got ${typeof actValue}`);

        if (JSON.stringify(actValue) !== JSON.stringify(expValue))
          throw new Error(`Expected ${subPath} to equal ${JSON.stringify(expValue)}, got ${JSON.stringify(actValue)}`);
      } else {
        if (actValue !== expValue)
          throw new Error(`Expected ${subPath} to be ${JSON.stringify(expValue)}, got ${JSON.stringify(actValue)}`);
      }
    }
  }

  /**
   * Returns { added, removed, changed } between two versions in the chain.
   * indexA and indexB are 0-based indices in the forward walk order (oldest first).
   */
  static diff(frameManager, frameID, indexA, indexB) {
    let frames = HistoryWalker.walk(frameManager, frameID);

    if (indexA < 0 || indexA >= frames.length)
      throw new RangeError(`indexA (${indexA}) out of range [0, ${frames.length - 1}]`);

    if (indexB < 0 || indexB >= frames.length)
      throw new RangeError(`indexB (${indexB}) out of range [0, ${frames.length - 1}]`);

    let contentA = frames[indexA].content || {};
    let contentB = frames[indexB].content || {};

    let keysA = new Set(Object.keys(contentA));
    let keysB = new Set(Object.keys(contentB));

    let added   = {};
    let removed = {};
    let changed = {};

    // Keys in B but not in A => added
    for (let key of keysB) {
      if (!keysA.has(key))
        added[key] = contentB[key];
    }

    // Keys in A but not in B => removed
    for (let key of keysA) {
      if (!keysB.has(key))
        removed[key] = contentA[key];
    }

    // Keys in both but different => changed
    for (let key of keysA) {
      if (!keysB.has(key))
        continue;

      if (JSON.stringify(contentA[key]) !== JSON.stringify(contentB[key]))
        changed[key] = { from: contentA[key], to: contentB[key] };
    }

    return { added, removed, changed };
  }
}
