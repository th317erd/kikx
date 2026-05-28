'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setupDOM, teardownDOM, getDocument } from './jsdom-helper.mjs';

let debug;

before(async () => {
  setupDOM();
  debug = await import('../../src/client/lib/debug.mjs');
});

after(() => {
  teardownDOM();
});

beforeEach(() => {
  debug.reset();
  try { localStorage.clear(); } catch (_error) { /* ignore */ }
});

describe('debug module', () => {
  it('should default to disabled', () => {
    assert.equal(debug.isEnabled(), false);
  });

  it('should toggle enable/disable and persist to localStorage', () => {
    debug.enable();
    assert.equal(debug.isEnabled(), true);
    assert.equal(localStorage.getItem('kikx_debug'), 'true');

    debug.disable();
    assert.equal(debug.isEnabled(), false);
    assert.equal(localStorage.getItem('kikx_debug'), null);
  });

  it('should restore enabled state from localStorage via init()', () => {
    localStorage.setItem('kikx_debug', 'true');
    debug.init();
    assert.equal(debug.isEnabled(), true);
  });

  it('should no-op trackElement when disabled', () => {
    let document    = getDocument();
    let element     = document.createElement('div');
    let interaction = 'int_test1';

    debug.trackElement(interaction, element);

    assert.equal(debug.getMetadata(element), null);
    assert.deepEqual(debug.getByInteractionID(interaction), []);
  });

  it('should create correct metadata shape when enabled', () => {
    let document = getDocument();
    let element  = document.createElement('div');

    debug.enable();
    debug.trackElement('int_test2', element);

    let metadata = debug.getMetadata(element);
    assert.ok(metadata);
    assert.equal(metadata.interactionID, 'int_test2');
    assert.ok(Array.isArray(metadata.frames));
    assert.equal(metadata.frames.length, 0);
    assert.equal(metadata.streamingHTML, '');
    assert.equal(metadata.reflectionText, '');
    assert.equal(metadata.composedHTML, '');
    assert.equal(metadata.composedAt, null);
    assert.ok(typeof metadata.createdAt === 'string');
  });

  it('should accumulate deep-cloned frames via pushFrame', () => {
    let document = getDocument();
    let element  = document.createElement('div');
    let frame    = { type: 'Message', content: { html: '<p>hello</p>' } };

    debug.enable();
    debug.trackElement('int_test3', element);
    debug.pushFrame('int_test3', frame);

    let metadata = debug.getMetadata(element);
    assert.equal(metadata.frames.length, 1);
    assert.deepEqual(metadata.frames[0], frame);

    // Verify deep clone — mutating original should not affect stored frame
    frame.content.html = '<p>mutated</p>';
    assert.equal(metadata.frames[0].content.html, '<p>hello</p>');
  });

  it('should update streamingHTML via setStreamDelta', () => {
    let document = getDocument();
    let element  = document.createElement('div');

    debug.enable();
    debug.trackElement('int_test4', element);
    debug.setStreamDelta('int_test4', '<p>partial');

    let metadata = debug.getMetadata(element);
    assert.equal(metadata.streamingHTML, '<p>partial');

    debug.setStreamDelta('int_test4', '<p>partial</p><p>more');
    assert.equal(metadata.streamingHTML, '<p>partial</p><p>more');
  });

  it('should update reflectionText via setReflectionDelta', () => {
    let document = getDocument();
    let element  = document.createElement('div');

    debug.enable();
    debug.trackElement('int_test5', element);
    debug.setReflectionDelta('int_test5', 'thinking...');

    let metadata = debug.getMetadata(element);
    assert.equal(metadata.reflectionText, 'thinking...');
  });

  it('should capture innerHTML and timestamp via snapshotComposed', () => {
    let document = getDocument();
    let element  = document.createElement('div');
    element.innerHTML = '<p>final content</p>';

    debug.enable();
    debug.trackElement('int_test6', element);
    debug.snapshotComposed('int_test6');

    let metadata = debug.getMetadata(element);
    assert.equal(metadata.composedHTML, '<p>final content</p>');
    assert.ok(typeof metadata.composedAt === 'string');
    // Should be a valid ISO date
    assert.ok(!isNaN(new Date(metadata.composedAt).getTime()));
  });

  it('should return correct pairs via getByInteractionID', () => {
    let document = getDocument();
    let element  = document.createElement('div');

    debug.enable();
    debug.trackElement('int_test7', element);

    let results = debug.getByInteractionID('int_test7');
    assert.equal(results.length, 1);
    assert.equal(results[0].element, element);
    assert.equal(results[0].metadata.interactionID, 'int_test7');
  });

  it('should return all entries via getAllTracked', () => {
    let document = getDocument();
    let element1 = document.createElement('div');
    let element2 = document.createElement('div');

    debug.enable();
    debug.trackElement('int_a', element1);
    debug.trackElement('int_b', element2);

    let results = debug.getAllTracked();
    assert.equal(results.length, 2);

    let ids = results.map((entry) => entry.interactionID);
    assert.ok(ids.includes('int_a'));
    assert.ok(ids.includes('int_b'));
  });

  it('should support multiple elements per interactionID', () => {
    let document = getDocument();
    let element1 = document.createElement('div');
    let element2 = document.createElement('div');

    debug.enable();
    debug.trackElement('int_shared', element1);
    debug.trackElement('int_shared', element2);

    let results = debug.getByInteractionID('int_shared');
    assert.equal(results.length, 2);
    assert.equal(results[0].element, element1);
    assert.equal(results[1].element, element2);

    // pushFrame should propagate to both
    debug.pushFrame('int_shared', { type: 'Message' });
    assert.equal(debug.getMetadata(element1).frames.length, 1);
    assert.equal(debug.getMetadata(element2).frames.length, 1);
  });

  it('should clear all state via reset', () => {
    let document = getDocument();
    let element  = document.createElement('div');

    debug.enable();
    debug.trackElement('int_reset', element);

    assert.equal(debug.getAllTracked().length, 1);
    assert.equal(debug.isEnabled(), true);

    debug.reset();

    assert.equal(debug.isEnabled(), false);
    assert.equal(debug.getAllTracked().length, 0);
    // WeakMap entry still exists but interactionMap is cleared,
    // so getByInteractionID returns empty
    assert.deepEqual(debug.getByInteractionID('int_reset'), []);
  });

  it('should expose window.__kikxDebug global with correct shape', () => {
    let global = globalThis.window.__kikxDebug;
    assert.ok(global);
    assert.equal(typeof global.enable, 'function');
    assert.equal(typeof global.disable, 'function');
    assert.equal(typeof global.isEnabled, 'function');
    assert.equal(typeof global.get, 'function');
    assert.equal(typeof global.getByID, 'function');
    assert.equal(typeof global.list, 'function');
  });

  it('should allow getMetadata even when disabled', () => {
    let document = getDocument();
    let element  = document.createElement('div');

    // Enable, track, then disable
    debug.enable();
    debug.trackElement('int_persist', element);
    debug.disable();

    // getMetadata should still return the existing entry
    let metadata = debug.getMetadata(element);
    assert.ok(metadata);
    assert.equal(metadata.interactionID, 'int_persist');
  });
});
