'use strict';

// =============================================================================
// Scroll telemetry client — batched, debug-gated, failure-silent (owner ask)
// =============================================================================
// "Stop and make better debugging tools for this scrollview… stream events
// real-time for analyzing." This module is the contract those instruments
// feed: record() is a no-op unless active, batches flush through ONE
// authenticated POST, a failed flush RESTORES the buffer (diagnostics must not
// eat their own data on a network blip), and maxBuffer force-flushes so a hot
// scroll storm arrives in slices instead of one doomed megabatch.
//
// Active exactly while UI Debug Mode is on (setDebugMode wires it), so normal
// sessions never generate telemetry traffic.

const DEFAULT_MAX_BUFFER = 40;
const DEFAULT_MAX_EVENT_BYTES = 4096;
const MAX_STRING_FIELD = 512;

function sanitizeEvent(event, maxBytes) {
  const clean = { ...event };
  for (const [ key, value ] of Object.entries(clean)) {
    if (typeof value === 'string' && value.length > MAX_STRING_FIELD)
      clean[key] = `${value.slice(0, MAX_STRING_FIELD)}…`;
  }
  try {
    if (JSON.stringify(clean).length <= maxBytes)
      return clean;
  } catch {
    return null;
  }
  // Still too big after string trimming: keep only the identity fields and
  // numerics — a diagnostic event must never ship a wall of text.
  const minimal = { type: clean.type, t: clean.t };
  for (const [ key, value ] of Object.entries(clean)) {
    if (key === 'type' || key === 't')
      continue;
    if (typeof value === 'number' || typeof value === 'boolean')
      minimal[key] = value;
  }
  try {
    return JSON.stringify(minimal).length <= maxBytes ? minimal : null;
  } catch {
    return null;
  }
}

export function createScrollTelemetry(options = {}) {
  const post = typeof options.post === 'function' ? options.post : null;
  const maxBuffer = Number.isInteger(options.maxBuffer) && options.maxBuffer > 0
    ? options.maxBuffer
    : DEFAULT_MAX_BUFFER;
  const maxEventBytes = Number.isInteger(options.maxEventBytes) && options.maxEventBytes > 0
    ? options.maxEventBytes
    : DEFAULT_MAX_EVENT_BYTES;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  let active = false;
  let buffer = [];

  const telemetry = {
    get active() {
      return active;
    },
    get pending() {
      return buffer.length;
    },

    setActive(next) {
      active = next === true;
      return active;
    },

    record(type, data = {}) {
      if (!active || typeof type !== 'string' || type.length < 1 || type.length > 48)
        return false;
      const event = sanitizeEvent({ type, t: now(), ...data }, maxEventBytes);
      if (!event)
        return false;
      buffer.push(event);
      if (buffer.length >= maxBuffer)
        void telemetry.flushNow();
      return true;
    },

    async flushNow() {
      if (!post || buffer.length === 0)
        return 0;
      const batch = buffer;
      buffer = [];
      try {
        await post({ events: batch });
        return batch.length;
      } catch {
        // Restore oldest-first: the next flush retries the same diagnostics.
        buffer = [ ...batch, ...buffer ];
        return -1;
      }
    },
  };

  return telemetry;
}

// --- browser singleton + instruments ----------------------------------------

const startedApps = new WeakSet();
let singleton = null;
let instrumentsInstalled = false;

function shortStack() {
  try {
    return (new Error().stack || '').split('\n').slice(3, 9).join(' | ').slice(0, 600);
  } catch {
    return '';
  }
}

function pageSnapshot() {
  // The splice-vs-placeholder question in one payload: each page's rendered
  // height beside its declared contain-intrinsic-size.
  try {
    return [ ...document.querySelectorAll('.aeor-scrollview__page') ]
      .map((node) => ({
        p: Number(node.dataset?.page ?? -1),
        h: Math.round(node.getBoundingClientRect().height),
        i: String(node.style?.containIntrinsicSize || '').slice(0, 40),
      }))
      .slice(0, 16);
  } catch {
    return [];
  }
}

function installInstruments() {
  if (typeof window === 'undefined' || typeof document === 'undefined')
    return;
  const rec = (type, data) => {
    try {
      if (singleton?.active)
        singleton.record(type, data);
    } catch {
      // Telemetry never breaks the app.
    }
  };

  // 1. Every scrollTop write, with a short stack — who fought the finger.
  try {
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    if (desc && desc.get && desc.set) {
      Object.defineProperty(Element.prototype, 'scrollTop', {
        get() { return desc.get.call(this); },
        set(value) {
          if (singleton?.active)
            rec('write', { v: Math.round(Number(value) || 0), s: shortStack() });
          return desc.set.call(this, value);
        },
        configurable: true,
      });
    }
  } catch { /* trapped already or not trapable */ }

  // 2. Inputs, throttled (a wheel storm is one event per 150ms, not sixty).
  let lastInput = 0;
  const noteInput = (kind, data) => {
    const t = Date.now();
    if (t - lastInput < 150)
      return;
    lastInput = t;
    rec('input', { kind, ...data });
  };
  addEventListener('wheel', (e) => noteInput('wheel', { dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) }), { capture: true, passive: true });
  addEventListener('keydown', (e) => noteInput('key', { key: String(e.key).slice(0, 16) }), { capture: true, passive: true });

  // 3. Page loads with geometry: this is trigger #1 ("Loading page… dumps a
  //    new page. Jumps REAL BAD") — timestamps + placeholder/real heights.
  document.addEventListener('scrollview-page-load', (e) => {
    rec('load', {
      p: e?.detail?.pageIndex ?? -1,
      tok: String(e?.detail?.token ?? '').slice(0, 24),
      pages: pageSnapshot(),
    });
  }, { capture: true });

  // 4. Focal frame sampler: id + viewport offset + scrollTop, on change only.
  let lastFocalKey = '';
  let lastFocalAt = 0;
  const sampleFocal = () => {
    try {
      if (singleton?.active) {
        const vp = document.querySelector('.aeor-scrollview__viewport');
        if (vp) {
          const vpTop = vp.getBoundingClientRect().top;
          let best = null;
          for (const frame of document.querySelectorAll('kikx-frame-item')) {
            const rect = frame.getBoundingClientRect();
            if (rect.bottom > vpTop + 5 && rect.top < vpTop + 500
              && (!best || Math.abs(rect.top - vpTop) < Math.abs(best.top - vpTop)))
              best = { id: frame.dataset?.frameId || '?', top: rect.top };
          }
          if (best) {
            const y = Math.round(vp.scrollTop);
            const off = Math.round(best.top - vpTop);
            const key = `${best.id}:${off}:${y}`;
            const nowAt = Date.now();
            if (key !== lastFocalKey && nowAt - lastFocalAt >= 60) {
              lastFocalKey = key;
              lastFocalAt = nowAt;
              rec('focal', { id: best.id.slice(0, 60), off, y });
            }
          }
        }
      }
    } catch { /* sampling is best-effort */ }
    requestAnimationFrame(sampleFocal);
  };
  requestAnimationFrame(sampleFocal);

  // 5. Layout shifts — the content-visibility height jump shows up HERE even
  //    when no scrollTop write happens (pure layout leap under a still finger).
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        rec('shift', {
          v: Math.round((entry.value || 0) * 1000) / 1000,
          nodes: entry.sources ? entry.sources.length : 0,
          recent: entry.hadRecentInput === true ? 1 : 0,
        });
    }).observe({ type: 'layout-shift', buffered: true });
  } catch { /* observer type unsupported */ }

  // 6. Render counters, once per 1.5s while active: did a full rebuild race
  //    the gesture (shell/thread/frameItem deltas)?
  let lastStatsKey = '';
  setInterval(() => {
    try {
      const app = document.querySelector('kikx-app');
      const stats = app?._renderStats;
      if (!stats)
        return;
      const key = `s${stats.shell}|t${stats.thread}|c${stats.chatView}|f${stats.frameItem}`;
      if (key !== lastStatsKey) {
        const hadFirst = lastStatsKey !== '';
        lastStatsKey = key;
        if (hadFirst)
          rec('render', { shell: stats.shell, thread: stats.thread, chat: stats.chatView, items: stats.frameItem });
      }
    } catch { /* best-effort */ }
  }, 1500);

  // 7. Flush cadence + a last gasp when the tab hides.
  setInterval(() => { void telemetryFlush(); }, 500);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden')
      void telemetryFlush();
  });
}

async function telemetryFlush() {
  try {
    await singleton?.flushNow();
  } catch { /* factory already guards */ }
}

// Wired from setDebugMode and from boot when kikx.debug was already on.
export function startScrollTelemetry(app) {
  if (!app || typeof app._postJSON !== 'function')
    return null;
  if (startedApps.has(app)) {
    singleton?.setActive(true);
    return singleton;
  }
  startedApps.add(app);
  singleton = createScrollTelemetry({
    post: (body) => app._postJSON('/api/v1/debug/scroll-events', body),
  });
  singleton.setActive(true);
  if (!instrumentsInstalled) {
    installInstruments();
    instrumentsInstalled = true;
  }
  return singleton;
}

export function setActiveScrollTelemetry(app, active) {
  if (singleton && startedApps.has(app))
    singleton.setActive(active === true);
  else if (active === true)
    startScrollTelemetry(app);
}
