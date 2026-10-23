'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();

let values = new Map();
globalThis.localStorage = {
  getItem(key) {
    return values.has(key) ? values.get(key) : null;
  },
  setItem(key, value) {
    values.set(key, String(value));
  },
  removeItem(key) {
    values.delete(key);
  },
};

const {
  buildScrollLockToolbar,
  getScrollLockModeForSession,
  isScrollLockedForSession,
  setScrollLockedForSession,
  setScrollLockModeForSession,
} = await import('../../src/client/components/kikx-scroll-lock.mjs');
const { armScrollLockRearm, ensureAutoScrollAfterSend, scrollToLatestMessageTop } = await import('../../src/client/components/kikx-frame-scroll-lock.mjs');
const { maybeLoadOlderFrames } = await import('../../src/client/components/kikx-frame-scroll.mjs');
const { setAnimationFrameScheduler } = await import('../../src/client/components/kikx-app-helpers.mjs');

function resetStorage() {
  values = new Map();
}

test('scroll lock defaults on, persists off, and is per session', () => {
  resetStorage();
  assert.equal(isScrollLockedForSession({ _state: { selectedSessionID: 's1' } }, 's1'), true);
  assert.equal(isScrollLockedForSession({ _state: { selectedSessionID: 's2' } }, 's2'), true);

  setScrollLockedForSession({ _state: { selectedSessionID: 's1' } }, false, 's1');
  assert.equal(isScrollLockedForSession({ _state: { selectedSessionID: 's1' } }, 's1'), false);
  assert.equal(isScrollLockedForSession({ _state: { selectedSessionID: 's2' } }, 's2'), true);
  assert.equal(getScrollLockModeForSession({ _state: { selectedSessionID: 's1' } }, 's1'), 'top');
  setScrollLockModeForSession({ _state: { selectedSessionID: 's1' } }, 'bottom', 's1');
  assert.equal(getScrollLockModeForSession({ _state: { selectedSessionID: 's1' } }, 's1'), 'bottom');
});

test('the header lock button reflects and toggles the session state', () => {
  resetStorage();
  let app = document.createElement('div');
  app._state = { selectedSessionID: 's1' };
  app._toggleCalls = 0;
  app._toggleScrollLock = () => { app._toggleCalls += 1; };
  let toolbar = buildScrollLockToolbar(app, 's1');
  app.appendChild(toolbar);

  let button = app.querySelector('.kikx-session-toolbar__button--lock');
  assert.ok(button);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.dataset.icon, 'lock-locked');

  setScrollLockedForSession(app, false, 's1');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(button.dataset.icon, 'lock-unlocked');

  button.dispatchEvent({ type: 'click' });
  assert.equal(app._toggleCalls, 1);
});

test('aligning the latest message puts its top at the viewport top', () => {
  resetStorage();
  let list = {
    scrollTop: 120,
    scrollHeight: 1000,
    clientHeight: 300,
    scrollTo({ top }) { this.scrollTop = top; },
    getBoundingClientRect() { return { top: 100 }; },
    querySelectorAll() {
      return [
        { dataset: { frameId: 'older' }, getBoundingClientRect() { return { top: 100 }; } },
        { dataset: { frameId: 'latest' }, getBoundingClientRect() { return { top: 480 }; } },
      ];
    },
  };
  let app = {
    _state: { selectedSessionID: 's1' },
    _frameListAnchoredToBottom: true,
    querySelector(selector) { return selector === '.kikx-frame-list' ? list : null; },
  };

  assert.equal(scrollToLatestMessageTop(app, { animate: false }), true);
  assert.equal(list.scrollTop, 500);
  assert.equal(app._frameListAnchoredToBottom, false);
});

test('animated latest-message scrolling passes through intermediate positions', () => {
  resetStorage();
  let queue = [];
  setAnimationFrameScheduler((callback) => queue.push(callback));
  try {
    let stream = { offsetTop: 0 };
    let listRect = { top: 100 };
    let item = {
      dataset: { frameId: 'latest' },
      offsetTop: 600,
      offsetParent: stream,
      getBoundingClientRect() { return { top: listRect.top + this.offsetTop - list.scrollTop }; },
    };
    let list = {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 400,
      getBoundingClientRect() { return listRect; },
      querySelector(selector) { return selector === '.kikx-frame-stream' ? stream : null; },
      querySelectorAll() { return [ item ]; },
    };
    let app = {
      _state: { selectedSessionID: 's1' },
      _frameListAnchoredToBottom: true,
      querySelector(selector) { return selector === '.kikx-frame-list' ? list : null; },
    };

    scrollToLatestMessageTop(app, { animate: true });
    assert.equal(queue.length, 1);
    queue.shift()(0);
    assert.equal(list.scrollTop, 0);
    queue.shift()(170);
    assert.ok(list.scrollTop > 0 && list.scrollTop < 600, `intermediate scrollTop was ${list.scrollTop}`);
    queue.shift()(400);
    assert.equal(list.scrollTop, 600);
    assert.equal(list.scrollTop, item.offsetTop);
  } finally {
    setAnimationFrameScheduler(null);
  }
});

test('a suppressed anchor still fills a viewport that cannot scroll', () => {
  resetStorage();
  let loads = 0;
  let list = {
    scrollTop: 0,
    scrollHeight: 500,
    clientHeight: 600,
  };
  let app = {
    _state: { selectedSessionID: 's1', sessionPagingByID: { s1: { hasMoreOlder: true, loading: false } } },
    _sentinelSuppressed: true,
    querySelector(selector) {
      if (selector === '.kikx-frame-list') return list;
      return null;
    },
    _loadOlderFrames() { loads += 1; },
  };
  setScrollLockedForSession(app, false, 's1');

  assert.equal(maybeLoadOlderFrames(app, list), true);
  assert.equal(loads, 1);

  list.scrollHeight = 1400;
  assert.equal(maybeLoadOlderFrames(app, list), false, 'once scrollable, the anchor suppression still applies');
  assert.equal(loads, 1);
});

test('bottom-rest auto-pin engages in bottom mode without moving the viewport', () => {
  resetStorage();
  let list = { scrollTop: 940, scrollHeight: 1000, clientHeight: 600 };
  let view = { windowEnd: 20 };
  let app = {
    _state: {
      selectedSessionID: 's1',
      sessionPagingByID: { s1: { hasMoreNewer: false } },
      framesBySessionID: { s1: Array.from({ length: 20 }, (_value, index) => ({ id: `m${index}` })) },
    },
    _frameListAnchoredToBottom: false,
    querySelector(selector) {
      if (selector === '.kikx-frame-list')
        return list;
      if (selector === '.kikx-thread__body kikx-chat-view')
        return view;
      return null;
    },
  };
  setScrollLockedForSession(app, false, 's1');

  let originalSetTimeout = globalThis.setTimeout;
  let callback = null;
  let delay = null;
  globalThis.setTimeout = (fn, ms) => {
    callback = fn;
    delay = ms;
    return { unref() {} };
  };
  try {
    armScrollLockRearm(app);
    assert.equal(delay, 3000);
    assert.ok(callback);
    callback();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.equal(list.scrollTop, 940, 'engaging the lock must not scroll');
  assert.equal(isScrollLockedForSession(app, 's1'), true);
  assert.equal(getScrollLockModeForSession(app, 's1'), 'bottom');
  assert.equal(app._frameListAnchoredToBottom, true);
});

test('sending while unlocked re-engages bottom follow without overriding a pin mode', () => {
  resetStorage();
  let app = {
    _state: { selectedSessionID: 's1' },
    querySelector() { return null; },
  };

  setScrollLockedForSession(app, false, 's1');
  assert.equal(ensureAutoScrollAfterSend(app), true);
  assert.equal(isScrollLockedForSession(app, 's1'), true);
  assert.equal(getScrollLockModeForSession(app, 's1'), 'bottom');

  setScrollLockModeForSession(app, 'top', 's1');
  assert.equal(ensureAutoScrollAfterSend(app), false);
  assert.equal(getScrollLockModeForSession(app, 's1'), 'top');
});
