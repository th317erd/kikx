'use strict';

// =============================================================================
// Scroll telemetry store — bounded ring + live fanout (owner ask, 2026-11-07)
// =============================================================================
// The server half of "stream scroll events to the agent in real time": the
// client batches over authenticated POST, this ring keeps the newest
// diagnostics (a diagnostic must never grow unbounded), and the SSE tail in
// infra-routes subscribes here for live delivery. Transport choice recorded
// for the future: POST-in + SSE-out gives the agent exactly the real-time
// stream asked for with zero new dependencies; a WebSocket replaces only the
// transport, never this contract.

const DEFAULT_CAPACITY = 5000;
const DEFAULT_MAX_BATCH = 1000;
const MAX_EVENT_BYTES = 4096;

function isValidEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event))
    return false;
  if (typeof event.type !== 'string' || event.type.length < 1 || event.type.length > 48)
    return false;
  if (!Number.isFinite(event.t))
    return false;
  try {
    if (JSON.stringify(event).length > MAX_EVENT_BYTES)
      return false;
  } catch {
    return false;
  }
  return true;
}

export function createScrollTelemetryStore(options = {}) {
  const capacity = Number.isInteger(options.capacity) && options.capacity > 0
    ? options.capacity
    : DEFAULT_CAPACITY;
  const maxBatch = Number.isInteger(options.maxBatch) && options.maxBatch > 0
    ? options.maxBatch
    : DEFAULT_MAX_BATCH;

  const ring = [];
  const listeners = new Set();
  let seq = 0;
  let droppedTotal = 0;

  function record(events) {
    let accepted = 0;
    let dropped = 0;
    let first = null;
    let last = null;
    const fresh = [];

    for (const event of Array.isArray(events) ? events : []) {
      if (!isValidEvent(event)) {
        dropped++;
        droppedTotal++;
        continue;
      }
      const record = { ...event, seq: ++seq };
      ring.push(record);
      if (ring.length > capacity)
        ring.shift();
      fresh.push(record);
      accepted++;
      if (first === null)
        first = record.seq;
      last = record.seq;
    }

    if (fresh.length > 0) {
      for (const listener of [ ...listeners ]) {
        for (const record of fresh) {
          try {
            listener(record);
          } catch {
            // A dead subscriber must not stall ingestion for the others.
          }
        }
      }
    }

    return { accepted, dropped, first, last };
  }

  function since(seqValue) {
    const after = Number.isFinite(Number(seqValue)) ? Number(seqValue) : 0;
    return ring.filter((record) => record.seq > after).slice(-maxBatch);
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    record,
    since,
    subscribe,
    latest: () => seq,
    size: () => ring.length,
    dropped: () => droppedTotal,
  };
}
