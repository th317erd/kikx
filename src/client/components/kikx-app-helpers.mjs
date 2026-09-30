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

export function scheduleAnimationFrame(callback) {
  if (typeof requestAnimationFrame === 'function')
    return requestAnimationFrame(callback);

  return setTimeout(callback, 0);
}
