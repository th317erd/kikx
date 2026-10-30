'use strict';

// A tiny, allocation-light counter of full DOM rebuilds, by structure. The
// streaming paths must update items in place; these counters are the production
// signal that a burst of runtime events did NOT turn into a rebuild storm.
//
// `renderOutcomes` is a bounded diagnostic ring: a counter alone answers "how
// many", not "why". Recorded outcomes are only pushed when a caller supplies
// details, so the hot path remains a single integer bump unless diagnostics are
// requested.
export const RENDER_KINDS = [ 'shell', 'thread', 'grid', 'chatView', 'frameItem' ];
const MAX_RENDER_OUTCOMES = 80;

export const renderStats = {};

for (let kind of RENDER_KINDS)
  renderStats[kind] = 0;

export const renderOutcomes = [];

export function countRebuild(kind, details = null) {
  if (!Object.hasOwn(renderStats, kind))
    return;

  renderStats[kind] += 1;
  if (!details || typeof details !== 'object')
    return;

  renderOutcomes.push({
    kind,
    reason: typeof details.reason === 'string' && details.reason ? details.reason : 'unspecified',
    scope: details.scope ?? null,
    structural: details.structural === true,
    touchedFrameIDs: Array.isArray(details.touchedFrameIDs)
      ? [ ...details.touchedFrameIDs ].slice(0, 50)
      : [],
    at: Date.now(),
  });
  if (renderOutcomes.length > MAX_RENDER_OUTCOMES)
    renderOutcomes.splice(0, renderOutcomes.length - MAX_RENDER_OUTCOMES);
}

export function recordRender(kind, details = {}) {
  countRebuild(kind, details);
}

export function resetRenderStats() {
  for (let kind of RENDER_KINDS)
    renderStats[kind] = 0;

  renderOutcomes.length = 0;
  return renderStats;
}

export function snapshotRenderStats() {
  return { ...renderStats };
}
