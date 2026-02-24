'use strict';

export class IntegrityChecker {
  static check(frameManager) {
    let errors = [];

    IntegrityChecker._checkParentReferences(frameManager, errors);
    IntegrityChecker._checkPointerChains(frameManager, errors);
    IntegrityChecker._checkOrphanedPointers(frameManager, errors);
    IntegrityChecker._checkOrderMonotonicity(frameManager, errors);
    IntegrityChecker._checkDuplicateIds(frameManager, errors);
    IntegrityChecker._checkChildrenConsistency(frameManager, errors);

    return { valid: errors.length === 0, errors };
  }

  static assertValid(frameManager) {
    let result = IntegrityChecker.check(frameManager);

    if (!result.valid)
      throw new Error('IntegrityChecker failed:\n' + result.errors.join('\n'));
  }

  /**
   * All parentId references point to existing frames (or are null)
   */
  static _checkParentReferences(frameManager, errors) {
    let allFrames = frameManager._store.frames.get();
    let frameIds  = Object.keys(allFrames);

    for (let i = 0; i < frameIds.length; i++) {
      let frame = allFrames[frameIds[i]];

      if (frame.parentId && !allFrames[frame.parentId])
        errors.push(`Frame "${frame.id}" has parentId "${frame.parentId}" which does not exist in the frame index`);
    }
  }

  /**
   * Every FramePointer chain is valid (no broken links, no cycles, consistent head/tail)
   */
  static _checkPointerChains(frameManager, errors) {
    let state    = frameManager._store.getState();
    let pointers = state.pointers;
    let frameIds = Object.keys(pointers);

    for (let i = 0; i < frameIds.length; i++) {
      let frameId = frameIds[i];
      let pointer = pointers[frameId];

      if (!pointer) {
        errors.push(`Pointer for frame "${frameId}" is null/undefined`);
        continue;
      }

      // Walk forward from stored pointer
      let visited = new Set();
      let current = pointer;
      let last    = null;

      while (current) {
        if (visited.has(current)) {
          errors.push(`Cycle detected in pointer chain for frame "${frameId}" (forward walk)`);
          break;
        }

        visited.add(current);

        if (!current.frame)
          errors.push(`Pointer node in chain for frame "${frameId}" has null frame`);

        last    = current;
        current = current.next;
      }

      // Forward walk should reach head
      if (last && last !== pointer.head)
        errors.push(`Forward walk for frame "${frameId}" did not reach head`);

      // Walk backward from head
      let visitedReverse = new Set();
      current = pointer.head;
      let first = null;

      while (current) {
        if (visitedReverse.has(current)) {
          errors.push(`Cycle detected in pointer chain for frame "${frameId}" (backward walk)`);
          break;
        }

        visitedReverse.add(current);
        first   = current;
        current = current.previous;
      }

      // Backward walk should reach stored pointer
      if (first && first !== pointer)
        errors.push(`Backward walk for frame "${frameId}" did not reach stored pointer`);
    }
  }

  /**
   * No orphaned FramePointers (pointer exists but referenced frame doesn't exist in frame index)
   */
  static _checkOrphanedPointers(frameManager, errors) {
    let state     = frameManager._store.getState();
    let pointers  = state.pointers;
    let allFrames = state.frames;
    let frameIds  = Object.keys(pointers);

    for (let i = 0; i < frameIds.length; i++) {
      let frameId = frameIds[i];

      if (!allFrames[frameId])
        errors.push(`Pointer exists for frame "${frameId}" but no corresponding frame in the index`);
    }
  }

  /**
   * Order values are monotonically increasing for frames with same parentId
   */
  static _checkOrderMonotonicity(frameManager, errors) {
    let state       = frameManager._store.getState();
    let childrenMap = state.children;
    let allFrames   = state.frames;
    let parentIds   = Object.keys(childrenMap);

    for (let i = 0; i < parentIds.length; i++) {
      let parentId = parentIds[i];
      let childIds = childrenMap[parentId];

      if (!childIds || childIds.length < 2)
        continue;

      let lastOrder = -Infinity;

      for (let j = 0; j < childIds.length; j++) {
        let childFrame = allFrames[childIds[j]];

        if (!childFrame)
          continue;

        if (childFrame.order <= lastOrder)
          errors.push(`Order not monotonically increasing for children of "${parentId}": frame "${childIds[j]}" has order ${childFrame.order} but previous was ${lastOrder}`);

        lastOrder = childFrame.order;
      }
    }
  }

  /**
   * No duplicate IDs in the frame index
   * (Object keys are unique by nature, but we verify the frames store is consistent)
   */
  static _checkDuplicateIds(frameManager, errors) {
    let allFrames = frameManager._store.frames.get();
    let frameIds  = Object.keys(allFrames);
    let seen      = new Set();

    for (let i = 0; i < frameIds.length; i++) {
      let id = frameIds[i];

      if (seen.has(id))
        errors.push(`Duplicate frame ID detected: "${id}"`);

      seen.add(id);

      // Also verify the key matches the frame's actual id
      let frame = allFrames[id];

      if (frame && frame.id !== id)
        errors.push(`Frame stored under key "${id}" has mismatched id "${frame.id}"`);
    }
  }

  /**
   * Children lists are consistent with parentId references
   */
  static _checkChildrenConsistency(frameManager, errors) {
    let state       = frameManager._store.getState();
    let allFrames   = state.frames;
    let childrenMap = state.children;
    let frameIds    = Object.keys(allFrames);

    // Build a set of all child relationships from the children index
    let indexedChildren = new Map();
    let parentIds       = Object.keys(childrenMap);

    for (let i = 0; i < parentIds.length; i++) {
      let parentId = parentIds[i];
      let childIds = childrenMap[parentId];

      for (let j = 0; j < childIds.length; j++)
        indexedChildren.set(childIds[j], parentId);
    }

    // Every frame with a parentId should appear in the children index
    for (let i = 0; i < frameIds.length; i++) {
      let frame = allFrames[frameIds[i]];

      if (frame.parentId) {
        let indexedParent = indexedChildren.get(frame.id);

        if (!indexedParent)
          errors.push(`Frame "${frame.id}" has parentId "${frame.parentId}" but is not in the children index`);
        else if (indexedParent !== frame.parentId)
          errors.push(`Frame "${frame.id}" has parentId "${frame.parentId}" but children index lists it under "${indexedParent}"`);
      }
    }

    // Every entry in the children index should reference an existing frame
    for (let i = 0; i < parentIds.length; i++) {
      let parentId = parentIds[i];
      let childIds = childrenMap[parentId];

      for (let j = 0; j < childIds.length; j++) {
        let childId = childIds[j];

        if (!allFrames[childId])
          errors.push(`Children index for "${parentId}" references frame "${childId}" which does not exist`);
      }
    }
  }
}
