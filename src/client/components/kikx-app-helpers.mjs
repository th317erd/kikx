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

export function parseRuntimeEvent(event) {
  try {
    let data = JSON.parse(event.data || '{}');
    if (!data.type && event.type)
      data.type = event.type;
    return data;
  } catch (_error) {
    return null;
  }
}

// W8: requestAnimationFrame is paused while the tab is hidden, so scheduling a
// drain exclusively on a rAF is exactly how the client's pending-event queue grew
// without bound in a background tab. When the document is hidden we use the timer
// path instead (still throttled by the browser, but it runs); a visible document
// keeps the cheaper rAF. Environments with no `visibilityState` (plain Node) are
// unchanged.
export function scheduleAnimationFrame(callback) {
  let visibilityState = globalThis.document?.visibilityState;
  if (visibilityState && visibilityState !== 'visible')
    return setTimeout(callback, 0);

  if (typeof requestAnimationFrame === 'function')
    return requestAnimationFrame(callback);

  return setTimeout(callback, 0);
}
