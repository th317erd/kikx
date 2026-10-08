'use strict';

export async function readResponse(response) {
  let body = await response.json();
  if (!response.ok)
    throw new Error(body?.error?.message || `HTTP ${response.status}`);

  return body;
}

// Escape a value for use inside an attribute selector (agent IDs are UUIDs, but
// stay safe if that ever changes).
export function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
    return CSS.escape(String(value));

  return String(value).replace(/["\\]/g, '\\$&');
}

export function formatTokenUsageTotal(value) {
  let total = Number(value);
  if (!Number.isFinite(total) || total < 0)
    total = 0;

  return `Tokens: ${Math.trunc(total).toLocaleString('en-US')}`;
}

// Bound on the payload excerpt carried as diagnostic context. A malformed
// event must not be able to stuff an unbounded string into the error ring.
const PARSE_PREVIEW_LIMIT = 200;

function boundedPreview(raw) {
  if (typeof raw === 'string')
    return raw.slice(0, PARSE_PREVIEW_LIMIT);

  if (raw === undefined || raw === null)
    return '';

  return String(raw).slice(0, PARSE_PREVIEW_LIMIT);
}

// Parse-result variant used by the dispatcher so a malformed payload can be
// reported (with the parse error and a bounded excerpt) instead of vanishing.
// `parseRuntimeEvent` below stays the null-on-failure helper for callers that
// only care about the data. Neither variant throws, even when reading
// `event.data` or `event.type` throws (a poisoned payload from the stream).
export function parseRuntimeEventResult(event) {
  let raw;
  try {
    raw = event?.data;
  } catch (error) {
    return { ok: false, data: null, error, preview: '<unreadable>' };
  }

  try {
    let data = JSON.parse(raw || '{}');
    if (!data.type && event.type)
      data.type = event.type;
    return { ok: true, data, error: null, preview: boundedPreview(raw) };
  } catch (error) {
    return { ok: false, data: null, error, preview: boundedPreview(raw) };
  }
}

export function parseRuntimeEvent(event) {
  return parseRuntimeEventResult(event).data;
}

// Deterministic-scheduler seam for specs. When installed, `scheduleAnimationFrame`
// routes to the supplied function instead of rAF/setTimeout, so a spec can drive
// deferred paint/reconcile work explicitly at a chosen point rather than racing
// real timers. Passing anything that is not a function restores production
// behavior; production never installs one.
let animationFrameScheduler = null;

export function setAnimationFrameScheduler(scheduler) {
  animationFrameScheduler = typeof scheduler === 'function' ? scheduler : null;
}

// W8: requestAnimationFrame is paused while the tab is hidden, so scheduling a
// drain exclusively on a rAF is exactly how the client's pending-event queue grew
// without bound in a background tab. When the document is hidden we use the timer
// path instead (still throttled by the browser, but it runs); a visible document
// keeps the cheaper rAF. Environments with no `visibilityState` (plain Node) are
// unchanged.
export function scheduleAnimationFrame(callback) {
  if (animationFrameScheduler)
    return animationFrameScheduler(callback);

  let visibilityState = globalThis.document?.visibilityState;
  if (visibilityState && visibilityState !== 'visible')
    return setTimeout(callback, 0);

  if (typeof requestAnimationFrame === 'function')
    return requestAnimationFrame(callback);

  return setTimeout(callback, 0);
}
