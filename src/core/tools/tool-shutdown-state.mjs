'use strict';

// Coordinates server shutdown with in-flight tool executions. New tool requests
// check `isShuttingDown()` before starting; already-started calls are tracked and
// awaited up to a deadline. Pending requests that never started are deliberately
// left unprocessed for boot recovery.
export class ToolShutdownState {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.shuttingDown = false;
    this._inflight = new Map();
    this._nextToken = 0;
  }

  begin() {
    this.shuttingDown = true;
  }

  isShuttingDown() {
    return this.shuttingDown;
  }

  track(record = {}) {
    let token = ++this._nextToken;
    this._inflight.set(token, { ...record, abandoned: false });
    return token;
  }

  untrack(token) {
    this._inflight.delete(token);
  }

  inFlight() {
    return [ ...this._inflight.values() ];
  }

  // Deadline failure for calls that could not finish. The caller writes the
  // failure result and marks the frame finished; this method only abandons the
  // live execution so a later completion cannot overwrite it.
  abandonRemaining() {
    let remaining = this.inFlight();
    for (let record of remaining)
      record.abandoned = true;
    this._inflight.clear();
    return remaining;
  }

  async waitForInflight(options = {}) {
    let timeoutMS = Number.isFinite(Number(options.timeoutMS)) ? Math.max(0, Number(options.timeoutMS)) : 30000;
    let intervalMS = Number.isFinite(Number(options.intervalMS)) ? Math.max(1, Number(options.intervalMS)) : 25;
    let startedAt = Date.now();
    let deadline = startedAt + timeoutMS;

    while (this._inflight.size > 0) {
      let remainingMS = deadline - Date.now();
      if (remainingMS <= 0)
        break;
      await new Promise((resolve) => {
        let timer = setTimeout(resolve, Math.min(intervalMS, remainingMS));
        timer.unref?.();
      });
    }

    return {
      timedOut: this._inflight.size > 0,
      remaining: this.inFlight(),
      waitedMS: Date.now() - startedAt,
    };
  }
}
