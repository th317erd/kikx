'use strict';

// Regression coverage for the production outage where a missing vendored
// component (/vendor/aeor-web-components/components/aeor-progress-button.js)
// made a hard static import reject the whole client module graph. The optional
// loader must absorb that failure so the app still boots, and the session card
// must fall back to plain buttons so its actions keep working.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import {
  formatOptionalLoadFailure,
  loadOptionalModules,
} from '../../src/client/lib/optional-import.mjs';
import { installDom } from './support/mini-dom.mjs';

// The session card reaches aeor-ui's /vendor/... imports; redirect them to the
// same local stand-ins the other client specs use.
register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document, registry: customElements } = installDom();

// The card embeds a kikx-chat-view whose mini renderer needs DOM APIs the
// mini-DOM does not implement; record updates with a stub instead.
class StubChatView extends HTMLElement {
  constructor() {
    super();
    this.mode = 'full';
    this.updates = [];
  }

  update(values) {
    this.updates.push(values);
  }
}
customElements.define('kikx-chat-view', StubChatView);

await import('../../src/client/components/kikx-session-card.mjs');

function mountCard(input = {}) {
  let card = document.createElement('kikx-session-card');
  card.update({
    session: { id: 'ses_1', title: 'Alpha' },
    ...input,
  });
  return card;
}

function actionButtons(card) {
  return [ ...card.querySelectorAll('.kikx-session-card__action') ];
}

// Force `customElements.get('aeor-progress-button')` to return undefined for one
// synchronous block, so the fallback path is provable regardless of test order
// or the registry's process-global state.
function withProgressButtonUndefined(run) {
  let originalGet = customElements.get;
  customElements.get = function get(name) {
    if (name === 'aeor-progress-button')
      return undefined;
    return originalGet.call(this, name);
  };
  try {
    return run();
  } finally {
    customElements.get = originalGet;
  }
}

test('a rejected optional import resolves and reports exactly that failure', async () => {
  let missingURL = '/vendor/aeor-web-components/components/aeor-progress-button.js';
  let attempted = [];
  let importModule = (url) => {
    attempted.push(url);
    if (url === missingURL)
      return Promise.reject(new Error('Failed to fetch dynamically imported module'));
    return Promise.resolve();
  };

  let failures = await loadOptionalModules([ '/a.js', missingURL, '/c.js' ], { importModule });

  assert.deepEqual(attempted, [ '/a.js', missingURL, '/c.js' ], 'every module is still attempted');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].url, missingURL);
  assert.match(failures[0].message, /dynamically imported module/);
});

test('all imports succeeding returns an empty failure list', async () => {
  let failures = await loadOptionalModules([ '/a.js', '/b.js' ], {
    importModule: () => Promise.resolve(),
  });

  assert.deepEqual(failures, []);
});

test('multiple failures are all reported, each with its own message', async () => {
  let importModule = (url) => Promise.reject(new Error(`missing ${url}`));

  let failures = await loadOptionalModules([ '/a.js', '/b.js', '/c.js' ], { importModule });

  assert.deepEqual(failures.map((failure) => failure.url), [ '/a.js', '/b.js', '/c.js' ]);
  assert.deepEqual(failures.map((failure) => failure.message), [
    'missing /a.js',
    'missing /b.js',
    'missing /c.js',
  ]);
});

test('an onError callback that throws cannot abort the remaining imports', async () => {
  let seen = [];
  let importModule = (url) => {
    if (url.startsWith('/bad-'))
      return Promise.reject(new Error(`boom ${url}`));
    return Promise.resolve();
  };

  let failures = await loadOptionalModules([ '/ok.js', '/bad-1.js', '/ok-2.js', '/bad-2.js' ], {
    importModule,
    onError: ({ url }) => {
      seen.push(url);
      throw new Error('onError exploded');
    },
  });

  assert.deepEqual(seen, [ '/bad-1.js', '/bad-2.js' ], 'onError is called for every failure');
  assert.deepEqual(failures.map((failure) => failure.url), [ '/bad-1.js', '/bad-2.js' ]);
});

test('a synchronous throw from importModule is caught too', async () => {
  let importModule = (url) => {
    throw new Error(`sync ${url}`);
  };

  let failures = await loadOptionalModules([ '/a.js' ], { importModule });

  assert.equal(failures.length, 1);
  assert.equal(failures[0].message, 'sync /a.js');
});

test('the default importer rejects on a missing file but the loader still resolves', async () => {
  let missing = new URL('./support/does-not-exist-optional.mjs', import.meta.url).href;

  let failures = await loadOptionalModules([ missing ]);

  assert.equal(failures.length, 1);
  assert.equal(failures[0].url, missing);
  assert.ok(failures[0].message.length > 0);
});

test('formatOptionalLoadFailure renders a single human-readable line', () => {
  let text = formatOptionalLoadFailure({ url: '/vendor/x.js', message: 'not found' });

  assert.equal(text, 'Optional module failed to load: /vendor/x.js — not found');
  assert.equal(text.includes('\n'), false);
});

test('without aeor-progress-button the card builds plain buttons whose clicks act', () => {
  withProgressButtonUndefined(() => {
    let card = mountCard();
    let [ openButton, deleteButton ] = actionButtons(card);

    assert.ok(openButton, 'the Open action must exist');
    assert.ok(deleteButton, 'the Delete action must exist');
    assert.equal(openButton.localName, 'button', 'fallback Open is a plain button');
    assert.equal(deleteButton.localName, 'button', 'fallback Delete is a plain button');
    assert.equal(openButton.type, 'button');
    assert.equal(deleteButton.type, 'button');

    assert.ok(openButton.classList.contains('kikx-session-card__action'));
    assert.ok(openButton.classList.contains('kikx-session-card__action--open'));
    assert.ok(deleteButton.classList.contains('kikx-session-card__action--delete'));
    assert.ok(deleteButton.classList.contains('progress-button-danger'));
    assert.equal(openButton.getAttribute('aria-label'), 'Open Alpha');
    assert.equal(deleteButton.getAttribute('aria-label'), 'Delete Alpha');
    assert.equal(deleteButton.getAttribute('title'), 'Hold 1s to delete');

    let opens = [];
    let deletes = [];
    card.addEventListener('kikx-card-open', (event) => opens.push(event.detail));
    card.addEventListener('kikx-card-delete', (event) => deletes.push(event.detail));

    openButton.dispatchEvent(new CustomEvent('click', { bubbles: true }));
    deleteButton.dispatchEvent(new CustomEvent('click', { bubbles: true }));

    assert.deepEqual(opens, [ { sessionID: 'ses_1' } ]);
    assert.deepEqual(deletes, [ { sessionID: 'ses_1' } ]);
  });
});

test('with aeor-progress-button defined the card builds the component', () => {
  if (!customElements.get('aeor-progress-button')) {
    class StubProgressButton extends HTMLElement {
      constructor() {
        super();
        this.disabled = false;
      }
    }
    customElements.define('aeor-progress-button', StubProgressButton);
  }

  let card = mountCard();
  let buttons = [ ...card.querySelectorAll('aeor-progress-button') ];

  assert.equal(buttons.length, 2, 'both actions use the component when present');
  assert.equal(buttons[0].localName, 'aeor-progress-button');
  assert.equal(buttons[0].getAttribute('icon'), 'open');
  assert.equal(buttons[0].getAttribute('duration'), '0');
  assert.equal(buttons[1].getAttribute('icon'), 'delete');
  assert.equal(buttons[1].getAttribute('duration'), '1000');
  assert.ok(buttons[1].classList.contains('progress-button-danger'));
});
