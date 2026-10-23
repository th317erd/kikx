'use strict';

// Opt-in scroll diagnostics. Enable with ?scrolllog=1 or localStorage
// kikx.scrollLog=1. The logger keeps a bounded in-memory ring so a sudden jump
// can be inspected after the fact:
//   window.kikxScrollLog.dump()
//   window.kikxScrollLog.copy()
// It records scroll events, programmatic scrollTop writes with stacks, focus
// changes, hash rewrites, and frame-list DOM changes, together with the current
// lock/anchor/window state.

const STORAGE_KEY = 'kikx.scrollLog';
const MAX_ENTRIES = 1200;
const STACK_LIMIT = 12;

let installed = false;
let enabled = false;
let observer = null;
let entries = [];
let lastTops = new WeakMap();
let lastScrollRecordAt = 0;
let lastDOMRecordAt = 0;
let sequence = 0;

function loggerEnabled() {
  try {
    let flag = new URLSearchParams(globalThis.location?.search || '').get('scrolllog');
    if (flag === '0')
      return false;
    if (flag === '1' || globalThis.localStorage?.getItem(STORAGE_KEY) === '1')
      return true;
    // The owner's dev UI runs on localhost. Keep the bounded ring active there
    // so a random jump can be copied without asking them to enable anything
    // after the fact.
    return globalThis.location?.hostname === '127.0.0.1'
      || globalThis.location?.hostname === 'localhost';
  } catch (_error) {
    return false;
  }
}

function shortStack(error = new Error()) {
  return String(error?.stack || '')
    .split('\n')
    .slice(2, STACK_LIMIT)
    .map((line) => line.trim())
    .join('\n');
}

function frameList() {
  return globalThis.document?.querySelector?.('.kikx-frame-list') || null;
}

function snapshot() {
  let list = frameList();
  let app = globalThis.document?.querySelector?.('kikx-app') || null;
  let view = globalThis.document?.querySelector?.('.kikx-thread__body kikx-chat-view') || null;
  let items = list ? [ ...list.querySelectorAll('kikx-frame-item') ] : [];
  let listRect = list?.getBoundingClientRect?.();
  let topItem = listRect
    ? items.find((item) => item.getBoundingClientRect().bottom > listRect.top + 1)
    : null;
  let lastItem = items.at(-1) || null;
  let button = globalThis.document?.querySelector?.('.kikx-session-toolbar__button--lock') || null;
  let sessionID = app?._state?.selectedSessionID || '';
  let mode = null;
  try {
    mode = sessionID ? globalThis.localStorage?.getItem(`kikx.scrollLockMode.${sessionID}`) : null;
  } catch (_error) {}

  return {
    scrollTop: list ? Math.round(list.scrollTop) : null,
    maxScrollTop: list ? Math.round(list.scrollHeight - list.clientHeight) : null,
    fromBottom: list ? Math.round(list.scrollHeight - list.scrollTop - list.clientHeight) : null,
    scrollHeight: list?.scrollHeight ?? null,
    clientHeight: list?.clientHeight ?? null,
    frameItems: items.length,
    stateFrames: sessionID ? app?._state?.framesBySessionID?.[sessionID]?.length ?? null : null,
    firstFrameID: items[0]?.dataset.frameId || null,
    lastFrameID: lastItem?.dataset.frameId || null,
    topFrameID: topItem?.dataset.frameId || null,
    topFrameOffset: topItem && listRect ? Math.round(topItem.getBoundingClientRect().top - listRect.top) : null,
    windowStartFrameID: view?.windowStartFrameID || null,
    lockPressed: button?.getAttribute('aria-pressed') || null,
    lockTitle: button?.title || null,
    lockMode: mode,
    anchoredToBottom: app?._frameListAnchoredToBottom ?? null,
    animation: Boolean(app?._frameListScrollAnimation),
    ignoreScrollForMS: app ? Math.max(0, Math.round((app._ignoreFrameScrollUntil || 0) - Date.now())) : null,
    hashAnchorPending: Boolean(app?._hashAnchorPending),
    sentinelSuppressed: Boolean(app?._sentinelSuppressed),
    hashRestoredFor: app?._hashRestoredSessionID || null,
    hash: globalThis.location?.hash || '',
    activeElement: globalThis.document?.activeElement
      ? `${globalThis.document.activeElement.localName || ''}.${globalThis.document.activeElement.className || ''}`
      : '',
  };
}

function record(type, data = {}) {
  if (!enabled)
    return;
  let entry = {
    seq: ++sequence,
    at: new Date().toISOString(),
    perf: Math.round(globalThis.performance?.now?.() || 0),
    type,
    ...snapshot(),
    ...data,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES)
    entries = entries.slice(-MAX_ENTRIES);
  return entry;
}

function frameTarget(node) {
  if (!node || node.nodeType !== 1)
    return false;
  return Boolean(node.closest?.('.kikx-frame-list, .kikx-frame-item'));
}

function installSetterTrap() {
  let descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  if (!descriptor?.get || !descriptor?.set)
    return;

  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    enumerable: descriptor.enumerable,
    get() {
      return descriptor.get.call(this);
    },
    set(value) {
      let before = descriptor.get.call(this);
      let stack = enabled && this.matches?.('.kikx-frame-list') ? shortStack() : '';
      descriptor.set.call(this, value);
      if (stack)
        record('scrollTop-write', { before: Math.round(before), requested: Math.round(Number(value)), writeStack: stack });
    },
  });
}

function wrapMethod(proto, name, type) {
  let original = proto?.[name];
  if (typeof original !== 'function')
    return;
  proto[name] = function(...args) {
    let log = enabled && this?.matches?.('.kikx-frame-list, .kikx-frame-item');
    let stack = log ? shortStack() : '';
    let result = original.apply(this, args);
    if (log)
      record(type, { args: args.map((arg) => typeof arg === 'object' ? { ...arg } : arg), callStack: stack });
    return result;
  };
}

function installObservers() {
  if (observer || typeof MutationObserver !== 'function')
    return;

  observer = new MutationObserver((mutations) => {
    if (!enabled)
      return;
    let relevant = mutations.filter((mutation) => (
      frameTarget(mutation.target)
      || [ ...(mutation.addedNodes || []) ].some(frameTarget)
      || [ ...(mutation.removedNodes || []) ].some(frameTarget)
    ));
    if (relevant.length === 0)
      return;
    let now = Date.now();
    if (now - lastDOMRecordAt < 500)
      return;
    lastDOMRecordAt = now;
    record('dom', {
      mutations: relevant.slice(0, 8).map((mutation) => ({
        kind: mutation.type,
        added: mutation.addedNodes?.length || 0,
        removed: mutation.removedNodes?.length || 0,
        target: `${mutation.target?.localName || ''}.${mutation.target?.className || ''}`,
      })),
    });
  });
  observer.observe(globalThis.document.documentElement, { childList: true, subtree: true });
}

function installListeners() {
  globalThis.document?.addEventListener?.('scroll', (event) => {
    if (!enabled || !frameTarget(event.target))
      return;
    let node = event.target.matches?.('.kikx-frame-list') ? event.target : event.target.closest?.('.kikx-frame-list');
    if (!node)
      return;
    let previous = lastTops.get(node);
    let current = Math.round(node.scrollTop);
    let delta = previous == null ? 0 : current - previous;
    lastTops.set(node, current);
    let now = Date.now();
    // Full snapshots walk the rendered frame window; do not tax every wheel tick.
    // Jumps are always captured, ordinary scrolling is sampled.
    if (Math.abs(delta) > 120 || now - lastScrollRecordAt > 750) {
      lastScrollRecordAt = now;
      record('scroll', { delta });
    }
  }, { capture: true, passive: true });

  let lastWheelLog = 0;
  globalThis.document?.addEventListener?.('wheel', (event) => {
    if (!enabled || !frameTarget(event.target))
      return;
    let now = Date.now();
    if (now - lastWheelLog < 120)
      return;
    lastWheelLog = now;
    record('input', { kind: 'wheel', deltaX: event.deltaX, deltaY: event.deltaY });
  }, { capture: true, passive: true });

  globalThis.document?.addEventListener?.('keydown', (event) => {
    if (!enabled)
      return;
    record('input', { kind: 'key', key: event.key, ctrl: event.ctrlKey === true, shift: event.shiftKey === true, meta: event.metaKey === true });
  }, { capture: true });

  globalThis.document?.addEventListener?.('pointerdown', (event) => {
    if (!enabled || !frameTarget(event.target))
      return;
    record('input', { kind: 'pointerdown', button: event.button, clientX: event.clientX, clientY: event.clientY });
  }, { capture: true, passive: true });

  globalThis.document?.addEventListener?.('touchmove', (event) => {
    if (!enabled || !frameTarget(event.target))
      return;
    record('input', { kind: 'touchmove', touches: event.touches?.length || 0 });
  }, { capture: true, passive: true });

  globalThis.document?.addEventListener?.('focusin', (event) => {
    if (!enabled)
      return;
    record('focus', {
      target: `${event.target?.localName || ''}.${event.target?.className || ''}`,
      focusStack: shortStack(),
    });
  }, { capture: true });

  let history = globalThis.history;
  if (history && typeof history.replaceState === 'function') {
    let original = history.replaceState.bind(history);
    history.replaceState = function(...args) {
      let before = globalThis.location.hash;
      let result = original(...args);
      if (enabled && before !== globalThis.location.hash)
        record('hash', { before, after: globalThis.location.hash, hashStack: shortStack() });
      return result;
    };
  }
}

function install() {
  if (installed)
    return;
  installed = true;
  enabled = loggerEnabled();
  installSetterTrap();
  wrapMethod(Element.prototype, 'scrollTo', 'scrollTo');
  wrapMethod(Element.prototype, 'scrollBy', 'scrollBy');
  wrapMethod(Element.prototype, 'scrollIntoView', 'scrollIntoView');
  installListeners();
  if (enabled)
    installObservers();

  globalThis.kikxScrollLog = {
    get enabled() { return enabled; },
    enable() {
      enabled = true;
      try { globalThis.localStorage?.setItem(STORAGE_KEY, '1'); } catch (_error) {}
      installObservers();
      record('enabled');
    },
    disable() {
      enabled = false;
      try { globalThis.localStorage?.removeItem(STORAGE_KEY); } catch (_error) {}
    },
    clear() {
      entries = [];
      sequence = 0;
    },
    dump() {
      return entries.slice();
    },
    copy() {
      return JSON.stringify(entries, null, 2);
    },
    async copyToClipboard() {
      let text = JSON.stringify(entries, null, 2);
      await globalThis.navigator?.clipboard?.writeText?.(text);
      return text.length;
    },
    download() {
      let blob = new Blob([ JSON.stringify(entries, null, 2) ], { type: 'application/json' });
      let link = globalThis.document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `kikx-scroll-log-${Date.now()}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    },
  };
}

export function installScrollDebugLogger() {
  if (typeof window === 'undefined'
    || typeof document === 'undefined'
    || typeof Element === 'undefined')
    return;
  install();
}
