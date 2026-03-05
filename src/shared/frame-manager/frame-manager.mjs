'use strict';

import { EventEmitter } from 'node:events';
import { deepMerge }    from './deep-merge.mjs';
import { Frame }        from './frame.mjs';
import { FramePointer } from './frame-pointer.mjs';

export class FrameManager {
  constructor(options = {}) {
    this.history       = options.history !== false;
    this._orderCounter = 0;

    this._frames   = new Map();   // frameId → Frame
    this._pointers = new Map();   // frameId → FramePointer
    this._children = new Map();   // parentId → [childIds]
    this._emitter  = new EventEmitter();

    this._emitter.setMaxListeners(Infinity);
  }

  merge(frames, options = {}) {
    if (!Array.isArray(frames))
      throw new TypeError('FrameManager.merge() requires an array of frames');

    if (frames.length === 0)
      return [];

    let suppressEvents = options.events === false;
    let results        = [];

    for (let i = 0; i < frames.length; i++) {
      let frameData = frames[i];

      // Silently skip frames without id or type
      if (!frameData.id || !frameData.type)
        continue;

      frameData.order     = ++this._orderCounter;
      frameData.timestamp = frameData.timestamp || Date.now();

      let frame = new Frame(frameData);

      // ── Phantom frame handling ──
      // Phantom frames are fire-and-forget; they are NEVER stored.
      if (frame.phantom) {
        if (frame.groupId) {
          // Phantom WITH groupId → collapse into a persistent group frame
          let existingGroup = this.get(frame.groupId);

          if (existingGroup) {
            // groupType conflict check
            if (frame.groupType && frame.groupType !== existingGroup.type) {
              // eslint-disable-next-line no-console
              console.warn(
                `FrameManager: phantom groupType "${frame.groupType}" conflicts with ` +
                `existing group frame type "${existingGroup.type}" (groupId: ${frame.groupId}). Skipping.`,
              );
              continue;
            }

            // Subsequent phantom → deep-merge content into existing group frame
            let previousHead = this.getHead(frame.groupId);

            let mergedGroup = new Frame({
              ...existingGroup,
              content:   deepMerge(existingGroup.content, frame.content),
              updatedAt: Date.now(),
            });

            this._frames.set(mergedGroup.id, mergedGroup);

            if (this.history) {
              let existingPointer = this._pointers.get(frame.groupId);
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

              this._pointers.set(frame.groupId, existingPointer);
            } else {
              let existingPointer = this._pointers.get(frame.groupId);

              if (existingPointer)
                existingPointer.frame = mergedGroup;
            }

            if (!suppressEvents) {
              this._emitter.emit('frame:updated', { frame: mergedGroup, previousHead });
              this._emitter.emit(`frame:updated:${frame.groupId}`, { frame: mergedGroup, previousHead });
            }

            results.push(mergedGroup);
          } else {
            // First phantom for this group → create a new persistent group frame
            let groupFrame = new Frame({
              id:        frame.groupId,
              type:      frame.groupType || frame.type,
              content:   frame.content,
              phantom:   false,
              parentId:  frame.parentId,
              hidden:    true,
              deleted:   false,
              order:     ++this._orderCounter,
              timestamp: Date.now(),
            });

            let groupPointer = new FramePointer(groupFrame);

            this._frames.set(groupFrame.id, groupFrame);
            this._pointers.set(groupFrame.id, groupPointer);

            if (groupFrame.parentId) {
              let children = this._children.get(groupFrame.parentId);

              if (children)
                children.push(groupFrame.id);
              else
                this._children.set(groupFrame.parentId, [groupFrame.id]);
            }

            if (!suppressEvents) {
              this._emitter.emit('frame:added', { frame: groupFrame });
              this._emitter.emit(`frame:added:${groupFrame.id}`, { frame: groupFrame });
            }

            results.push(groupFrame);
          }
        } else {
          // Phantom WITHOUT groupId → standalone ephemeral, transient event only
          if (!suppressEvents) {
            this._emitter.emit('frame:phantom', { frame });
            this._emitter.emit(`frame:phantom:${frame.id}`, { frame });
          }
        }

        continue;
      }

      // ── Normal (non-phantom) frame handling ──
      let pointer = new FramePointer(frame);

      // Always store the source frame in the index
      this._frames.set(frame.id, frame);
      this._pointers.set(frame.id, pointer);

      if (frame.parentId) {
        let children = this._children.get(frame.parentId);

        if (children)
          children.push(frame.id);
        else
          this._children.set(frame.parentId, [frame.id]);
      }

      results.push(frame);

      // Target-based merge logic
      if (frame.targets && frame.targets.length > 0) {
        let seen = new Set();

        for (let t = 0; t < frame.targets.length; t++) {
          let targetId = frame.targets[t];

          // Skip self-referencing targets
          if (targetId === frame.id)
            continue;

          // Deduplicate targets
          if (seen.has(targetId))
            continue;

          seen.add(targetId);

          let targetFrame = this.get(targetId);

          // Skip non-existent targets
          if (!targetFrame)
            continue;

          let previousHead = this.getHead(targetId);

          let mergedFrame = new Frame({
            ...targetFrame,
            content:   deepMerge(targetFrame.content, frame.content),
            hidden:    frame.hidden,
            deleted:   frame.deleted,
            updatedAt: frame.updatedAt,
          });

          this._frames.set(mergedFrame.id, mergedFrame);

          if (this.history) {
            let existingPointer = this._pointers.get(targetId);
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

            this._pointers.set(targetId, existingPointer);
          } else {
            let existingPointer = this._pointers.get(targetId);

            if (existingPointer)
              existingPointer.frame = mergedFrame;
          }

          if (!suppressEvents) {
            this._emitter.emit('frame:updated', { frame: mergedFrame, previousHead });
            this._emitter.emit(`frame:updated:${targetId}`, { frame: mergedFrame, previousHead });
          }

          results.push(mergedFrame);
        }

        // Frame with targets is not a new addition; skip frame:added
      } else if (!suppressEvents && !frame.phantom) {
        // New frame (no targets, not phantom): emit frame:added
        this._emitter.emit('frame:added', { frame });
        this._emitter.emit(`frame:added:${frame.id}`, { frame });
      }
    }

    if (suppressEvents)
      this._emitter.emit('frames:bulk-loaded', { count: results.length });

    return results;
  }

  get(frameId) {
    return this._frames.get(frameId);
  }

  getHead(frameId) {
    if (!this.history)
      return this.get(frameId);

    let pointer = this._pointers.get(frameId);

    if (!pointer)
      return undefined;

    return pointer.head.frame;
  }

  getChildren(parentId) {
    let childIds = this._children.get(parentId) || [];

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

    for (let [frameId] of this._frames) {
      let head = this.getHead(frameId);

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

  setProcessed(frameId, fingerprint) {
    let frame = this.get(frameId);

    if (!frame)
      return;

    let updatedFrame = new Frame({
      ...frame,
      processed:   fingerprint,
      processedAt: Date.now(),
    });

    this._frames.set(frameId, updatedFrame);

    // Update the pointer's frame reference
    let pointer = this._pointers.get(frameId);
    if (pointer) {
      if (this.history)
        pointer.head.frame = updatedFrame;
      else
        pointer.frame = updatedFrame;
    }

    this._emitter.emit('frame:processed', { frame: updatedFrame });
    this._emitter.emit(`frame:processed:${frameId}`, { frame: updatedFrame });
  }

  onFrameEvent(eventType, frameId, callback) {
    this._emitter.on(`${eventType}:${frameId}`, callback);
  }

  offFrameEvent(eventType, frameId, callback) {
    this._emitter.removeListener(`${eventType}:${frameId}`, callback);
  }

  on(event, listener) {
    this._emitter.on(event, listener);
    return this;
  }

  off(event, listener) {
    this._emitter.removeListener(event, listener);
    return this;
  }

  emit(event, data) {
    this._emitter.emit(event, data);
    return this;
  }

  getVersionHistory(frameId) {
    let pointer = this._pointers.get(frameId);

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
}
