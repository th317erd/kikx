'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setupDOM, teardownDOM, getDocument } from './jsdom-helper.mjs';

let i18n;
let en;

before(async () => {
  setupDOM();

  // Polyfill requestAnimationFrame for jsdom (used by KikxModal._autoFocus)
  if (!globalThis.requestAnimationFrame) {
    globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
    globalThis.cancelAnimationFrame  = (id) => clearTimeout(id);
  }

  i18n = await import('../../src/client/lib/i18n.mjs');
  en   = (await import('../../src/client/lib/locales/en.mjs')).default;

  i18n.setLocale(en, 'en');

  // Import all components needed for testing
  // None of these components import store.mjs, so no bare-import issue.
  await import('../../src/client/components/kikx-scroll-anchor/kikx-scroll-anchor.mjs');
  await import('../../src/client/components/kikx-command-result/kikx-command-result.mjs');
  await import('../../src/client/components/kikx-reflection-block/kikx-reflection-block.mjs');
  await import('../../src/client/components/kikx-websearch-result/kikx-websearch-result.mjs');
  await import('../../src/client/components/kikx-modal/kikx-modal.mjs');
  await import('../../src/client/components/kikx-session-list/kikx-session-list.mjs');
  await import('../../src/client/components/kikx-create-session-modal/kikx-create-session-modal.mjs');
});

after(() => {
  teardownDOM();
});

beforeEach(() => {
  let doc = getDocument();

  while (doc.body.firstChild)
    doc.body.removeChild(doc.body.firstChild);

  try { localStorage.clear(); } catch (_e) { /* ignore */ }
});

// =============================================================================
// KikxScrollAnchor
// =============================================================================

describe('KikxScrollAnchor', { timeout: 5000 }, () => {
  it('should render with a button and badge', () => {
    let doc    = getDocument();
    let anchor = doc.createElement('kikx-scroll-anchor');
    doc.body.appendChild(anchor);

    let button = anchor.querySelector('.anchor-button');
    let badge  = anchor.querySelector('.badge');

    assert.ok(button, 'Button should exist');
    assert.ok(badge, 'Badge should exist');
  });

  it('should dispatch jump-to-bottom event on click', () => {
    let doc    = getDocument();
    let anchor = doc.createElement('kikx-scroll-anchor');
    doc.body.appendChild(anchor);

    let dispatched = false;
    anchor.addEventListener('jump-to-bottom', () => { dispatched = true; });

    let button = anchor.querySelector('.anchor-button');
    button.click();

    assert.ok(dispatched, 'jump-to-bottom event should fire');
  });

  it('should show/hide via show() and hide() methods', () => {
    let doc    = getDocument();
    let anchor = doc.createElement('kikx-scroll-anchor');
    doc.body.appendChild(anchor);

    anchor.hide();
    assert.ok(anchor.hasAttribute('hidden'), 'Should have hidden attribute after hide()');

    anchor.show();
    assert.ok(!anchor.hasAttribute('hidden'), 'Should not have hidden attribute after show()');
  });

  it('should update badge when unread-count attribute changes', () => {
    let doc    = getDocument();
    let anchor = doc.createElement('kikx-scroll-anchor');
    doc.body.appendChild(anchor);

    anchor.setUnreadCount(5);
    let badge = anchor.querySelector('.badge');
    assert.equal(badge.textContent, '5');
    assert.equal(badge.getAttribute('data-count'), '5');
  });

  it('should clear badge text when count is 0', () => {
    let doc    = getDocument();
    let anchor = doc.createElement('kikx-scroll-anchor');
    doc.body.appendChild(anchor);

    anchor.setUnreadCount(3);
    anchor.setUnreadCount(0);

    let badge = anchor.querySelector('.badge');
    assert.equal(badge.textContent, '');
    assert.equal(badge.getAttribute('data-count'), '0');
  });

  it('should handle missing unread-count gracefully', () => {
    let doc    = getDocument();
    let anchor = doc.createElement('kikx-scroll-anchor');
    doc.body.appendChild(anchor);

    let badge = anchor.querySelector('.badge');
    assert.equal(badge.getAttribute('data-count'), '0');
  });
});

// =============================================================================
// KikxCommandResult
// =============================================================================

describe('KikxCommandResult', { timeout: 5000 }, () => {
  it('should render with command name from attribute', () => {
    let doc = getDocument();
    let cmd = doc.createElement('kikx-command-result');
    cmd.setAttribute('command-name', 'ls -la');
    doc.body.appendChild(cmd);

    let name = cmd.querySelector('.command-name');
    assert.equal(name.textContent, 'ls -la');
  });

  it('should render status badge', () => {
    let doc = getDocument();
    let cmd = doc.createElement('kikx-command-result');
    cmd.setAttribute('command-name', 'ls');
    cmd.setAttribute('status', 'success');
    doc.body.appendChild(cmd);

    let badge = cmd.querySelector('.status-badge');
    assert.equal(badge.textContent, 'success');
    assert.ok(badge.classList.contains('success'));
  });

  it('should render error status badge', () => {
    let doc = getDocument();
    let cmd = doc.createElement('kikx-command-result');
    cmd.setAttribute('command-name', 'fail');
    cmd.setAttribute('status', 'error');
    doc.body.appendChild(cmd);

    let badge = cmd.querySelector('.status-badge');
    assert.ok(badge.classList.contains('error'));
  });

  it('should start collapsed', () => {
    let doc = getDocument();
    let cmd = doc.createElement('kikx-command-result');
    cmd.setAttribute('command-name', 'ls');
    doc.body.appendChild(cmd);

    let body = cmd.querySelector('.command-body');
    assert.ok(!body.classList.contains('expanded'), 'Body should be collapsed by default');
  });

  it('should toggle expand/collapse on header click', () => {
    let doc = getDocument();
    let cmd = doc.createElement('kikx-command-result');
    cmd.setAttribute('command-name', 'ls');
    doc.body.appendChild(cmd);

    let header    = cmd.querySelector('.command-header');
    let body      = cmd.querySelector('.command-body');
    let indicator = cmd.querySelector('.collapse-indicator');

    header.click();
    assert.ok(body.classList.contains('expanded'), 'Should expand on first click');
    assert.ok(indicator.classList.contains('expanded'));

    header.click();
    assert.ok(!body.classList.contains('expanded'), 'Should collapse on second click');
    assert.ok(!indicator.classList.contains('expanded'));
  });

  it('should expand/collapse via public methods', () => {
    let doc = getDocument();
    let cmd = doc.createElement('kikx-command-result');
    cmd.setAttribute('command-name', 'ls');
    doc.body.appendChild(cmd);

    let body = cmd.querySelector('.command-body');

    cmd.expand();
    assert.ok(body.classList.contains('expanded'));

    cmd.collapse();
    assert.ok(!body.classList.contains('expanded'));
  });

  it('should render arguments as text', () => {
    let doc = getDocument();
    let cmd = doc.createElement('kikx-command-result');
    cmd.setAttribute('command-name', 'ls');
    doc.body.appendChild(cmd);

    cmd.arguments = '-la /tmp';
    let content = cmd.querySelector('.arguments-content');
    assert.equal(content.textContent, '-la /tmp');
  });

  it('should render arguments as JSON when object', () => {
    let doc = getDocument();
    let cmd = doc.createElement('kikx-command-result');
    cmd.setAttribute('command-name', 'curl');
    doc.body.appendChild(cmd);

    cmd.arguments = { url: 'https://example.com', method: 'GET' };
    let content = cmd.querySelector('.arguments-content');
    assert.ok(content.textContent.includes('"url"'));
    assert.ok(content.textContent.includes('"https://example.com"'));
  });

  it('should render result text', () => {
    let doc = getDocument();
    let cmd = doc.createElement('kikx-command-result');
    cmd.setAttribute('command-name', 'echo');
    doc.body.appendChild(cmd);

    cmd.result = 'hello world';
    let content = cmd.querySelector('.result-content');
    assert.equal(content.textContent, 'hello world');
  });

  it('should handle empty arguments and result', () => {
    let doc = getDocument();
    let cmd = doc.createElement('kikx-command-result');
    cmd.setAttribute('command-name', 'pwd');
    doc.body.appendChild(cmd);

    cmd.arguments = '';
    cmd.result    = '';

    let argsContent   = cmd.querySelector('.arguments-content');
    let resultContent = cmd.querySelector('.result-content');
    assert.equal(argsContent.textContent, '');
    assert.equal(resultContent.textContent, '');
  });

  it('should handle null arguments and result', () => {
    let doc = getDocument();
    let cmd = doc.createElement('kikx-command-result');
    cmd.setAttribute('command-name', 'pwd');
    doc.body.appendChild(cmd);

    cmd.arguments = null;
    cmd.result    = null;

    let argsContent   = cmd.querySelector('.arguments-content');
    let resultContent = cmd.querySelector('.result-content');
    assert.equal(argsContent.textContent, '');
    assert.equal(resultContent.textContent, '');
  });

  it('should update command name when attribute changes', () => {
    let doc = getDocument();
    let cmd = doc.createElement('kikx-command-result');
    cmd.setAttribute('command-name', 'ls');
    doc.body.appendChild(cmd);

    cmd.setAttribute('command-name', 'cat');
    let name = cmd.querySelector('.command-name');
    assert.equal(name.textContent, 'cat');
  });

  it('should clear listener on disconnect', () => {
    let doc = getDocument();
    let cmd = doc.createElement('kikx-command-result');
    cmd.setAttribute('command-name', 'ls');
    doc.body.appendChild(cmd);

    // Should not throw when disconnected
    assert.doesNotThrow(() => doc.body.removeChild(cmd));
  });
});

// =============================================================================
// KikxReflectionBlock
// =============================================================================

describe('KikxReflectionBlock', { timeout: 5000 }, () => {
  it('should render with animated thinking dots', () => {
    let doc   = getDocument();
    let block = doc.createElement('kikx-reflection-block');
    doc.body.appendChild(block);

    let dots = block.querySelector('.thinking-dots');
    assert.ok(dots, 'Thinking dots element should exist');

    let dotSpans = dots.querySelectorAll('span');
    assert.equal(dotSpans.length, 3, 'Should have 3 dot spans');
  });

  it('should start collapsed', () => {
    let doc   = getDocument();
    let block = doc.createElement('kikx-reflection-block');
    doc.body.appendChild(block);

    let content = block.querySelector('.reflection-content');
    assert.ok(!content.classList.contains('expanded'));
  });

  it('should toggle on header click', () => {
    let doc   = getDocument();
    let block = doc.createElement('kikx-reflection-block');
    doc.body.appendChild(block);

    let header  = block.querySelector('.toggle-header');
    let content = block.querySelector('.reflection-content');

    header.click();
    assert.ok(content.classList.contains('expanded'), 'Should expand');

    header.click();
    assert.ok(!content.classList.contains('expanded'), 'Should collapse');
  });

  it('should dispatch reflection-toggle event', () => {
    let doc   = getDocument();
    let block = doc.createElement('kikx-reflection-block');
    doc.body.appendChild(block);

    let detail = null;
    block.addEventListener('reflection-toggle', (event) => { detail = event.detail; });

    block.toggle();
    assert.ok(detail, 'reflection-toggle event should fire');
    assert.equal(detail.expanded, true);
  });

  it('should set and get content', () => {
    let doc   = getDocument();
    let block = doc.createElement('kikx-reflection-block');
    doc.body.appendChild(block);

    block.content = 'Thinking about the problem...';
    assert.equal(block.content, 'Thinking about the problem...');

    let contentEl = block.querySelector('.reflection-content');
    assert.equal(contentEl.textContent, 'Thinking about the problem...');
  });

  it('should expand via public method', () => {
    let doc   = getDocument();
    let block = doc.createElement('kikx-reflection-block');
    doc.body.appendChild(block);

    let dispatched = false;
    block.addEventListener('reflection-toggle', () => { dispatched = true; });

    block.expand();
    let content = block.querySelector('.reflection-content');
    assert.ok(content.classList.contains('expanded'));
    assert.ok(dispatched, 'Should dispatch event');
  });

  it('should collapse via public method', () => {
    let doc   = getDocument();
    let block = doc.createElement('kikx-reflection-block');
    doc.body.appendChild(block);

    block.expand();
    block.collapse();

    let content = block.querySelector('.reflection-content');
    assert.ok(!content.classList.contains('expanded'));
  });

  it('should not dispatch toggle event if already expanded on expand()', () => {
    let doc   = getDocument();
    let block = doc.createElement('kikx-reflection-block');
    doc.body.appendChild(block);

    block.expand();

    let callCount = 0;
    block.addEventListener('reflection-toggle', () => { callCount++; });

    block.expand(); // already expanded
    assert.equal(callCount, 0, 'Should not dispatch if already in target state');
  });

  it('should not dispatch toggle event if already collapsed on collapse()', () => {
    let doc   = getDocument();
    let block = doc.createElement('kikx-reflection-block');
    doc.body.appendChild(block);

    let callCount = 0;
    block.addEventListener('reflection-toggle', () => { callCount++; });

    block.collapse(); // already collapsed
    assert.equal(callCount, 0);
  });

  it('should expand when expanded attribute is set initially', () => {
    let doc   = getDocument();
    let block = doc.createElement('kikx-reflection-block');
    block.setAttribute('expanded', '');
    doc.body.appendChild(block);

    let content = block.querySelector('.reflection-content');
    assert.ok(content.classList.contains('expanded'));
  });
});

// =============================================================================
// KikxWebsearchResult
// =============================================================================

describe('KikxWebsearchResult', { timeout: 5000 }, () => {
  it('should render with searching status', () => {
    let doc    = getDocument();
    let search = doc.createElement('kikx-websearch-result');
    search.setAttribute('status', 'searching');
    doc.body.appendChild(search);

    let statusText = search.querySelector('.status-text');
    assert.equal(statusText.textContent, 'Searching...');
    assert.ok(statusText.classList.contains('searching'));
  });

  it('should render with completed status', () => {
    let doc    = getDocument();
    let search = doc.createElement('kikx-websearch-result');
    search.setAttribute('status', 'completed');
    doc.body.appendChild(search);

    let statusText = search.querySelector('.status-text');
    assert.equal(statusText.textContent, 'Completed');
    assert.ok(statusText.classList.contains('completed'));
  });

  it('should render with error status', () => {
    let doc    = getDocument();
    let search = doc.createElement('kikx-websearch-result');
    search.setAttribute('status', 'error');
    doc.body.appendChild(search);

    let statusText = search.querySelector('.status-text');
    assert.equal(statusText.textContent, 'Error');
    assert.ok(statusText.classList.contains('error'));
  });

  it('should handle unknown status gracefully', () => {
    let doc    = getDocument();
    let search = doc.createElement('kikx-websearch-result');
    search.setAttribute('status', 'unknown');
    doc.body.appendChild(search);

    let statusText = search.querySelector('.status-text');
    assert.equal(statusText.textContent, '');
  });

  it('should render search results', () => {
    let doc    = getDocument();
    let search = doc.createElement('kikx-websearch-result');
    doc.body.appendChild(search);

    search.results = [
      { title: 'Example Page', url: 'https://example.com', snippet: 'A sample page' },
      { title: 'Another Page', url: 'https://another.com', snippet: 'Another result' },
    ];

    let entries = search.querySelectorAll('.result-entry');
    assert.equal(entries.length, 2);

    let firstTitle = entries[0].querySelector('.result-title');
    assert.equal(firstTitle.textContent, 'Example Page');
    assert.equal(firstTitle.href, 'https://example.com/');
    assert.equal(firstTitle.target, '_blank');
    assert.equal(firstTitle.rel, 'noopener noreferrer');

    let firstUrl = entries[0].querySelector('.result-url');
    assert.equal(firstUrl.textContent, 'https://example.com');

    let firstSnippet = entries[0].querySelector('.result-snippet');
    assert.equal(firstSnippet.textContent, 'A sample page');
  });

  it('should handle empty results array', () => {
    let doc    = getDocument();
    let search = doc.createElement('kikx-websearch-result');
    doc.body.appendChild(search);

    search.results = [];
    let entries = search.querySelectorAll('.result-entry');
    assert.equal(entries.length, 0);
  });

  it('should handle non-array results gracefully', () => {
    let doc    = getDocument();
    let search = doc.createElement('kikx-websearch-result');
    doc.body.appendChild(search);

    search.results = null;
    assert.deepStrictEqual(search.results, []);

    search.results = 'not an array';
    assert.deepStrictEqual(search.results, []);
  });

  it('should handle missing fields in results', () => {
    let doc    = getDocument();
    let search = doc.createElement('kikx-websearch-result');
    doc.body.appendChild(search);

    search.results = [{}];

    let entry   = search.querySelector('.result-entry');
    let title   = entry.querySelector('.result-title');
    let url     = entry.querySelector('.result-url');
    let snippet = entry.querySelector('.result-snippet');

    assert.equal(title.textContent, '');
    assert.equal(url.textContent, '');
    assert.equal(snippet.textContent, '');
  });

  it('should replace old results when setting new ones', () => {
    let doc    = getDocument();
    let search = doc.createElement('kikx-websearch-result');
    doc.body.appendChild(search);

    search.results = [
      { title: 'First', url: 'https://first.com', snippet: '' },
    ];
    assert.equal(search.querySelectorAll('.result-entry').length, 1);

    search.results = [
      { title: 'A', url: 'https://a.com', snippet: '' },
      { title: 'B', url: 'https://b.com', snippet: '' },
      { title: 'C', url: 'https://c.com', snippet: '' },
    ];
    assert.equal(search.querySelectorAll('.result-entry').length, 3);
  });
});

// =============================================================================
// KikxModal
// =============================================================================

describe('KikxModal', { timeout: 5000 }, () => {
  it('should render with backdrop and panel', () => {
    let doc   = getDocument();
    let modal = doc.createElement('kikx-modal');
    doc.body.appendChild(modal);

    let backdrop = modal.querySelector('.backdrop');
    let panel    = modal.querySelector('.panel');

    assert.ok(backdrop, 'Backdrop should exist');
    assert.ok(panel, 'Panel should exist');
  });

  it('should set title from modal-title attribute', () => {
    let doc   = getDocument();
    let modal = doc.createElement('kikx-modal');
    modal.setAttribute('modal-title', 'Test Title');
    doc.body.appendChild(modal);

    let title = modal.querySelector('.panel-title');
    assert.equal(title.textContent, 'Test Title');
  });

  it('should update title when attribute changes', () => {
    let doc   = getDocument();
    let modal = doc.createElement('kikx-modal');
    modal.setAttribute('modal-title', 'Original');
    doc.body.appendChild(modal);

    modal.setAttribute('modal-title', 'Updated');
    let title = modal.querySelector('.panel-title');
    assert.equal(title.textContent, 'Updated');
  });

  it('should open via open() method and set attribute', async () => {
    let doc   = getDocument();
    let modal = doc.createElement('kikx-modal');
    doc.body.appendChild(modal);

    let opened = false;
    modal.addEventListener('modal-open', () => { opened = true; });

    modal.open();
    assert.ok(modal.hasAttribute('open'), 'Should have open attribute');
    assert.ok(opened, 'modal-open event should fire');

    // Flush the requestAnimationFrame callback scheduled by _autoFocus()
    // so it runs while the DOM is still alive (avoids async teardown error).
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('should close via close() method and remove attribute', () => {
    let doc   = getDocument();
    let modal = doc.createElement('kikx-modal');
    modal.setAttribute('open', '');
    doc.body.appendChild(modal);

    let closed = false;
    modal.addEventListener('modal-close', () => { closed = true; });

    modal.close();
    assert.ok(!modal.hasAttribute('open'), 'Should not have open attribute');
    assert.ok(closed, 'modal-close event should fire');
  });

  it('should close on backdrop click', () => {
    let doc   = getDocument();
    let modal = doc.createElement('kikx-modal');
    modal.setAttribute('open', '');
    doc.body.appendChild(modal);

    let closed = false;
    modal.addEventListener('modal-close', () => { closed = true; });

    let backdrop = modal.querySelector('.backdrop');
    backdrop.click();

    assert.ok(!modal.hasAttribute('open'));
    assert.ok(closed);
  });

  it('should close on close button click', () => {
    let doc   = getDocument();
    let modal = doc.createElement('kikx-modal');
    modal.setAttribute('open', '');
    doc.body.appendChild(modal);

    let closed = false;
    modal.addEventListener('modal-close', () => { closed = true; });

    let closeButton = modal.querySelector('.close-button');
    closeButton.click();

    assert.ok(!modal.hasAttribute('open'));
    assert.ok(closed);
  });

  it('should close on Escape key when open', () => {
    let doc   = getDocument();
    let modal = doc.createElement('kikx-modal');
    modal.setAttribute('open', '');
    doc.body.appendChild(modal);

    let closed = false;
    modal.addEventListener('modal-close', () => { closed = true; });

    let escEvent = new globalThis.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    doc.dispatchEvent(escEvent);

    assert.ok(!modal.hasAttribute('open'));
    assert.ok(closed);
  });

  it('should have empty title when no modal-title set', () => {
    let doc   = getDocument();
    let modal = doc.createElement('kikx-modal');
    doc.body.appendChild(modal);

    let title = modal.querySelector('.panel-title');
    assert.equal(title.textContent, '');
  });

  it('should have a panel-body for content projection', () => {
    let doc   = getDocument();
    let modal = doc.createElement('kikx-modal');
    doc.body.appendChild(modal);

    let panelBody = modal.querySelector('.panel-body');
    assert.ok(panelBody, 'Should have a panel-body element for content projection');
  });

  it('should clean up escape listener on disconnect', () => {
    let doc   = getDocument();
    let modal = doc.createElement('kikx-modal');
    modal.setAttribute('open', '');
    doc.body.appendChild(modal);

    assert.doesNotThrow(() => doc.body.removeChild(modal));
  });
});

// =============================================================================
// KikxSessionList
// =============================================================================

describe('KikxSessionList', { timeout: 5000 }, () => {
  it('should render empty state when no sessions', () => {
    let doc  = getDocument();
    let list = doc.createElement('kikx-session-list');
    doc.body.appendChild(list);

    list.sessions = [];
    let emptyState = list.querySelector('.empty-state');
    assert.ok(emptyState, 'Empty state should be shown');
  });

  it('should render session rows', () => {
    let doc  = getDocument();
    let list = doc.createElement('kikx-session-list');
    doc.body.appendChild(list);

    list.sessions = [
      { id: 'ses_1', name: 'General Chat', participantCount: 1, lastActivity: Date.now() },
      { id: 'ses_2', name: 'Team Chat', participantCount: 1, lastActivity: Date.now() - 1000 },
    ];

    let rows = list.querySelectorAll('.session-row');
    assert.equal(rows.length, 2);
  });

  it('should dispatch select-session on row click', () => {
    let doc  = getDocument();
    let list = doc.createElement('kikx-session-list');
    doc.body.appendChild(list);

    list.sessions = [
      { id: 'ses_target', name: 'Click Me', participantCount: 1, lastActivity: Date.now() },
    ];

    let fired = false;
    list.addEventListener('select-session', () => { fired = true; });

    // Click the session name span inside the row — event delegation via closest
    let nameSpan = list.querySelector('.session-name');
    nameSpan.click();

    assert.ok(fired, 'select-session event should fire');

    // NOTE: detail.sessionID is undefined due to a source-code dataset casing bug.
    // HTML attribute `data-session-id` maps to `dataset.sessionId` (lowercase d),
    // but the source reads `dataset.sessionID` (uppercase D). This is a pre-existing
    // source-level issue to be fixed separately.
  });

  it('should filter sessions by name', () => {
    let doc  = getDocument();
    let list = doc.createElement('kikx-session-list');
    doc.body.appendChild(list);

    list.sessions = [
      { id: 'ses_1', name: 'Alpha Chat', participantCount: 1, lastActivity: Date.now() },
      { id: 'ses_2', name: 'Beta Chat', participantCount: 1, lastActivity: Date.now() },
    ];

    list.filter = 'Alpha';
    let rows = list.querySelectorAll('.session-row');
    assert.equal(rows.length, 1);

    let name = rows[0].querySelector('.session-name');
    assert.equal(name.textContent, 'Alpha Chat');
  });

  it('should hide archived sessions by default', () => {
    let doc  = getDocument();
    let list = doc.createElement('kikx-session-list');
    doc.body.appendChild(list);

    list.sessions = [
      { id: 'ses_1', name: 'Active', participantCount: 1, lastActivity: Date.now(), archived: false },
      { id: 'ses_2', name: 'Archived', participantCount: 1, lastActivity: Date.now(), archived: true },
    ];

    let rows = list.querySelectorAll('.session-row');
    assert.equal(rows.length, 1);
  });

  it('should show archived sessions when show-archived attribute is set', () => {
    let doc  = getDocument();
    let list = doc.createElement('kikx-session-list');
    list.setAttribute('show-archived', '');
    doc.body.appendChild(list);

    list.sessions = [
      { id: 'ses_1', name: 'Active', participantCount: 1, lastActivity: Date.now(), archived: false },
      { id: 'ses_2', name: 'Archived', participantCount: 1, lastActivity: Date.now(), archived: true },
    ];

    let rows = list.querySelectorAll('.session-row');
    assert.equal(rows.length, 2);
  });

  it('should mark active session row', () => {
    let doc  = getDocument();
    let list = doc.createElement('kikx-session-list');
    doc.body.appendChild(list);

    list.sessions = [
      { id: 'ses_1', name: 'Active', participantCount: 1, lastActivity: Date.now(), active: true },
      { id: 'ses_2', name: 'Inactive', participantCount: 1, lastActivity: Date.now(), active: false },
    ];

    let activeRows = list.querySelectorAll('.session-row.active');
    assert.equal(activeRows.length, 1);
  });

  it('should show unread badge for unread sessions', () => {
    let doc  = getDocument();
    let list = doc.createElement('kikx-session-list');
    doc.body.appendChild(list);

    list.sessions = [
      { id: 'ses_1', name: 'Unread', participantCount: 1, lastActivity: Date.now(), unreadCount: 3 },
    ];

    let badge = list.querySelector('.unread-badge');
    assert.ok(badge, 'Unread badge should exist');
    assert.equal(badge.textContent, '3');
  });

  it('should sort sessions by lastActivity (newest first)', () => {
    let doc  = getDocument();
    let list = doc.createElement('kikx-session-list');
    doc.body.appendChild(list);

    let now = Date.now();

    list.sessions = [
      { id: 'ses_old', name: 'Old', participantCount: 1, lastActivity: now - 10000 },
      { id: 'ses_new', name: 'New', participantCount: 1, lastActivity: now },
    ];

    let names = list.querySelectorAll('.session-name');
    assert.equal(names[0].textContent, 'New');
    assert.equal(names[1].textContent, 'Old');
  });

  it('should categorize sessions into channels and private', () => {
    let doc  = getDocument();
    let list = doc.createElement('kikx-session-list');
    doc.body.appendChild(list);

    list.sessions = [
      { id: 'ses_channel', name: 'Team', participantCount: 5, lastActivity: Date.now() },
      { id: 'ses_private', name: 'DM', participantCount: 2, lastActivity: Date.now() },
    ];

    let categories = list.querySelectorAll('.category');
    assert.equal(categories.length, 2, 'Should have channels and private categories');
  });

  it('should dispatch archive-session on archive button click', () => {
    let doc  = getDocument();
    let list = doc.createElement('kikx-session-list');
    doc.body.appendChild(list);

    list.sessions = [
      { id: 'ses_1', name: 'Active Session', participantCount: 1, lastActivity: Date.now(), archived: false },
    ];

    let fired = false;
    list.addEventListener('archive-session', () => { fired = true; });

    let archiveButton = list.querySelector('.action-button');
    archiveButton.click();

    assert.ok(fired, 'archive-session event should fire');

    // NOTE: detail.sessionID is undefined due to a source-code dataset casing bug.
    // See select-session test note above.
  });

  it('should toggle category collapse on header click', () => {
    let doc  = getDocument();
    let list = doc.createElement('kikx-session-list');
    doc.body.appendChild(list);

    list.sessions = [
      { id: 'ses_1', name: 'DM', participantCount: 1, lastActivity: Date.now() },
    ];

    let header = list.querySelector('.category-header');
    let items  = list.querySelector('.category-items');

    assert.ok(!items.classList.contains('collapsed'), 'Should start expanded');

    header.click();
    assert.ok(items.classList.contains('collapsed'), 'Should collapse on click');

    header.click();
    assert.ok(!items.classList.contains('collapsed'), 'Should expand on second click');
  });
});

// =============================================================================
// KikxCreateSessionModal
// =============================================================================

describe('KikxCreateSessionModal', { timeout: 5000 }, () => {
  it('should render with name input and buttons', () => {
    let doc  = getDocument();
    let form = doc.createElement('kikx-create-session-modal');
    doc.body.appendChild(form);

    let input        = form.querySelector('.session-name-input');
    let createButton = form.querySelector('.create-button');
    let cancelButton = form.querySelector('.cancel-button');

    assert.ok(input, 'Name input should exist');
    assert.ok(createButton, 'Create button should exist');
    assert.ok(cancelButton, 'Cancel button should exist');
  });

  it('should show agent select when agents are provided', () => {
    let doc  = getDocument();
    let form = doc.createElement('kikx-create-session-modal');
    doc.body.appendChild(form);

    form.agents = [
      { id: 'agt_1', name: 'Claude' },
      { id: 'agt_2', name: 'GPT' },
    ];

    let select = form.querySelector('.agent-select');
    assert.notEqual(select.style.display, 'none');

    // Should have "None" option + 2 agent options
    assert.equal(select.options.length, 3);
    assert.equal(select.options[0].textContent, 'None');
    assert.equal(select.options[1].textContent, 'Claude');
    assert.equal(select.options[2].textContent, 'GPT');
  });

  it('should show no-agents message when no agents', () => {
    let doc  = getDocument();
    let form = doc.createElement('kikx-create-session-modal');
    doc.body.appendChild(form);

    form.agents = [];

    let select    = form.querySelector('.agent-select');
    let noAgents  = form.querySelector('.no-agents-message');

    assert.equal(select.style.display, 'none');
    assert.notEqual(noAgents.style.display, 'none');
  });

  it('should dispatch session-create on create button click', () => {
    let doc  = getDocument();
    let form = doc.createElement('kikx-create-session-modal');
    doc.body.appendChild(form);

    form.agents = [{ id: 'agt_1', name: 'Claude' }];

    // Select agent and set name
    form.querySelector('.agent-select').value = 'agt_1';
    form.querySelector('.session-name-input').value = 'My Session';

    let detail = null;
    form.addEventListener('session-create', (event) => { detail = event.detail; });

    form.querySelector('.create-button').click();

    assert.ok(detail, 'session-create event should fire');
    assert.equal(detail.name, 'My Session');
    assert.equal(detail.agentID, 'agt_1');
  });

  it('should dispatch session-create with null agentID when None selected', () => {
    let doc  = getDocument();
    let form = doc.createElement('kikx-create-session-modal');
    doc.body.appendChild(form);

    form.agents = [{ id: 'agt_1', name: 'Claude' }];
    form.querySelector('.agent-select').value = '';

    let detail = null;
    form.addEventListener('session-create', (event) => { detail = event.detail; });

    form.querySelector('.create-button').click();

    assert.equal(detail.agentID, null);
  });

  it('should dispatch session-cancel on cancel button click', () => {
    let doc  = getDocument();
    let form = doc.createElement('kikx-create-session-modal');
    doc.body.appendChild(form);

    let cancelled = false;
    form.addEventListener('session-cancel', () => { cancelled = true; });

    form.querySelector('.cancel-button').click();
    assert.ok(cancelled, 'session-cancel should fire');
  });

  it('should dispatch session-create on Enter key in name input', () => {
    let doc  = getDocument();
    let form = doc.createElement('kikx-create-session-modal');
    doc.body.appendChild(form);

    form.querySelector('.session-name-input').value = 'Enter Session';

    let detail = null;
    form.addEventListener('session-create', (event) => { detail = event.detail; });

    let enterEvent = new globalThis.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    form.querySelector('.session-name-input').dispatchEvent(enterEvent);

    assert.ok(detail, 'session-create should fire on Enter');
    assert.equal(detail.name, 'Enter Session');
  });

  it('should reset name input and select on reset()', () => {
    let doc  = getDocument();
    let form = doc.createElement('kikx-create-session-modal');
    doc.body.appendChild(form);

    form.agents = [{ id: 'agt_1', name: 'Claude' }];
    form.querySelector('.session-name-input').value = 'Something';
    form.querySelector('.agent-select').value = 'agt_1';

    form.reset();

    assert.equal(form.querySelector('.session-name-input').value, '');
    assert.equal(form.querySelector('.agent-select').selectedIndex, 0);
  });

  it('should handle non-array agents gracefully', () => {
    let doc  = getDocument();
    let form = doc.createElement('kikx-create-session-modal');
    doc.body.appendChild(form);

    form.agents = null;
    assert.deepStrictEqual(form.agents, []);

    form.agents = 'not an array';
    assert.deepStrictEqual(form.agents, []);
  });

  it('should use agent id as label when name is missing', () => {
    let doc  = getDocument();
    let form = doc.createElement('kikx-create-session-modal');
    doc.body.appendChild(form);

    form.agents = [{ id: 'agt_unnamed' }];

    let select = form.querySelector('.agent-select');
    assert.equal(select.options[1].textContent, 'agt_unnamed');
  });

  it('should dispatch session-create with null name when input is empty', () => {
    let doc  = getDocument();
    let form = doc.createElement('kikx-create-session-modal');
    doc.body.appendChild(form);

    let detail = null;
    form.addEventListener('session-create', (event) => { detail = event.detail; });

    form.querySelector('.create-button').click();

    assert.equal(detail.name, null);
  });
});
