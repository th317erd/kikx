'use strict';

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { HybridLogicalClock, defaultUnixMicros } from '../clock/hybrid-logical-clock.mjs';
import { cloneValue, deepMerge } from './deep-merge.mjs';

const MERGEABLE_FIELDS = new Set([ 'content', 'hidden', 'deleted', 'updatedAt', 'state' ]);

// Retention bounds. A user/agent frame is updated once per streamed delta, so
// without a cap `_history` grows with the token count and `_commits` with the
// delta count, forever. Both are caches over durable state: keep the newest
// window. `_history` keeps the newest versions per frame; `_commits` keeps the
// newest commits and indexes them by order so `getCommit` stays O(1).
const DEFAULT_HISTORY_LIMIT = 200;
const DEFAULT_COMMIT_LIMIT = 2000;
const TERMINAL_CONTENT_STATUSES = new Set([
  'break',
  'complete',
  'completed',
  'deleted',
  'empty',
  'error',
  'finalized',
  'forwarded',
  'null-response',
  'respond-and-continue',
]);

export class FrameEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.history = options.history !== false;
    this.clock = options.clock || defaultUnixMicros;
    this.logicalClock = options.logicalClock || new HybridLogicalClock({
      now: this.clock,
      runnerID: options.runnerID,
    });
    this.idGenerator = options.idGenerator || (() => randomUUID());
    this.commitValidator = options.commitValidator || null;
    this.historyLimit = normalizePositiveLimit(options.historyLimit, DEFAULT_HISTORY_LIMIT);
    this.commitLimit = normalizePositiveLimit(options.commitLimit, DEFAULT_COMMIT_LIMIT);

    this._frameOrder = 0;
    this._commitOrder = 0;
    this._frames = new Map();
    this._history = new Map();
    this._children = new Map();
    this._commits = [];
    this._commitsByOrder = new Map();
    this._refs = new Map();
  }

  merge(frames, options = {}) {
    if (!Array.isArray(frames))
      throw new TypeError('FrameEngine.merge() requires an array of frames');

    if (frames.length === 0)
      return [];

    // Only the commit validator needs a rollback point. Cloning all history on
    // every merge is the O(n^2) hot path when history is retained for replay, so
    // snapshot lazily.
    let snapshot = this.commitValidator ? this._snapshot() : null;
    let results = [];
    let changes = [];
    let frameEvents = [];

    for (let input of frames) {
      if (!input || !input.id || !input.type)
        continue;

      let normalized = this._normalizeFrame(input);

      if (normalized.phantom) {
        this._mergePhantom(normalized, results, changes, frameEvents);
        continue;
      }

      this._storeFrame(normalized, results, changes, frameEvents);
      this._mergeTargets(normalized, results, changes, frameEvents);
    }

    if (changes.length === 0) {
      if (options.events !== false) {
        for (let event of frameEvents)
          this.emit(event.name, event.payload);
      }
      return [];
    }

    let commit = this._createCommit(changes, options);

    if (this.commitValidator) {
      let validation = this.commitValidator(commit, results, options.actorContext || null);
      if (validation === false || validation?.allowed === false) {
        this._restore(snapshot);
        this.emit('commit:rejected', {
          reason: validation?.reason || 'Commit rejected',
          commit,
        });
        return [];
      }
    }

    this._recordCommit(commit);
    this._refs.set('heads/main', commit.order);
    this._applyCommitOrder(results, commit.order);

    if (options.events !== false) {
      for (let event of frameEvents)
        this.emit(event.name, event.payload);

      this.emit('commit', { commit, frames: results.slice() });
    }

    return results;
  }

  get(id) {
    return this._frames.get(id);
  }

  getHead(id) {
    return this.get(id);
  }

  getChildren(parentID) {
    let childIDs = this._children.get(parentID) || [];
    return childIDs
      .map((id) => this.get(id))
      .filter(Boolean)
      .sort(compareFrameOrder);
  }

  getVersionHistory(id) {
    return (this._history.get(id) || []).slice();
  }

  toArray() {
    return Array.from(this._frames.values()).sort(compareFrameOrder);
  }

  getCommit(order) {
    return this._commitsByOrder.get(order);
  }

  getCommits(fromOrder = 0, toOrder = Infinity) {
    return this._commits.filter((commit) => commit.order > fromOrder && commit.order <= toOrder);
  }

  getLatestCommit() {
    return this._commits[this._commits.length - 1];
  }

  hydrate(frames, options = {}) {
    if (!Array.isArray(frames))
      throw new TypeError('FrameEngine.hydrate() requires an array of frames');

    this._frames.clear();
    this._history.clear();
    this._children.clear();
    this._commits = [];
    this._commitsByOrder.clear();
    this._refs.clear();
    this._frameOrder = 0;
    this._commitOrder = 0;

    for (let input of frames) {
      if (!input?.id || !input.type)
        continue;

      let frame = this._normalizeFrame(input, { stampMissingTime: false });
      this._seedClock(frame.createdClock);
      this._seedClock(frame.updatedClock);
      this._frames.set(frame.id, frame);
      this._appendHistory(frame.id, frame);
      if (frame.parentID)
        this._addChild(frame.parentID, frame.id);

      this._frameOrder = Math.max(this._frameOrder, frame.order || 0);
      this._commitOrder = Math.max(this._commitOrder, frame.commitOrder || frame.order || 0);
    }

    if (options.headOrder != null)
      this._commitOrder = Math.max(this._commitOrder, options.headOrder);

    if (this._commitOrder > 0)
      this._refs.set('heads/main', this._commitOrder);
  }

  createRef(name, commitOrder = this.getLatestCommit()?.order || 0) {
    this._assertCommitOrder(commitOrder);
    this._refs.set(name, commitOrder);
    this.emit('ref:created', { name, commitOrder });
  }

  getRef(name) {
    return this._refs.get(name);
  }

  updateRef(name, commitOrder) {
    this._assertCommitOrder(commitOrder);
    let previousOrder = this._refs.get(name);
    this._refs.set(name, commitOrder);
    this.emit('ref:updated', { name, previousOrder, newOrder: commitOrder });
  }

  listRefs(prefix = '') {
    let refs = new Map();
    for (let [name, order] of this._refs) {
      if (!prefix || name.startsWith(prefix))
        refs.set(name, order);
    }
    return refs;
  }

  diffFrames(fromOrder, toOrder) {
    let from = this._resolveCommitOrder(fromOrder);
    let to = this._resolveCommitOrder(toOrder);
    let changedIDs = new Set();

    for (let commit of this.getCommits(from, to)) {
      for (let change of commit.changes)
        changedIDs.add(change.frameID);
    }

    return Array.from(changedIDs)
      .map((id) => this.get(id))
      .filter(Boolean)
      .sort(compareFrameOrder);
  }

  _normalizeFrame(input, options = {}) {
    let existing = this.get(input.id);
    let stamp = null;
    let shouldStampMissingTime = options.stampMissingTime !== false;
    let nextStamp = () => {
      stamp ||= this._nextStamp();
      return stamp;
    };
    let missingStamp = () => shouldStampMissingTime ? nextStamp() : { at: 0, clock: null };
    let timestamp = numberOr(input.timestamp, missingStamp().at);
    let createdAt = numberOr(input.createdAt, existing?.createdAt || timestamp);
    let updatedAt = numberOr(input.updatedAt, timestamp);
    let createdClock = stringOr(input.createdClock, existing?.createdClock || missingStamp().clock);
    let updatedClock = stringOr(input.updatedClock, existing ? missingStamp().clock : createdClock);
    let order = numberOr(input.order, existing?.order || ++this._frameOrder);

    let content = cloneValue(input.content || {});
    let state = normalizeLifecycleState({
      inputState: input.state,
      existingState: existing?.state,
      content,
      updatedAt,
      updatedClock,
    });

    return {
      ...cloneValue(input),
      id: input.id,
      type: input.type,
      order,
      timestamp,
      createdAt,
      updatedAt,
      createdClock,
      updatedClock,
      hidden: input.hidden ?? existing?.hidden ?? true,
      deleted: input.deleted ?? existing?.deleted ?? false,
      targets: Array.isArray(input.targets) ? input.targets.slice() : [],
      recipients: Array.isArray(input.recipients) ? input.recipients.slice() : (existing?.recipients || []),
      parentID: input.parentID ?? input.parentId ?? null,
      groupID: input.groupID ?? input.groupId ?? null,
      groupType: input.groupType ?? null,
      phantom: input.phantom === true,
      content,
      state,
    };
  }

  _storeFrame(frame, results, changes, frameEvents) {
    let previous = this.get(frame.id);
    let operation = previous ? 'update' : 'create';

    this._frames.set(frame.id, frame);
    this._appendHistory(frame.id, frame);

    if (!previous && frame.parentID)
      this._addChild(frame.parentID, frame.id);

    changes.push({ frameID: frame.id, operation });
    results.push(frame);

    if (operation === 'create')
      this._queueEvent(frameEvents, 'frame:added', { frame });
    else
      this._queueEvent(frameEvents, 'frame:updated', { frame, previousFrame: previous });
  }

  _mergeTargets(source, results, changes, frameEvents) {
    let seen = new Set();

    for (let targetID of source.targets) {
      if (!targetID || targetID === source.id || seen.has(targetID))
        continue;

      seen.add(targetID);

      let target = this.get(targetID);
      if (!target)
        continue;

      let previous = target;
      let update = { ...target };

      for (let key of MERGEABLE_FIELDS) {
        if (!(key in source))
          continue;

        if (key === 'content' || key === 'state')
          update[key] = deepMerge(target[key] || {}, source[key] || {});
        else
          update[key] = cloneValue(source[key]);
      }

      this._stampUpdated(update);

      this._frames.set(targetID, update);
      this._appendHistory(targetID, update);

      changes.push({ frameID: targetID, operation: 'update', sourceFrameID: source.id });
      results.push(update);
      this._queueEvent(frameEvents, 'frame:updated', { frame: update, previousFrame: previous });
    }
  }

  _mergePhantom(frame, results, changes, frameEvents) {
    if (!frame.groupID) {
      this._queueEvent(frameEvents, 'frame:phantom', { frame });
      return;
    }

    let existing = this.get(frame.groupID);

    if (!existing) {
      let group = this._normalizeFrame({
        ...frame,
        id: frame.groupID,
        type: frame.groupType || frame.type,
        phantom: false,
        targets: [],
        hidden: true,
        deleted: false,
      });

      this._storeFrame(group, results, changes, frameEvents);
      return;
    }

    if (frame.groupType && frame.groupType !== existing.type) {
      this.emit('frame:rejected', {
        reason: 'phantom group type conflict',
        frame,
        existing,
      });
      return;
    }

    let previous = existing;
    let updated = {
      ...existing,
      content: deepMerge(existing.content || {}, frame.content || {}),
    };
    this._stampUpdated(updated);

    this._frames.set(existing.id, updated);
    this._appendHistory(existing.id, updated);
    changes.push({ frameID: existing.id, operation: 'update', sourceFrameID: frame.id });
    results.push(updated);
    this._queueEvent(frameEvents, 'frame:updated', { frame: updated, previousFrame: previous });
  }

  _createCommit(changes, options) {
    let order = ++this._commitOrder;
    let stamp = this._nextStamp();
    return {
      id: options.commitID || this.idGenerator(),
      order,
      parentOrder: order > 1 ? order - 1 : null,
      timestamp: stamp.at,
      clock: stamp.clock,
      createdAt: stamp.at,
      createdClock: stamp.clock,
      authorType: options.authorType || 'system',
      authorID: options.authorID || null,
      silent: options.silent === true,
      changes: changes.map((change) => ({ ...change })),
    };
  }

  _nextStamp() {
    if (this.logicalClock && typeof this.logicalClock.tick === 'function')
      return this.logicalClock.tick();

    return { at: this.clock(), clock: null };
  }

  _seedClock(clock) {
    if (this.logicalClock && typeof this.logicalClock.seed === 'function')
      this.logicalClock.seed(clock);
  }

  _stampUpdated(frame) {
    let stamp = this._nextStamp();
    frame.updatedAt = stamp.at;
    frame.updatedClock = stamp.clock;
  }

  _applyCommitOrder(frames, commitOrder) {
    let seen = new Set();

    for (let frame of frames) {
      if (!frame?.id || seen.has(frame.id))
        continue;

      seen.add(frame.id);
      frame.commitOrder = commitOrder;
      let current = this._frames.get(frame.id);
      if (current)
        current.commitOrder = commitOrder;
    }
  }

  _appendHistory(id, frame) {
    let versions;
    if (this.history) {
      versions = this._history.get(id);
      if (!versions) {
        versions = [];
        this._history.set(id, versions);
      }

      versions.push(frame);
      if (versions.length > this.historyLimit)
        versions.splice(0, versions.length - this.historyLimit);
      return;
    }

    // History disabled: retain only the newest version.
    this._history.set(id, [ frame ]);
  }

  _recordCommit(commit) {
    this._commits.push(commit);
    this._commitsByOrder.set(commit.order, commit);

    if (this._commits.length <= this.commitLimit)
      return;

    let removed = this._commits.splice(0, this._commits.length - this.commitLimit);
    for (let commit of removed)
      this._commitsByOrder.delete(commit.order);
  }

  _addChild(parentID, childID) {
    if (!this._children.has(parentID))
      this._children.set(parentID, []);

    let children = this._children.get(parentID);
    if (!children.includes(childID))
      children.push(childID);
  }

  _queueEvent(events, name, payload) {
    events.push({ name, payload });
    if (payload.frame?.id)
      events.push({ name: `${name}:${payload.frame.id}`, payload });
  }

  _assertCommitOrder(order) {
    if (order !== 0 && !this.getCommit(order))
      throw new Error(`Commit order does not exist: ${order}`);
  }

  _resolveCommitOrder(value) {
    if (typeof value === 'number')
      return value;

    if (typeof value === 'string') {
      if (!this._refs.has(value))
        throw new Error(`Unknown ref: ${value}`);

      return this._refs.get(value);
    }

    throw new TypeError('Commit order must be a number or ref name');
  }

  _snapshot() {
    return {
      frameOrder: this._frameOrder,
      commitOrder: this._commitOrder,
      frames: new Map(this._frames),
      history: cloneMapOfArrays(this._history),
      children: cloneMapOfArrays(this._children),
      commits: this._commits.slice(),
      refs: new Map(this._refs),
    };
  }

  _restore(snapshot) {
    this._frameOrder = snapshot.frameOrder;
    this._commitOrder = snapshot.commitOrder;
    this._frames = snapshot.frames;
    this._history = snapshot.history;
    this._children = snapshot.children;
    this._commits = snapshot.commits;
    this._commitsByOrder = new Map();
    for (let commit of this._commits)
      this._commitsByOrder.set(commit.order, commit);

    this._refs = snapshot.refs;
  }
}

function normalizePositiveLimit(value, fallback) {
  let number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    return fallback;

  return number;
}

function compareFrameOrder(a, b) {
  return compareClock(logicalSortClock(a), logicalSortClock(b))
    || compareNumber(logicalSortTime(a), logicalSortTime(b))
    || compareNumber(a?.order, b?.order)
    || compareNumber(sortCommitOrder(a), sortCommitOrder(b))
    || String(a.id).localeCompare(String(b.id));
}

function logicalSortClock(frame) {
  if (isClosedAgentMessage(frame))
    return frame?.state?.lifecycle?.closedClock || frame?.updatedClock || frame?.createdClock;

  return frame?.createdClock;
}

function logicalSortTime(frame) {
  if (isClosedAgentMessage(frame))
    return numberOr(frame?.state?.lifecycle?.closedAt, numberOr(frame?.updatedAt, frame?.createdAt));

  return frame?.createdAt;
}

function isClosedAgentMessage(frame) {
  return frame?.type === 'AgentMessage'
    && (
      frame?.state?.lifecycle?.status === 'closed'
      || frame?.content?.status === 'complete'
    );
}

function sortCommitOrder(frame) {
  if (typeof frame?.commitOrder === 'number' && Number.isFinite(frame.commitOrder))
    return frame.commitOrder;

  return frame?.order || 0;
}

function normalizeLifecycleState({ inputState, existingState, content, updatedAt, updatedClock }) {
  let state = cloneValue(inputState || existingState || {});
  let lifecycle = (state.lifecycle && typeof state.lifecycle === 'object' && !Array.isArray(state.lifecycle))
    ? { ...state.lifecycle }
    : {};

  if (!shouldCloseLifecycle(lifecycle, content))
    return state;

  lifecycle.status = 'closed';
  lifecycle.closedAt = numberOr(lifecycle.closedAt, updatedAt);
  lifecycle.closedClock = stringOr(lifecycle.closedClock, updatedClock);
  lifecycle.reason = stringOr(lifecycle.reason, normalizeTerminalStatus(content?.status) || 'closed');

  return {
    ...state,
    lifecycle,
  };
}

function shouldCloseLifecycle(lifecycle, content) {
  if (lifecycle?.status === 'closed')
    return true;

  return TERMINAL_CONTENT_STATUSES.has(normalizeTerminalStatus(content?.status));
}

function normalizeTerminalStatus(status) {
  return typeof status === 'string' ? status.trim() : '';
}

function compareClock(a, b) {
  if (!a || !b)
    return 0;

  if (a && b && a !== b)
    return String(a).localeCompare(String(b));

  return 0;
}

function compareNumber(a, b) {
  let left = (typeof a === 'number' && Number.isFinite(a)) ? a : 0;
  let right = (typeof b === 'number' && Number.isFinite(b)) ? b : 0;
  return left - right;
}

function numberOr(value, fallback) {
  return (typeof value === 'number' && Number.isFinite(value)) ? value : fallback;
}

function stringOr(value, fallback = null) {
  return (typeof value === 'string' && value.trim() !== '') ? value : fallback;
}

function cloneMapOfArrays(map) {
  let copy = new Map();
  for (let [key, value] of map)
    copy.set(key, value.slice());
  return copy;
}
