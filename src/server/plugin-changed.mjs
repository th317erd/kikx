'use strict';

// Campaign S5 (plan §5-S5, audit seam §10.7): every SUCCESSFUL plugin admin
// action announces `plugin.changed {pluginID, action, actor}` through
// frameRuntime.emitRuntimeEvent — the exact seam session.saved and
// tokens.updated already ride, whose gateway passes session-less events to
// EVERY subscriber filter, so all connected tabs hear it over their existing
// SSE streams (no new transport, no new route).
//
// Publish is BEST-EFFORT by design: the action has already succeeded on disk
// or in the registry when this runs, so a failed announce degrades realtime
// (clients keep the S2 self-refresh + visibility fallbacks) and must never
// turn that success into a 500. Failures warn loudly.

// The actor a requireOperator resolved: email is the human-readable audit
// value, name next, opaque id last. Absent gate → null (honest unknown).
export function actorFromGate(gate) {
  const identity = gate && gate.identity;
  if (!identity || typeof identity !== 'object')
    return null;
  return identity.email || identity.name || identity.id || null;
}

export function publishPluginChanged(context, { pluginID = null, action, actor = null }) {
  try {
    const runtime = context && typeof context.has === 'function' && context.has('frameRuntime')
      ? context.require('frameRuntime')
      : null;
    if (!runtime || typeof runtime.emitRuntimeEvent !== 'function')
      return false;
    runtime.emitRuntimeEvent('plugin.changed', { pluginID, action, actor });
    return true;
  } catch (error) {
    console.warn('[plugin-changed] publish failed:', error?.message);
    return false;
  }
}
