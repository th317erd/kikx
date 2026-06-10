'use strict';

const DEFAULT_WORKER_INTERVAL_MS = 1000;
const SCHEDULER_AUTHOR_ID = 'internal:scheduled-frame-queue';

export class ScheduledFrameQueue {
  constructor(options = {}) {
    let {
      runtime,
      intervalMS = DEFAULT_WORKER_INTERVAL_MS,
      logger = console,
    } = options;

    if (!runtime)
      throw new TypeError('ScheduledFrameQueue requires runtime');

    this.runtime = runtime;
    this.intervalMS = normalizeWorkerInterval(intervalMS);
    this.logger = logger;
    this.entries = new Map();
    this._timer = null;
    this._started = false;
    this._loading = null;
    this._processing = false;
    this._nudgePending = false;
  }

  async start() {
    if (this._started)
      return await this._loading;

    this._started = true;
    this._loading = this.load().catch((error) => {
      this.logger?.error?.('Scheduled frame queue failed to load persisted frames', error);
      return [];
    });
    await this._loading;
    this._arm();
    this._nudge();
    return this;
  }

  stop() {
    this._started = false;
    if (this._timer)
      clearInterval(this._timer);

    this._timer = null;
    this._nudgePending = false;
  }

  async load() {
    let frames = [];
    if (typeof this.runtime.frameStore?.listScheduledFrames === 'function') {
      let offset = 0;
      let limit = 500;

      while (true) {
        let page = await this.runtime.frameStore.listScheduledFrames({ limit, offset });
        frames.push(...page);

        if (page.length < limit)
          break;

        offset += page.length;
      }
    }

    this.trackFrames(frames);
    return frames;
  }

  trackFrames(frames = []) {
    for (let frame of frames)
      this.trackFrame(frame);
  }

  trackFrame(frame) {
    if (!frame?.id)
      return;

    if (!isPendingScheduledFrame(frame)) {
      this.entries.delete(frame.id);
      return;
    }

    this.entries.set(frame.id, {
      frame,
      frameID: frame.id,
      sessionID: frame.sessionID,
      scheduledAt: normalizeScheduledAt(frame.scheduledAt),
    });

    this._nudge();
  }

  async processDue() {
    if (this._processing)
      return [];

    this._processing = true;
    try {
      let now = this.now();
      let dueEntries = Array.from(this.entries.values())
        .filter((entry) => entry.scheduledAt <= now)
        .sort(compareEntries);
      let dispatched = [];

      for (let entry of dueEntries) {
        let result = await this.dispatch(entry);
        if (result)
          dispatched.push(result);
      }

      return dispatched;
    } finally {
      this._processing = false;
    }
  }

  async dispatch(entry) {
    if (!entry?.sessionID || !entry.frameID) {
      this.entries.delete(entry?.frameID);
      return null;
    }

    let sessionEntry = await this.runtime.ensureSessionEntry(entry.sessionID);
    let frame = sessionEntry.frameEngine.get(entry.frameID);

    if (!frame && entry.frame) {
      sessionEntry.frameEngine.hydrate(uniqueFrames([
        ...sessionEntry.frameEngine.toArray(),
        entry.frame,
      ]));
      frame = sessionEntry.frameEngine.get(entry.frameID);
    }

    if (!isPendingScheduledFrame(frame)) {
      this.entries.delete(entry.frameID);
      return null;
    }

    if (normalizeScheduledAt(frame.scheduledAt) > this.now())
      return null;

    let firingFrame = await this.markFrameStatus({
      sessionEntry,
      frame,
      status: 'firing',
    });

    let commit = {
      id: `scheduled:${firingFrame.id}:${firingFrame.scheduledFiringAt || this.now()}`,
      order: sessionEntry.frameEngine.getLatestCommit()?.order || firingFrame.commitOrder || firingFrame.order || 0,
      scheduledDispatch: true,
      authorType: 'system',
      authorID: SCHEDULER_AUTHOR_ID,
      silent: false,
      changes: [{
        frameID: firingFrame.id,
        operation: 'create',
      }],
    };

    this.runtime.frameRouter?.enqueue?.(sessionEntry.frameEngine, commit, sessionEntry.session, {
      services: this.runtime.routerServices(),
    });
    await this.runtime.frameRouter?.flush?.();

    let firedFrame = await this.markFrameStatus({
      sessionEntry,
      frame: sessionEntry.frameEngine.get(firingFrame.id) || firingFrame,
      status: 'fired',
    });

    this.entries.delete(entry.frameID);
    this.runtime.emitRuntimeEvent?.('frame.scheduled.fired', {
      sessionID: sessionEntry.session.id,
      frame: firedFrame,
    });

    return firedFrame;
  }

  async markFrameStatus({ sessionEntry, frame, status }) {
    let now = this.now();
    let updated = {
      ...frame,
      scheduledStatus: status,
      updatedAt: now,
    };

    if (status === 'firing')
      updated.scheduledFiringAt = now;
    else if (status === 'fired')
      updated.scheduledFiredAt = now;

    let merged = sessionEntry.frameEngine.merge([ updated ], {
      authorType: 'system',
      authorID: SCHEDULER_AUTHOR_ID,
      silent: true,
    });
    await this.runtime.frameStore.flush();
    return merged[0] || sessionEntry.frameEngine.get(frame.id) || updated;
  }

  now() {
    return Number(this.runtime.clock?.() || Date.now());
  }

  _arm() {
    if (this._timer || !this._started)
      return;

    this._timer = setInterval(() => {
      this.processDue().catch((error) => {
        this.logger?.error?.('Scheduled frame queue worker failed', error);
      });
    }, this.intervalMS);
    this._timer.unref?.();
  }

  _nudge() {
    if (!this._started || this._nudgePending)
      return;

    let now = this.now();
    if (![ ...this.entries.values() ].some((entry) => entry.scheduledAt <= now))
      return;

    this._nudgePending = true;
    queueMicrotask(() => {
      this._nudgePending = false;
      this.processDue().catch((error) => {
        this.logger?.error?.('Scheduled frame queue nudge failed', error);
      });
    });
  }
}

export function isPendingScheduledFrame(frame) {
  if (!frame?.id || !frame.type || frame.deleted === true)
    return false;

  let scheduledAt = normalizeScheduledAt(frame.scheduledAt);
  if (!Number.isFinite(scheduledAt) || scheduledAt <= 0)
    return false;

  return frame.scheduledStatus !== 'fired' && frame.scheduledStatus !== 'cancelled';
}

export function normalizeScheduledAt(value) {
  if (value instanceof Date)
    return value.getTime() * 1000;

  if (typeof value === 'string' && value.trim() !== '') {
    let number = Number(value);
    if (Number.isFinite(number))
      return number;

    let parsed = Date.parse(value);
    if (Number.isFinite(parsed))
      return parsed * 1000;
  }

  return Number(value);
}

function normalizeWorkerInterval(value) {
  let number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    return DEFAULT_WORKER_INTERVAL_MS;

  return Math.trunc(number);
}

function compareEntries(a, b) {
  return a.scheduledAt - b.scheduledAt
    || String(a.frameID).localeCompare(String(b.frameID));
}

function uniqueFrames(frames) {
  let byID = new Map();
  for (let frame of frames) {
    if (frame?.id)
      byID.set(frame.id, frame);
  }

  return Array.from(byID.values());
}
