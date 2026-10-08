'use strict';

// S1 error containment: the boundary helper, the bounded recent-errors store,
// the defensive reporting path, and the global capture lifecycle wired into the
// app element.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document, registry: customElements, window } = installDom();

class ThrowingFrame extends HTMLElement {
  updateFrame() {
    throw new Error('frame renderer exploded');
  }
}
customElements.define('kikx-throwing-frame', ThrowingFrame);

const {
  RECENT_ERROR_LIMIT,
  clearRecentErrors,
  guardClientOperation,
  installGlobalErrorCapture,
  listRecentErrors,
  reportClientError,
  subscribeToRecentErrors,
  uninstallGlobalErrorCapture,
} = await import('../../src/client/lib/error-boundary.mjs');

await import('../../src/client/components/kikx-frame-item.mjs');
await import('../../src/client/components/kikx-app.mjs');

function quietConsole(callback) {
  let original = console.error;
  console.error = () => {};
  try {
    return callback();
  } finally {
    console.error = original;
  }
}

function createHost() {
  let listeners = new Map();
  return {
    onerror: null,
    _listeners: listeners,
    addEventListener(type, listener) {
      let bucket = listeners.get(type);
      if (!bucket) {
        bucket = [];
        listeners.set(type, bucket);
      }
      bucket.push(listener);
    },
    removeEventListener(type, listener) {
      let bucket = listeners.get(type);
      if (!bucket)
        return;
      let index = bucket.indexOf(listener);
      if (index >= 0)
        bucket.splice(index, 1);
    },
    dispatchEvent(event) {
      for (let listener of [ ...(listeners.get(event.type) || []) ])
        listener(event);
    },
  };
}

test('guardClientOperation contains a synchronous throw and never throws', () => {
  clearRecentErrors();
  let reports = 0;
  let unsubscribe = subscribeToRecentErrors(() => { reports += 1; });
  try {
    let result = quietConsole(() => guardClientOperation('sync-test', () => {
      throw new Error('sync boom');
    }));
    assert.equal(result, undefined);
  } finally {
    unsubscribe();
  }
  assert.equal(reports, 1);
  assert.equal(listRecentErrors().length, 1);
  assert.equal(listRecentErrors()[0].label, 'sync-test');
  assert.equal(listRecentErrors()[0].message, 'sync boom');
});

test('guardClientOperation is await-safe for a rejected operation', async () => {
  clearRecentErrors();
  let original = console.error;
  console.error = () => {};
  let result;
  try {
    result = await guardClientOperation('async-test', async () => {
      throw new Error('async boom');
    });
  } finally {
    console.error = original;
  }
  assert.equal(result, undefined);
  assert.equal(listRecentErrors().length, 1);
  assert.equal(listRecentErrors()[0].message, 'async boom');
});

test('guardClientOperation passes through resolved values', async () => {
  clearRecentErrors();
  assert.equal(guardClientOperation('value-test', () => 42), 42);
  assert.equal(await guardClientOperation('await-test', async () => 'ok'), 'ok');
  assert.equal(listRecentErrors().length, 0);
});

test('the same failure object is reported exactly once across boundaries', () => {
  clearRecentErrors();
  let reports = 0;
  let unsubscribe = subscribeToRecentErrors(() => { reports += 1; });
  let failure = new Error('once');
  try {
    quietConsole(() => {
      reportClientError('inner', failure, {});
      reportClientError('outer', failure, {});
    });
  } finally {
    unsubscribe();
  }
  assert.equal(reports, 1);
  assert.equal(listRecentErrors().length, 1);
});

test('the recent-errors store is bounded and keeps the newest entries', () => {
  clearRecentErrors();
  quietConsole(() => {
    for (let index = 0; index < RECENT_ERROR_LIMIT + 10; index++)
      reportClientError(`boom-${index}`, new Error(`failure ${index}`), {});
  });

  let errors = listRecentErrors();
  assert.equal(errors.length, RECENT_ERROR_LIMIT);
  assert.equal(errors[0].message, 'failure 10');
  assert.equal(errors[errors.length - 1].message, `failure ${RECENT_ERROR_LIMIT + 9}`);
});

test('a throwing console and a throwing subscriber cannot break the boundary', () => {
  clearRecentErrors();
  let original = console.error;
  let reports = 0;
  console.error = () => { throw new Error('console down'); };
  let first = subscribeToRecentErrors(() => { throw new Error('surface down'); });
  let second = subscribeToRecentErrors(() => { reports += 1; });
  try {
    assert.doesNotThrow(() => guardClientOperation('defensive', () => {
      throw new Error('contained');
    }));
  } finally {
    console.error = original;
    first();
    second();
  }
  assert.equal(reports, 1);
  assert.equal(listRecentErrors().length, 1);
});

test('listRecentErrors returns a snapshot, not the live buffer', () => {
  clearRecentErrors();
  quietConsole(() => reportClientError('snapshot', new Error('one'), {}));
  let snapshot = listRecentErrors();
  snapshot.length = 0;
  assert.equal(listRecentErrors().length, 1);
});

test('a throwing custom frame renderer is reported exactly once by the item boundary', () => {
  clearRecentErrors();
  let item = document.createElement('kikx-frame-item');
  let state = { clientFrameComponentsByType: { BoomThing: { tagName: 'kikx-throwing-frame' } } };

  quietConsole(() => {
    assert.doesNotThrow(() => item.updateFrame({ id: 'boom', type: 'BoomThing' }, state));
  });

  let errors = listRecentErrors();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'frame renderer exploded');
});

test('installGlobalErrorCapture installs and tears down both global handlers', () => {
  clearRecentErrors();
  let host = createHost();
  let previous = () => {};
  host.onerror = previous;
  let app = {};

  installGlobalErrorCapture(app, host);
  assert.equal(typeof host.onerror, 'function');
  assert.equal(host._listeners.get('unhandledrejection')?.length, 1);

  quietConsole(() => host.onerror('message', 'file.js', 1, 2, new Error('window error')));
  assert.equal(listRecentErrors().length, 1);
  assert.equal(listRecentErrors()[0].label, 'window.onerror');

  quietConsole(() => host.dispatchEvent({ type: 'unhandledrejection', reason: new Error('rejected') }));
  assert.equal(listRecentErrors().length, 2);
  assert.equal(listRecentErrors()[1].label, 'unhandledrejection');

  uninstallGlobalErrorCapture(app);
  assert.equal(host.onerror, previous);
  assert.equal(host._listeners.get('unhandledrejection')?.length ?? 0, 0);
});

test('installGlobalErrorCapture is idempotent for one app', () => {
  clearRecentErrors();
  let host = createHost();
  let app = {};
  installGlobalErrorCapture(app, host);
  installGlobalErrorCapture(app, host);
  assert.equal(host._listeners.get('unhandledrejection').length, 1);
  uninstallGlobalErrorCapture(app);
  assert.equal(host._listeners.get('unhandledrejection').length, 0);
});

test('KikxApp installs the global capture on connect and removes it on disconnect', () => {
  clearRecentErrors();
  let previousOnError = window.onerror;
  let app = document.createElement('kikx-app');
  app._render = () => {};
  let container = document.createElement('div');

  container.appendChild(app);
  assert.equal(typeof window.onerror, 'function');
  assert.equal(window.listenerCount('unhandledrejection'), 1);

  container.removeChild(app);
  assert.equal(window.onerror, previousOnError);
  assert.equal(window.listenerCount('unhandledrejection'), 0);
});

test('KikxApp reinstalls global capture after a disconnect/reconnect cycle', () => {
  clearRecentErrors();
  let previousOnError = window.onerror;
  let app = document.createElement('kikx-app');
  app._render = () => {};
  let container = document.createElement('div');

  container.appendChild(app);
  container.removeChild(app);
  assert.equal(window.onerror, previousOnError);
  assert.equal(window.listenerCount('unhandledrejection'), 0);

  // Re-parenting (or re-appending) must restore capture, not just mount once.
  container.appendChild(app);
  assert.equal(typeof window.onerror, 'function');
  assert.equal(window.listenerCount('unhandledrejection'), 1);

  quietConsole(() => window.onerror('message', 'file.js', 1, 2, new Error('after reconnect')));
  assert.equal(listRecentErrors().length, 1);
  assert.equal(listRecentErrors()[0].label, 'window.onerror');

  container.removeChild(app);
  assert.equal(window.onerror, previousOnError);
  assert.equal(window.listenerCount('unhandledrejection'), 0);
});

test('the unhandledrejection handler prevents the browser default too', () => {
  clearRecentErrors();
  let host = createHost();
  let app = {};
  let prevented = 0;

  installGlobalErrorCapture(app, host);
  let event = {
    type: 'unhandledrejection',
    reason: new Error('rejected'),
    preventDefault: () => { prevented += 1; },
  };
  quietConsole(() => host.dispatchEvent(event));
  assert.equal(prevented, 1, 'the browser duplicate must be suppressed');

  uninstallGlobalErrorCapture(app);
});

test('a dismissed error can be reported again through the same Error object', () => {
  clearRecentErrors();
  let reports = 0;
  let unsubscribe = subscribeToRecentErrors(() => { reports += 1; });
  let failure = new Error('dismissed then repeated');
  try {
    quietConsole(() => reportClientError('boom', failure, {}));
    assert.equal(listRecentErrors().length, 1);
    assert.equal(reports, 1);

    clearRecentErrors();
    assert.equal(listRecentErrors().length, 0);

    quietConsole(() => reportClientError('boom', failure, {}));
    assert.equal(listRecentErrors().length, 1, 'the cleared entry must be re-recorded');
    assert.equal(reports, 2, 'the re-report must notify again');
  } finally {
    unsubscribe();
  }
});

test('a persistently failing renderer is throttled by label+message but still recorded', () => {
  clearRecentErrors();
  let reports = 0;
  let logged = 0;
  let original = console.error;
  console.error = () => { logged += 1; };
  let unsubscribe = subscribeToRecentErrors(() => { reports += 1; });
  try {
    for (let index = 0; index < 25; index++)
      reportClientError('stream.render', new Error('same failure'), { index });
  } finally {
    console.error = original;
    unsubscribe();
  }

  let errors = listRecentErrors();
  assert.equal(errors.length, 1, 'the flood must not churn the bounded ring');
  assert.equal(reports, 1, 'the surface must be notified once');
  assert.equal(logged, 1, 'console.error must stay bounded');
  assert.equal(errors[0].count, 25, 'every occurrence must still be recorded');
});

test('removing the app shell through the DOM unsubscribes the nested error surface', () => {
  clearRecentErrors();
  let app = document.createElement('kikx-app');
  app._buildAuthShell = () => {
    let stub = document.createElement('div');
    stub.className = 'stub-auth-shell';
    return stub;
  };
  app._render();

  let surface = app.querySelector('kikx-error-surface');
  assert.ok(surface, 'the shell render must include an error surface');

  quietConsole(() => reportClientError('removal', new Error('before removal'), {}));
  assert.match(surface.textContent, /1 error/);

  let shell = app.querySelector('.kikx-shell');
  assert.ok(shell, 'the shell must be present');
  app.removeChild(shell);

  // If the nested surface were still subscribed, this report would re-render it
  // to two. The shim now fires disconnectedCallback for the removed subtree, so
  // the real removal path is what unsubscribes it.
  quietConsole(() => reportClientError('removal-after', new Error('after removal'), {}));
  assert.match(surface.textContent, /1 error/);
  assert.doesNotMatch(surface.textContent, /2 errors/);
});

test('a first-render failure still mounts a visible, dismissible error surface', () => {
  clearRecentErrors();
  let app = document.createElement('kikx-app');
  app._buildAuthShell = () => {
    throw new Error('first shell exploded');
  };

  quietConsole(() => assert.doesNotThrow(() => app._render()));

  let surface = app.querySelector('kikx-error-surface');
  assert.ok(surface, 'a standalone error host must be mounted when the first shell build fails');
  assert.match(surface.textContent, /1 error/);
  assert.equal(surface.getAttribute('role'), 'status');
  assert.equal(surface.getAttribute('aria-live'), 'polite');

  surface.querySelector('.kikx-error-surface__chip').dispatchEvent({ type: 'click' });
  let list = surface.querySelector('.kikx-error-surface__list');
  assert.ok(list, 'the failure list must expand');
  assert.equal(list.getAttribute('role'), 'alert');

  surface.querySelector('.kikx-error-surface__dismiss').dispatchEvent({ type: 'click' });
  assert.equal(listRecentErrors().length, 0);
  assert.equal(surface.classList.contains('kikx-error-surface--empty'), true);
});

test('the error surface shows a count, expands, and dismisses', () => {
  clearRecentErrors();
  quietConsole(() => reportClientError('boom', new Error('one'), {}));

  let container = document.createElement('div');
  let surface = document.createElement('kikx-error-surface');
  container.appendChild(surface);
  assert.match(surface.textContent, /1 error/);
  assert.equal(surface.classList.contains('kikx-error-surface--empty'), false);

  surface.querySelector('.kikx-error-surface__chip').dispatchEvent({ type: 'click' });
  assert.match(surface.textContent, /boom: one/);
  assert.equal(surface.querySelector('.kikx-error-surface__list').getAttribute('role'), 'alert');

  surface.querySelector('.kikx-error-surface__dismiss').dispatchEvent({ type: 'click' });
  assert.equal(listRecentErrors().length, 0);
  assert.equal(surface.classList.contains('kikx-error-surface--empty'), true);

  // Teardown goes through the real removal path, never a hand-called callback.
  container.removeChild(surface);
  assert.equal(surface._unsubscribe, null);
});
