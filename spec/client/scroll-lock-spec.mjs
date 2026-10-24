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
  buildScrollLockFloatingButton,
  buildScrollLockToolbar,
  getScrollLockModeForSession,
  isScrollLockedForSession,
  setScrollLockedForSession,
  setScrollLockModeForSession,
} = await import('../../src/client/components/kikx-scroll-lock.mjs');
const {
  breakScrollLockFromUser,
  clearBottomHashMarker,
  ensureAutoScrollAfterSend,
  lockScrollAtBottom,
  maybeRestoreMessageHash,
  scrollToLatestMessageTop,
} = await import('../../src/client/components/kikx-frame-scroll-lock.mjs');
const { afterRender, maybeLoadOlderFrames, onFrameContentResize } = await import('../../src/client/components/kikx-frame-scroll.mjs');
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

test('the floating lock button reflects and toggles the session state', () => {
  resetStorage();
  let app = document.createElement('div');
  app._state = { selectedSessionID: 's1' };
  app._toggleCalls = 0;
  app._toggleScrollLock = () => { app._toggleCalls += 1; };
  let toolbar = buildScrollLockToolbar(app, 's1');
  assert.equal(toolbar.className, 'kikx-session-toolbar', 'the header toolbar remains reserved');
  assert.equal(toolbar.querySelector('.kikx-session-toolbar__button--lock'), null);
  let floating = buildScrollLockFloatingButton(app, 's1');
  app.appendChild(toolbar);
  app.appendChild(floating);

  let button = app.querySelector('.kikx-scroll-lock-floating.kikx-session-toolbar__button--lock');
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

test('a locked bottom render lands at the true bottom immediately', () => {
  resetStorage();
  let app = document.createElement('div');
  app._state = { selectedSessionID: 's1' };
  app._lockedPlacementSessionID = 's1';
  app._onFrameListScroll = () => {};
  let frameList = document.createElement('div');
  frameList.className = 'kikx-frame-list';
  let stream = document.createElement('div');
  stream.className = 'kikx-frame-stream';
  Object.defineProperty(frameList, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(frameList, 'clientHeight', { configurable: true, value: 400 });
  frameList.scrollTop = 0;
  frameList.getBoundingClientRect = () => ({ top: 0 });
  frameList.appendChild(stream);
  app.appendChild(frameList);
  setScrollLockedForSession(app, true, 's1');
  setScrollLockModeForSession(app, 'bottom', 's1');

  afterRender(app, {
    selectedSessionID: 's1',
    frameListPresent: true,
    frameListNearBottom: true,
    frameListScrollTop: 0,
    frameListAnchor: null,
  });

  assert.equal(frameList.scrollTop, 600);
  assert.equal(app._frameListScrollAnimation, null);
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

test('reaching the bottom locks instantly in top mode without moving the viewport', () => {
  resetStorage();
  let list = { scrollTop: 940, scrollHeight: 1000, clientHeight: 600 };
  // The raw state carries one hidden/phantom tail frame that the thread will
  // never render. Tail detection must use the view's projected frame count.
  let view = { windowEnd: 20, frames: Array.from({ length: 20 }, (_value, index) => ({ id: `m${index}` })) };
  let app = {
    _state: {
      selectedSessionID: 's1',
      sessionPagingByID: { s1: { hasMoreNewer: false } },
      framesBySessionID: { s1: Array.from({ length: 21 }, (_value, index) => ({ id: `m${index}` })) },
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

  assert.equal(lockScrollAtBottom(app), true);
  assert.equal(list.scrollTop, 940, 'engaging the lock must not move the viewport');
  assert.equal(isScrollLockedForSession(app, 's1'), true);
  assert.equal(getScrollLockModeForSession(app, 's1'), 'top');
  assert.equal(app._frameListAnchoredToBottom, false);
});

test('a new bottom message clears a stale bottom URL marker', () => {
  resetStorage();
  let items = [
    { dataset: { frameId: 'old' } },
    { dataset: { frameId: 'new' } },
  ];
  let list = { querySelectorAll: () => items };
  let app = {
    _state: { selectedSessionID: 's1' },
    querySelector(selector) {
      return selector === '.kikx-frame-list' ? list : null;
    },
  };
  let originalLocation = globalThis.location;
  let originalHistory = globalThis.history;
  globalThis.location = { pathname: '/', search: '?session=s1', hash: '#message=old&bottom=1' };
  globalThis.history = {
    replaceState(_state, _title, url) {
      let index = String(url).indexOf('#');
      globalThis.location.hash = index >= 0 ? String(url).slice(index) : '';
    },
  };
  try {
    assert.equal(clearBottomHashMarker(app), true);
    assert.equal(globalThis.location.hash, '#message=old');
    assert.equal(app._hashRestoredSessionID, 's1:old:');
    assert.equal(clearBottomHashMarker(app), false, 'the marker is only cleared once');
  } finally {
    globalThis.location = originalLocation;
    globalThis.history = originalHistory;
  }
});

test('a stale bottom marker restores the old message top instead of the bottom', async () => {
  resetStorage();
  let stream = { offsetTop: 0 };
  let items = [
    { dataset: { frameId: 'old' }, offsetTop: 200, offsetParent: stream, getBoundingClientRect: () => ({ top: 300 }) },
    { dataset: { frameId: 'new' }, offsetTop: 800, offsetParent: stream, getBoundingClientRect: () => ({ top: 900 }) },
  ];
  let list = {
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 400,
    getBoundingClientRect: () => ({ top: 100 }),
    querySelector(selector) {
      if (selector === '.kikx-frame-stream') return stream;
      if (selector === 'kikx-frame-item') return items[0];
      return null;
    },
    querySelectorAll: () => items,
  };
  let app = {
    _state: { selectedSessionID: 's1' },
    querySelector(selector) {
      return selector === '.kikx-frame-list' ? list : null;
    },
  };
  setScrollLockedForSession(app, false, 's1');
  let originalLocation = globalThis.location;
  let originalHistory = globalThis.history;
  globalThis.location = { pathname: '/', search: '?session=s1', hash: '#message=old&bottom=1' };
  globalThis.history = {
    replaceState(_state, _title, url) {
      let index = String(url).indexOf('#');
      globalThis.location.hash = index >= 0 ? String(url).slice(index) : '';
    },
  };
  try {
    assert.equal(await maybeRestoreMessageHash(app), true);
    assert.equal(list.scrollTop, 200, 'the old message top wins over the stale bottom marker');
    assert.equal(globalThis.location.hash, '#message=old');
  } finally {
    globalThis.location = originalLocation;
    globalThis.history = originalHistory;
  }
});

test('a user scroll attempt unlocks instantly', () => {
  resetStorage();
  let app = { _state: { selectedSessionID: 's1' } };
  setScrollLockedForSession(app, true, 's1');
  setScrollLockModeForSession(app, 'bottom', 's1');

  breakScrollLockFromUser(app);
  assert.equal(isScrollLockedForSession(app, 's1'), false);
});

test('content growth re-pins the viewport when bottom-locked', () => {
  resetStorage();
  let queue = [];
  setAnimationFrameScheduler((callback) => queue.push(callback));
  try {
    let frameList = {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 400,
      getBoundingClientRect: () => ({ top: 0 }),
      querySelectorAll: () => [],
    };
    let app = {
      _state: { selectedSessionID: 's1' },
      querySelector(selector) {
        return selector === '.kikx-frame-list' ? frameList : null;
      },
    };
    setScrollLockedForSession(app, true, 's1');
    setScrollLockModeForSession(app, 'bottom', 's1');

    onFrameContentResize(app);
    assert.equal(queue.length, 1);
    queue.shift()(0);
    assert.equal(frameList.scrollTop, 600);

    setScrollLockedForSession(app, false, 's1');
    onFrameContentResize(app);
    assert.equal(queue.length, 0, 'unlocked content growth must not move the viewport');
  } finally {
    setAnimationFrameScheduler(null);
  }
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
