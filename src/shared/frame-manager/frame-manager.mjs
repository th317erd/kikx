'use strict';

import { EventEmitter } from '../lib/event-emitter.mjs';
import { deepMerge }    from './deep-merge.mjs';
import { Frame }        from './frame.mjs';
import { FramePointer } from './frame-pointer.mjs';

export class FrameManager {
  constructor(options = {}) {
    this.history           = options.history !== false;
    this._orderCounter     = 0;
    this._commitCounter    = 0;
    this._commitValidator  = options.commitValidator || null;
    this._registryVersion  = options.registryVersion || 0;

    this._frames   = new Map();   // frameID → Frame
    this._pointers = new Map();   // frameID → FramePointer
    this._children = new Map();   // parentID → [childIds]
    this._commits  = [];          // Ordered commit log (append-only)
    this._refs     = new Map();   // refName → commitOrder
    this._emitter  = new EventEmitter();

    this._emitter.setMaxListeners(Infinity);
  }

  merge(frames, options = {}) {
    if (!Array.isArray(frames))
      throw new TypeError('FrameManager.merge() requires an array of frames');

    if (frames.length === 0)
      return [];

    let suppressEvents  = options.events === false;
    let hasValidator     = !!this._commitValidator;
    let results          = [];
    let changes          = [];

    // ── Event buffering ──
    // When a commit validator is present, buffer events so they can be
    // suppressed on rejection. Otherwise emit directly (or swallow if
    // suppressEvents is true).
    let pendingEvents = [];
    let emit;

    if (hasValidator)
      emit = (event, data) => pendingEvents.push([event, data]);
    else if (suppressEvents)
      emit = () => {};
    else
      emit = (event, data) => this._emitter.emit(event, data);

    // ── Rollback snapshot ──
    // Only captured when a validator is present so the common path has
    // zero overhead. Saves enough state to fully undo the merge loop.
    let snapshot = hasValidator ? this._takeSnapshot() : null;

    for (let i = 0; i < frames.length; i++) {
      let frameData = frames[i];

      // Silently skip frames without id or type
      if (!frameData.id || !frameData.type)
        continue;

      frameData.order     = ++this._orderCounter;
      frameData.timestamp = frameData.timestamp || Date.now();

      // Propagate signature from merge options if not already set on frameData
      if (options.signature && !frameData.signature)
        frameData.signature = options.signature;

      let frame = new Frame(frameData);

      // ── Phantom frame handling ──
      // Phantom frames are fire-and-forget; they are NEVER stored.
      if (frame.phantom) {
        if (frame.groupID) {
          // Phantom WITH groupID → collapse into a persistent group frame
          let existingGroup = this.get(frame.groupID);

          if (existingGroup) {
            // groupType conflict check
            if (frame.groupType && frame.groupType !== existingGroup.type) {
              // eslint-disable-next-line no-console
              console.warn(
                `FrameManager: phantom groupType "${frame.groupType}" conflicts with ` +
                `existing group frame type "${existingGroup.type}" (groupID: ${frame.groupID}). Skipping.`,
              );
              continue;
            }

            // Subsequent phantom → deep-merge content into existing group frame
            let previousHead = this.getHead(frame.groupID);

            let mergedGroup = new Frame({
              ...existingGroup,
              content:   deepMerge(existingGroup.content, frame.content),
              updatedAt: Date.now(),
            });

            this._frames.set(mergedGroup.id, mergedGroup);
            changes.push({ frameID: frame.groupID, operation: 'update' });

            if (this.history) {
              let existingPointer = this._pointers.get(frame.groupID);
              let currentHead     = existingPointer ? existingPointer.head : null;
              let newPointer      = new FramePointer(mergedGroup, currentHead);

              newPointer.updateHead(newPointer);

              let oldest = newPointer;
              while (oldest.previous)
                oldest = oldest.previous;

              let walker = oldest;
              while (walker) {
                walker.tail = oldest;
                walker      = walker.next;
              }

              this._pointers.set(frame.groupID, existingPointer);
            } else {
              let existingPointer = this._pointers.get(frame.groupID);

              if (existingPointer)
                existingPointer.frame = mergedGroup;
            }

            emit('frame:updated', { frame: mergedGroup, previousHead });
            emit(`frame:updated:${frame.groupID}`, { frame: mergedGroup, previousHead });

            results.push(mergedGroup);
          } else {
            // First phantom for this group → create a new persistent group frame
            let groupFrame = new Frame({
              id:        frame.groupID,
              type:      frame.groupType || frame.type,
              content:   frame.content,
              phantom:   false,
              parentID:  frame.parentID,
              hidden:    true,
              deleted:   false,
              order:     ++this._orderCounter,
              timestamp: Date.now(),
            });

            let groupPointer = new FramePointer(groupFrame);

            this._frames.set(groupFrame.id, groupFrame);
            this._pointers.set(groupFrame.id, groupPointer);
            changes.push({ frameID: groupFrame.id, operation: 'create' });

            if (groupFrame.parentID) {
              let children = this._children.get(groupFrame.parentID);

              if (children)
                children.push(groupFrame.id);
              else
                this._children.set(groupFrame.parentID, [groupFrame.id]);
            }

            emit('frame:added', { frame: groupFrame });
            emit(`frame:added:${groupFrame.id}`, { frame: groupFrame });

            results.push(groupFrame);
          }
        } else {
          // Phantom WITHOUT groupID → standalone ephemeral, transient event only
          emit('frame:phantom', { frame });
          emit(`frame:phantom:${frame.id}`, { frame });
        }

        continue;
      }

      // ── Normal (non-phantom) frame handling ──
      let pointer = new FramePointer(frame);

      // Always store the source frame in the index
      this._frames.set(frame.id, frame);
      this._pointers.set(frame.id, pointer);
      changes.push({ frameID: frame.id, operation: 'create' });

      if (frame.parentID) {
        let children = this._children.get(frame.parentID);

        if (children)
          children.push(frame.id);
        else
          this._children.set(frame.parentID, [frame.id]);
      }

      results.push(frame);

      // Target-based merge logic
      if (frame.targets && frame.targets.length > 0) {
        let seen = new Set();

        for (let t = 0; t < frame.targets.length; t++) {
          let targetID = frame.targets[t];

          // Skip self-referencing targets
          if (targetID === frame.id)
            continue;

          // Deduplicate targets
          if (seen.has(targetID))
            continue;

          seen.add(targetID);

          let targetFrame = this.get(targetID);

          // Skip non-existent targets
          if (!targetFrame)
            continue;

          let previousHead = this.getHead(targetID);

          let mergedFrame = new Frame({
            ...targetFrame,
            content:   deepMerge(targetFrame.content, frame.content),
            hidden:    frame.hidden,
            deleted:   frame.deleted,
            updatedAt: frame.updatedAt,
          });

          this._frames.set(mergedFrame.id, mergedFrame);
          changes.push({ frameID: targetID, operation: 'update' });

          if (this.history) {
            let existingPointer = this._pointers.get(targetID);
            let currentHead     = existingPointer ? existingPointer.head : null;
            let newPointer      = new FramePointer(mergedFrame, currentHead);

            // Constructor sets head = oldest (first node). We need head = newest for getHead().
            newPointer.updateHead(newPointer);

            // Fix tail on all nodes to point to the oldest (first) node for getVersionHistory().
            let oldest = newPointer;
            while (oldest.previous)
              oldest = oldest.previous;

            let walker = oldest;
            while (walker) {
              walker.tail = oldest;
              walker      = walker.next;
            }

            this._pointers.set(targetID, existingPointer);
          } else {
            let existingPointer = this._pointers.get(targetID);

            if (existingPointer)
              existingPointer.frame = mergedFrame;
          }

          emit('frame:updated', { frame: mergedFrame, previousHead });
          emit(`frame:updated:${targetID}`, { frame: mergedFrame, previousHead });

          results.push(mergedFrame);
        }

        // Frame with targets is not a new addition; skip frame:added
      } else if (!frame.phantom) {
        // New frame (no targets, not phantom): emit frame:added
        emit('frame:added', { frame });
        emit(`frame:added:${frame.id}`, { frame });
      }
    }

    // Create commit if any frames were affected
    if (changes.length > 0) {
      let previousCommit = this._commits.length > 0
        ? this._commits[this._commits.length - 1]
        : null;

      let commit = {
        order:       ++this._commitCounter,
        changes,
        authorType:  options.authorType || 'system',
        authorID:    (options.authorID !== undefined) ? options.authorID : null,
        timestamp:   Date.now(),
        parentOrder: previousCommit ? previousCommit.order : null,
        silent:      !!options.silent,
      };

      // ── Commit validator gate ──
      if (hasValidator) {
        let actorContext = {
          authorType: commit.authorType,
          authorID:   commit.authorID,
        };

        let validation = this._commitValidator(commit, results, actorContext);

        if (!validation.allowed) {
          this._restoreSnapshot(snapshot);
          this._emitter.emit('commit:rejected', {
            reason: validation.reason,
            commit,
          });
          return [];
        }
      }

      this._commits.push(commit);
      this._emitter.emit('commit', { commit });

      // Auto-advance heads/main
      let previousMain = this._refs.get('heads/main');

      if (previousMain !== undefined) {
        this._refs.set('heads/main', commit.order);
        this._emitter.emit('ref:updated', {
          name:          'heads/main',
          previousOrder: previousMain,
          newOrder:       commit.order,
        });
      } else {
        this._refs.set('heads/main', commit.order);
        this._emitter.emit('ref:created', {
          name:        'heads/main',
          commitOrder: commit.order,
        });
      }

      // Flush buffered events (validator path)
      if (hasValidator && !suppressEvents) {
        for (let j = 0; j < pendingEvents.length; j++)
          this._emitter.emit(pendingEvents[j][0], pendingEvents[j][1]);
      }
    }

    if (suppressEvents)
      this._emitter.emit('frames:bulk-loaded', { count: results.length });

    return results;
  }

  get(frameID) {
    return this._frames.get(frameID);
  }

  getHead(frameID) {
    if (!this.history)
      return this.get(frameID);

    let pointer = this._pointers.get(frameID);

    if (!pointer)
      return undefined;

    return pointer.head.frame;
  }

  getChildren(parentID) {
    let childIds = this._children.get(parentID) || [];

    if (childIds.length === 0)
      return [];

    let children = [];
    for (let i = 0; i < childIds.length; i++) {
      let frame = this.getHead(childIds[i]);
      if (frame)
        children.push(frame);
    }

    children.sort((a, b) => a.order - b.order);

    return children;
  }

  toArray() {
    let heads = [];
    let seen  = new Set();

    for (let [frameID] of this._frames) {
      let head = this.getHead(frameID);

      if (head && !seen.has(head.id)) {
        seen.add(head.id);
        heads.push(head);
      }
    }

    heads.sort((a, b) => a.order - b.order);

    return heads;
  }

  [Symbol.iterator]() {
    let frames = this.toArray();
    let index  = 0;

    return {
      next() {
        if (index < frames.length)
          return { value: frames[index++], done: false };

        return { done: true };
      },
    };
  }

  setProcessed(frameID, fingerprint) {
    let frame = this.get(frameID);

    if (!frame)
      return;

    let updatedFrame = new Frame({
      ...frame,
      processed:   fingerprint,
      processedAt: Date.now(),
    });

    this._frames.set(frameID, updatedFrame);

    // Update the pointer's frame reference
    let pointer = this._pointers.get(frameID);
    if (pointer) {
      if (this.history)
        pointer.head.frame = updatedFrame;
      else
        pointer.frame = updatedFrame;
    }

    this._emitter.emit('frame:processed', { frame: updatedFrame });
    this._emitter.emit(`frame:processed:${frameID}`, { frame: updatedFrame });
  }

  onFrameEvent(eventType, frameID, callback) {
    this._emitter.on(`${eventType}:${frameID}`, callback);
  }

  offFrameEvent(eventType, frameID, callback) {
    this._emitter.removeListener(`${eventType}:${frameID}`, callback);
  }

  on(event, listener) {
    this._emitter.on(event, listener);
    return this;
  }

  off(event, listener) {
    this._emitter.removeListener(event, listener);
    return this;
  }

  removeAllListeners(event) {
    this._emitter.removeAllListeners(event);
    return this;
  }

  emit(event, data) {
    this._emitter.emit(event, data);
    return this;
  }

  getVersionHistory(frameID) {
    let pointer = this._pointers.get(frameID);

    if (!pointer)
      return [];

    if (!this.history)
      return [pointer.frame];

    // Walk from tail to head
    let history = [];
    let current = pointer.tail;

    while (current) {
      history.push(current.frame);
      current = current.next;
    }

    return history;
  }

  // ---------------------------------------------------------------------------
  // Snapshot / rollback (used by commit validator)
  // ---------------------------------------------------------------------------

  _takeSnapshot() {
    let snap = {
      orderCounter:  this._orderCounter,
      commitCounter: this._commitCounter,
      frames:        new Map(this._frames),
      pointerKeys:   new Set(this._pointers.keys()),
      pointerChains: new Map(),
      children:      new Map(),
    };

    // Deep-copy children arrays (they get mutated via push())
    for (let [k, v] of this._children)
      snap.children.set(k, [...v]);

    // Save pointer chain state for existing pointers (nodes get mutated in-place)
    for (let [id, ptr] of this._pointers) {
      let chain = [];
      let node  = ptr;

      // Walk to tail
      while (node.previous)
        node = node.previous;

      // Walk from tail to head, saving each node's link properties
      while (node) {
        chain.push({
          node,
          frame:    node.frame,
          head:     node.head,
          tail:     node.tail,
          next:     node.next,
          previous: node.previous,
        });
        node = node.next;
      }

      snap.pointerChains.set(id, chain);
    }

    return snap;
  }

  _restoreSnapshot(snap) {
    this._orderCounter  = snap.orderCounter;
    this._commitCounter = snap.commitCounter;
    this._frames        = snap.frames;
    this._children      = snap.children;

    // Delete pointer entries that were added during the merge
    for (let id of this._pointers.keys()) {
      if (!snap.pointerKeys.has(id))
        this._pointers.delete(id);
    }

    // Restore pointer chain node state for pre-existing pointers
    for (let [, chain] of snap.pointerChains) {
      for (let entry of chain) {
        entry.node.frame    = entry.frame;
        entry.node.head     = entry.head;
        entry.node.tail     = entry.tail;
        entry.node.next     = entry.next;
        entry.node.previous = entry.previous;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Order counter synchronization
  // ---------------------------------------------------------------------------
  // After loading frames from a database, the FrameManager's _orderCounter may
  // be lower than the max order in the DB (due to merge reassigning orders
  // sequentially). Call this to ensure new frames get orders above existing DB
  // entries.
  // ---------------------------------------------------------------------------

  syncOrderCounter(minOrder) {
    if (minOrder > this._orderCounter)
      this._orderCounter = minOrder;
  }

  // ---------------------------------------------------------------------------
  // Registry version tracking (hot reload detection)
  // ---------------------------------------------------------------------------

  get registryVersion() { return this._registryVersion; }

  setRegistryVersion(version) {
    this._registryVersion = version;
  }

  isRegistryStale(currentVersion) {
    return this._registryVersion !== currentVersion;
  }

  // ---------------------------------------------------------------------------
  // Commit log operations
  // ---------------------------------------------------------------------------

  getCommit(order) {
    return this._commits.find((c) => c.order === order);
  }

  getCommits(fromOrder, toOrder) {
    let results = [];

    for (let i = 0; i < this._commits.length; i++) {
      let commit = this._commits[i];

      if (commit.order <= fromOrder)
        continue;

      if (commit.order > toOrder)
        break;

      results.push(commit);
    }

    return results;
  }

  getLatestCommit() {
    return (this._commits.length > 0)
      ? this._commits[this._commits.length - 1]
      : undefined;
  }

  // ---------------------------------------------------------------------------
  // Ref operations
  // ---------------------------------------------------------------------------

  getRef(name) {
    return this._refs.get(name);
  }

  createRef(name, commitOrder) {
    let commit = this.getCommit(commitOrder);

    if (!commit)
      throw new Error(`Commit order ${commitOrder} does not exist`);

    this._refs.set(name, commitOrder);

    this._emitter.emit('ref:created', { name, commitOrder });

    return commitOrder;
  }

  updateRef(name, commitOrder) {
    let previousOrder = this._refs.get(name);

    if (previousOrder === undefined)
      throw new Error(`Ref "${name}" does not exist`);

    let commit = this.getCommit(commitOrder);

    if (!commit)
      throw new Error(`Commit order ${commitOrder} does not exist`);

    this._refs.set(name, commitOrder);

    this._emitter.emit('ref:updated', { name, previousOrder, newOrder: commitOrder });

    return commitOrder;
  }

  deleteRef(name) {
    let existed = this._refs.delete(name);

    if (existed)
      this._emitter.emit('ref:deleted', { name });

    return existed;
  }

  listRefs(prefix) {
    if (!prefix)
      return new Map(this._refs);

    let filtered = new Map();

    for (let [name, order] of this._refs) {
      if (name.startsWith(prefix))
        filtered.set(name, order);
    }

    return filtered;
  }

  // ---------------------------------------------------------------------------
  // Diff operations
  // ---------------------------------------------------------------------------

  _resolveOrder(orderOrRef) {
    if (typeof orderOrRef === 'number')
      return orderOrRef;

    let order = this._refs.get(orderOrRef);

    if (order === undefined)
      throw new Error(`Ref "${orderOrRef}" not found`);

    return order;
  }

  diff(fromOrder, toOrder) {
    fromOrder = this._resolveOrder(fromOrder);
    toOrder   = this._resolveOrder(toOrder);

    if (fromOrder === toOrder)
      return [];

    let commits = this.getCommits(fromOrder, toOrder);

    if (commits.length === 0)
      return [];

    // Collect changes, deduplicating by frameID (first operation wins)
    let seen    = new Map();  // frameID → { operation }

    for (let i = 0; i < commits.length; i++) {
      let commit = commits[i];

      for (let j = 0; j < commit.changes.length; j++) {
        let change = commit.changes[j];

        if (!seen.has(change.frameID))
          seen.set(change.frameID, change.operation);
      }
    }

    let results = [];

    for (let [frameID, operation] of seen) {
      let frame = this.getHead(frameID);

      if (frame)
        results.push({ frameID, operation, frame });
    }

    return results;
  }

  diffFrames(fromOrder, toOrder) {
    let changes = this.diff(fromOrder, toOrder);
    return changes.map((c) => c.frame);
  }

  // ---------------------------------------------------------------------------
  // Window operations
  // ---------------------------------------------------------------------------

  loadWindow(frames) {
    return this.merge(frames, { events: false });
  }

  evict(belowOrder) {
    let count = 0;

    for (let [frameID, frame] of this._frames) {
      if (frame.order < belowOrder) {
        this._frames.delete(frameID);
        this._pointers.delete(frameID);
        this._children.delete(frameID);
        count++;
      }
    }

    return count;
  }

  getWindowBounds() {
    if (this._frames.size === 0)
      return { from: 0, to: 0 };

    let min = Infinity;
    let max = -Infinity;

    for (let [, frame] of this._frames) {
      if (frame.order < min) min = frame.order;
      if (frame.order > max) max = frame.order;
    }

    return { from: min, to: max };
  }
}
