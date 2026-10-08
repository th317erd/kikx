'use strict';

// S3: a tiny, allocation-light counter of full DOM rebuilds, by structure. The
// streaming paths must update items in place; these counters are the production
// signal that a burst of runtime events did NOT turn into a rebuild storm. An
// increment is a single integer bump and snapshots allocate only when asked, so
// the counters are safe to leave armed in production.
//
// The app aliases this object as `app._renderStats` so a browser probe can read
// it; components that only receive `appState` import it directly.
export const RENDER_KINDS = [ 'shell', 'thread', 'grid', 'chatView', 'frameItem' ];

export const renderStats = {};

for (let kind of RENDER_KINDS)
  renderStats[kind] = 0;

export function countRebuild(kind) {
  if (Object.hasOwn(renderStats, kind))
    renderStats[kind] += 1;
}

export function resetRenderStats() {
  for (let kind of RENDER_KINDS)
    renderStats[kind] = 0;

  return renderStats;
}

export function snapshotRenderStats() {
  return { ...renderStats };
}
