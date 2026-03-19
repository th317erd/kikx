'use strict';

// =============================================================================
// Tests for kikx-compaction-frame web component
// =============================================================================

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setupDOM, teardownDOM, getDocument } from './jsdom-helper.mjs';

let KikxCompactionFrame;
let createFrameElement;

before(async () => {
  setupDOM();

  // Set up i18n locale
  let i18n = await import('../../src/client/lib/i18n.mjs');
  let en   = (await import('../../src/client/lib/locales/en.mjs')).default;
  i18n.setLocale(en, 'en');

  // Import the compaction frame component
  let mod = await import('../../src/client/components/kikx-compaction-frame/kikx-compaction-frame.mjs');
  KikxCompactionFrame = mod.default;

  // Import createFrameElement for integration tests
  await import('../../src/client/components/kikx-interaction/kikx-interaction.mjs');
  await import('../../src/client/components/kikx-message-content/kikx-message-content.mjs');
  await import('../../src/client/components/kikx-permission-request/kikx-permission-request.mjs');
  await import('../../src/client/components/kikx-session-link/kikx-session-link.mjs');
  await import('../../src/client/components/kikx-reflection-block/kikx-reflection-block.mjs');
  await import('../../src/client/components/kikx-command-result/kikx-command-result.mjs');

  let sessionPageMod = await import('../../src/client/components/kikx-session-page/kikx-session-page.mjs');
  createFrameElement = sessionPageMod.createFrameElement;
});

after(() => {
  teardownDOM();
});

beforeEach(() => {
  let doc = getDocument();
  while (doc.body.firstChild)
    doc.body.removeChild(doc.body.firstChild);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createElement(attributes = {}) {
  let doc = getDocument();
  let el  = doc.createElement('kikx-compaction-frame');

  for (let [key, value] of Object.entries(attributes))
    el.setAttribute(key, String(value));

  doc.body.appendChild(el);

  return el;
}

function makeCompactionFrame(overrides = {}) {
  return {
    id:            overrides.id || 'frame-compaction-001',
    type:          'compaction',
    sessionID:     overrides.sessionID || 'session-001',
    content:       overrides.content || {
      status:           'finished',
      startedAt:        '2026-03-19T10:00:00Z',
      framesCompacted:  42,
      compactorAgentID: 'agt_test123',
      summary:          null,
    },
    order:         overrides.order ?? 5,
    createdAt:     overrides.createdAt || '2026-03-19T10:00:00Z',
    authorType:    overrides.authorType || 'system',
    ...overrides,
  };
}

// =============================================================================
// Component Registration
// =============================================================================

describe('kikx-compaction-frame — registration', { timeout: 5000 }, () => {
  it('should be registered as a custom element', () => {
    let Constructor = customElements.get('kikx-compaction-frame');
    assert.ok(Constructor, 'kikx-compaction-frame should be registered');
  });

  it('should have observedAttributes including all required attributes', () => {
    let observed = KikxCompactionFrame.observedAttributes;
    assert.ok(Array.isArray(observed), 'observedAttributes should be an array');
    assert.ok(observed.includes('frame-id'), 'should observe frame-id');
    assert.ok(observed.includes('session-id'), 'should observe session-id');
    assert.ok(observed.includes('status'), 'should observe status');
    assert.ok(observed.includes('started-at'), 'should observe started-at');
    assert.ok(observed.includes('frames-compacted'), 'should observe frames-compacted');
    assert.ok(observed.includes('compactor-name'), 'should observe compactor-name');
  });
});

// =============================================================================
// Status: started (in-progress)
// =============================================================================

describe('kikx-compaction-frame — status=started', { timeout: 5000 }, () => {
  it('should show loading state text when status is started', () => {
    let el = createElement({ status: 'started' });

    let text = el.querySelector('.compaction-text');
    assert.ok(text, 'should have a text element');
    assert.equal(text.textContent, 'Compacting session history...');
  });

  it('should show spinner icon when status is started', () => {
    let el = createElement({ status: 'started' });

    let icon    = el.querySelector('.compaction-icon');
    let spinner = icon.querySelector('.compaction-spinner');
    assert.ok(spinner, 'should contain a spinner element');
  });

  it('should have in-progress CSS class on divider', () => {
    let el = createElement({ status: 'started' });

    let divider = el.querySelector('.compaction-divider');
    assert.ok(divider.classList.contains('in-progress'), 'should have in-progress class');
  });

  it('should NOT be clickable when in progress', () => {
    let el = createElement({ status: 'started' });

    let divider = el.querySelector('.compaction-divider');
    assert.ok(!divider.classList.contains('clickable'), 'should not have clickable class');
  });

  it('should NOT show summary when in progress', () => {
    let el = createElement({ status: 'started' });

    let summary = el.querySelector('.compaction-summary');
    assert.ok(!summary.classList.contains('visible'), 'summary should not be visible');
  });
});

// =============================================================================
// Status: finished (collapsed default)
// =============================================================================

describe('kikx-compaction-frame — status=finished (collapsed)', { timeout: 5000 }, () => {
  it('should show collapsed text with frame count', () => {
    let el = createElement({
      'status':           'finished',
      'frames-compacted': '42',
      'started-at':       new Date().toISOString(),
    });

    let text = el.querySelector('.compaction-text');
    assert.ok(text, 'should have a text element');
    assert.ok(text.textContent.includes('42'), 'should include frame count');
    assert.ok(text.textContent.includes('Compacted'), 'should include "Compacted"');
  });

  it('should show fold icon when collapsed', () => {
    let el = createElement({ status: 'finished', 'frames-compacted': '10' });

    let icon = el.querySelector('.compaction-icon');
    // Unicode right-pointing triangle
    assert.equal(icon.textContent, '\u25B8');
  });

  it('should be clickable when finished', () => {
    let el = createElement({ status: 'finished', 'frames-compacted': '10' });

    let divider = el.querySelector('.compaction-divider');
    assert.ok(divider.classList.contains('clickable'), 'should have clickable class');
  });

  it('should NOT show summary when collapsed', () => {
    let el = createElement({ status: 'finished', 'frames-compacted': '10' });

    let summary = el.querySelector('.compaction-summary');
    assert.ok(!summary.classList.contains('visible'), 'summary should not be visible');
  });

  it('should include relative time in text when started-at is provided', () => {
    // 5 minutes ago
    let fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    let el = createElement({
      'status':           'finished',
      'frames-compacted': '10',
      'started-at':       fiveMinAgo,
    });

    let text = el.querySelector('.compaction-text');
    // Should contain the em-dash separator and relative time
    assert.ok(text.textContent.includes('\u2014'), 'should include em-dash separator');
  });
});

// =============================================================================
// Status: abandoned
// =============================================================================

describe('kikx-compaction-frame — status=abandoned', { timeout: 5000 }, () => {
  it('should show error state text', () => {
    let el = createElement({ status: 'abandoned' });

    let text = el.querySelector('.compaction-text');
    assert.ok(text, 'should have a text element');
    assert.ok(text.textContent.includes('Compaction failed'), 'should include "Compaction failed"');
  });

  it('should show warning icon', () => {
    let el = createElement({ status: 'abandoned' });

    let icon = el.querySelector('.compaction-icon');
    // Unicode warning sign
    assert.equal(icon.textContent, '\u26A0');
  });

  it('should have abandoned CSS class on divider', () => {
    let el = createElement({ status: 'abandoned' });

    let divider = el.querySelector('.compaction-divider');
    assert.ok(divider.classList.contains('abandoned'), 'should have abandoned class');
  });

  it('should NOT be clickable when abandoned', () => {
    let el = createElement({ status: 'abandoned' });

    let divider = el.querySelector('.compaction-divider');
    assert.ok(!divider.classList.contains('clickable'), 'should not have clickable class');
  });

  it('should NOT show summary when abandoned', () => {
    let el = createElement({ status: 'abandoned' });

    let summary = el.querySelector('.compaction-summary');
    assert.ok(!summary.classList.contains('visible'), 'summary should not be visible');
  });

  it('should include relative time when started-at is provided', () => {
    let threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
    let el = createElement({
      'status':     'abandoned',
      'started-at': threeHoursAgo,
    });

    let text = el.querySelector('.compaction-text');
    assert.ok(text.textContent.includes('\u2014'), 'should include em-dash separator');
  });
});

// =============================================================================
// Expand/Collapse behavior
// =============================================================================

describe('kikx-compaction-frame — expand/collapse', { timeout: 5000 }, () => {
  it('should toggle expanded state when clicking finished divider', () => {
    let el = createElement({ status: 'finished', 'frames-compacted': '10' });

    assert.equal(el.expanded, false, 'should start collapsed');

    // Click to expand
    let divider = el.querySelector('.compaction-divider');
    divider.click();

    assert.equal(el.expanded, true, 'should be expanded after click');
  });

  it('should toggle back to collapsed on second click', () => {
    let el = createElement({
      'status':           'finished',
      'frames-compacted': '10',
      'frame-id':         'frame-001',
      'session-id':       'session-001',
    });

    let divider = el.querySelector('.compaction-divider');

    // Click to expand
    divider.click();
    assert.equal(el.expanded, true);

    // Click to collapse
    divider.click();
    assert.equal(el.expanded, false);

    let summary = el.querySelector('.compaction-summary');
    assert.ok(!summary.classList.contains('visible'), 'summary should be hidden after collapse');
  });

  it('should NOT toggle when clicking in-progress divider', () => {
    let el = createElement({ status: 'started' });

    let divider = el.querySelector('.compaction-divider');
    divider.click();

    assert.equal(el.expanded, false, 'should remain collapsed');
  });

  it('should NOT toggle when clicking abandoned divider', () => {
    let el = createElement({ status: 'abandoned' });

    let divider = el.querySelector('.compaction-divider');
    divider.click();

    assert.equal(el.expanded, false, 'should remain collapsed');
  });

  it('should show unfold icon when expanded', () => {
    let el = createElement({
      'status':           'finished',
      'frames-compacted': '10',
      'frame-id':         'frame-001',
      'session-id':       'session-001',
    });

    let divider = el.querySelector('.compaction-divider');
    divider.click();

    let icon = el.querySelector('.compaction-icon');
    // Unicode down-pointing triangle
    assert.equal(icon.textContent, '\u25BE');
  });
});

// =============================================================================
// Attribute reflection
// =============================================================================

describe('kikx-compaction-frame — attribute reflection', { timeout: 5000 }, () => {
  it('should reflect frame-id attribute', () => {
    let el = createElement({ 'frame-id': 'frm_abc123' });
    assert.equal(el.getAttribute('frame-id'), 'frm_abc123');
  });

  it('should reflect session-id attribute', () => {
    let el = createElement({ 'session-id': 'ses_xyz789' });
    assert.equal(el.getAttribute('session-id'), 'ses_xyz789');
  });

  it('should reflect status attribute', () => {
    let el = createElement({ status: 'finished' });
    assert.equal(el.getAttribute('status'), 'finished');
  });

  it('should reflect started-at attribute', () => {
    let iso = '2026-03-19T10:00:00Z';
    let el  = createElement({ 'started-at': iso });
    assert.equal(el.getAttribute('started-at'), iso);
  });

  it('should reflect frames-compacted attribute', () => {
    let el = createElement({ 'frames-compacted': '42' });
    assert.equal(el.getAttribute('frames-compacted'), '42');
  });

  it('should reflect compactor-name attribute', () => {
    let el = createElement({ 'compactor-name': 'test-claude' });
    assert.equal(el.getAttribute('compactor-name'), 'test-claude');
  });
});

// =============================================================================
// Status change from started to finished
// =============================================================================

describe('kikx-compaction-frame — dynamic status change', { timeout: 5000 }, () => {
  it('should update display when status changes from started to finished', () => {
    let el = createElement({ status: 'started' });

    // Verify initial state
    let text = el.querySelector('.compaction-text');
    assert.equal(text.textContent, 'Compacting session history...');

    // Change status
    el.setAttribute('status', 'finished');
    el.setAttribute('frames-compacted', '25');

    // Verify updated state
    text = el.querySelector('.compaction-text');
    assert.ok(text.textContent.includes('25'), 'should show updated frame count');
    assert.ok(text.textContent.includes('Compacted'), 'should show "Compacted"');

    let divider = el.querySelector('.compaction-divider');
    assert.ok(!divider.classList.contains('in-progress'), 'should no longer have in-progress class');
    assert.ok(divider.classList.contains('clickable'), 'should now be clickable');
  });

  it('should update display when status changes from started to abandoned', () => {
    let el = createElement({ status: 'started' });

    el.setAttribute('status', 'abandoned');

    let text = el.querySelector('.compaction-text');
    assert.ok(text.textContent.includes('Compaction failed'), 'should show error text');

    let divider = el.querySelector('.compaction-divider');
    assert.ok(divider.classList.contains('abandoned'), 'should have abandoned class');
    assert.ok(!divider.classList.contains('in-progress'), 'should not have in-progress class');
  });

  it('should remove spinner when transitioning from started to finished', () => {
    let el = createElement({ status: 'started' });

    let spinner = el.querySelector('.compaction-spinner');
    assert.ok(spinner, 'should have spinner initially');

    el.setAttribute('status', 'finished');
    el.setAttribute('frames-compacted', '10');

    let icon = el.querySelector('.compaction-icon');
    // The icon should now be a triangle, not a spinner
    assert.equal(icon.querySelector('.compaction-spinner'), null, 'spinner should be gone');
  });
});

// =============================================================================
// Expand with API fetch (mocked)
// =============================================================================

describe('kikx-compaction-frame — expand triggers fetch', { timeout: 5000 }, () => {
  it('should show loading state on expand when no cache', () => {
    let el = createElement({
      'status':           'finished',
      'frames-compacted': '10',
      'frame-id':         'frame-compaction-001',
      'session-id':       'session-001',
    });

    // Mock globalThis.fetch to prevent real network calls
    let fetchCalled = false;
    let originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      fetchCalled = true;

      return new Promise(() => {}); // Never resolves — just testing the loading state
    };

    try {
      let divider = el.querySelector('.compaction-divider');
      divider.click();

      let summary = el.querySelector('.compaction-summary');
      assert.ok(summary.classList.contains('visible'), 'summary should be visible');
      assert.equal(summary.textContent, 'Loading summary...');
      assert.equal(el.loading, true, 'should be in loading state');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should display error message when frame-id is missing', async () => {
    let el = createElement({
      'status':           'finished',
      'frames-compacted': '10',
      'session-id':       'session-001',
    });

    let divider = el.querySelector('.compaction-divider');
    divider.click();

    // Wait a tick for the async expand to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    let summary = el.querySelector('.compaction-summary');
    assert.equal(summary.textContent, 'Unable to load summary.');
    assert.equal(el.loading, false, 'should not be loading');
  });

  it('should display error message when session-id is missing', async () => {
    let el = createElement({
      'status':           'finished',
      'frames-compacted': '10',
      'frame-id':         'frame-001',
    });

    let divider = el.querySelector('.compaction-divider');
    divider.click();

    await new Promise((resolve) => setTimeout(resolve, 10));

    let summary = el.querySelector('.compaction-summary');
    assert.equal(summary.textContent, 'Unable to load summary.');
  });

  it('should cache summary after successful fetch', async () => {
    let el = createElement({
      'status':           'finished',
      'frames-compacted': '10',
      'frame-id':         'frame-compaction-001',
      'session-id':       'session-001',
    });

    let fetchCount    = 0;
    let originalFetch = globalThis.fetch;
    globalThis.fetch  = () => {
      fetchCount++;

      return Promise.resolve({
        ok:      true,
        status:  200,
        headers: new Map([['Content-Type', 'application/json']]),
        json:    () => Promise.resolve({
          data: {
            frame: {
              id:      'frame-compaction-001',
              type:    'compaction',
              content: {
                status:          'finished',
                summary:         'This is the compacted summary text.',
                framesCompacted: 10,
              },
            },
          },
        }),
      });
    };

    try {
      let divider = el.querySelector('.compaction-divider');
      divider.click();

      // Wait for fetch to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      let summary = el.querySelector('.compaction-summary');
      assert.equal(summary.textContent, 'This is the compacted summary text.');
      assert.equal(el.summaryCache, 'This is the compacted summary text.');
      assert.equal(fetchCount, 1);

      // Collapse and re-expand — should use cache, not re-fetch
      divider.click(); // collapse
      divider.click(); // expand again

      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(fetchCount, 1, 'should not fetch again — cached');
      assert.equal(summary.textContent, 'This is the compacted summary text.');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should show error when fetch fails', async () => {
    let el = createElement({
      'status':           'finished',
      'frames-compacted': '10',
      'frame-id':         'frame-compaction-001',
      'session-id':       'session-001',
    });

    let originalFetch = globalThis.fetch;
    globalThis.fetch  = () => {
      return Promise.resolve({
        ok:      false,
        status:  500,
        headers: new Map([['Content-Type', 'application/json']]),
        json:    () => Promise.resolve({ message: 'Internal Server Error' }),
      });
    };

    try {
      let divider = el.querySelector('.compaction-divider');
      divider.click();

      await new Promise((resolve) => setTimeout(resolve, 50));

      let summary = el.querySelector('.compaction-summary');
      assert.equal(summary.textContent, 'Unable to load summary.');
      assert.equal(el.loading, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should show no-summary message when frame has no summary', async () => {
    let el = createElement({
      'status':           'finished',
      'frames-compacted': '10',
      'frame-id':         'frame-compaction-001',
      'session-id':       'session-001',
    });

    let originalFetch = globalThis.fetch;
    globalThis.fetch  = () => {
      return Promise.resolve({
        ok:      true,
        status:  200,
        headers: new Map([['Content-Type', 'application/json']]),
        json:    () => Promise.resolve({
          data: {
            frame: {
              id:      'frame-compaction-001',
              type:    'compaction',
              content: {
                status:          'finished',
                summary:         null,
                framesCompacted: 10,
              },
            },
          },
        }),
      });
    };

    try {
      let divider = el.querySelector('.compaction-divider');
      divider.click();

      await new Promise((resolve) => setTimeout(resolve, 50));

      let summary = el.querySelector('.compaction-summary');
      assert.equal(summary.textContent, 'No summary available.');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should show error when fetch throws a network error', async () => {
    let el = createElement({
      'status':           'finished',
      'frames-compacted': '10',
      'frame-id':         'frame-compaction-001',
      'session-id':       'session-001',
    });

    let originalFetch = globalThis.fetch;
    globalThis.fetch  = () => {
      return Promise.reject(new Error('Network failure'));
    };

    try {
      let divider = el.querySelector('.compaction-divider');
      divider.click();

      await new Promise((resolve) => setTimeout(resolve, 50));

      let summary = el.querySelector('.compaction-summary');
      assert.equal(summary.textContent, 'Unable to load summary.');
      assert.equal(el.loading, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// =============================================================================
// createFrameElement integration
// =============================================================================

describe('createFrameElement — compaction frames', { timeout: 5000 }, () => {
  it('should return a kikx-compaction-frame element for compaction type', () => {
    let frame = makeCompactionFrame();
    let el    = createFrameElement(frame);

    assert.ok(el, 'should return an element');
    assert.equal(el.tagName.toLowerCase(), 'kikx-compaction-frame');
  });

  it('should NOT return a kikx-interaction wrapper', () => {
    let frame = makeCompactionFrame();
    let el    = createFrameElement(frame);

    assert.notEqual(el.tagName.toLowerCase(), 'kikx-interaction',
      'compaction frames should not be wrapped in kikx-interaction');
  });

  it('should set data-frame-id on the compaction element', () => {
    let frame = makeCompactionFrame({ id: 'frm_compact_xyz' });
    let el    = createFrameElement(frame);

    assert.equal(el.getAttribute('data-frame-id'), 'frm_compact_xyz');
  });

  it('should set frame-id attribute from frame.id', () => {
    let frame = makeCompactionFrame({ id: 'frm_compact_abc' });
    let el    = createFrameElement(frame);

    assert.equal(el.getAttribute('frame-id'), 'frm_compact_abc');
  });

  it('should set session-id attribute from frame.sessionID', () => {
    let frame = makeCompactionFrame({ sessionID: 'ses_test_123' });
    let el    = createFrameElement(frame);

    assert.equal(el.getAttribute('session-id'), 'ses_test_123');
  });

  it('should set status attribute from frame.content.status', () => {
    let frame = makeCompactionFrame({
      content: { status: 'started', framesCompacted: 0 },
    });
    let el = createFrameElement(frame);

    assert.equal(el.getAttribute('status'), 'started');
  });

  it('should set started-at attribute from frame.content.startedAt', () => {
    let frame = makeCompactionFrame({
      content: { status: 'finished', startedAt: '2026-03-19T12:00:00Z', framesCompacted: 5 },
    });
    let el = createFrameElement(frame);

    assert.equal(el.getAttribute('started-at'), '2026-03-19T12:00:00Z');
  });

  it('should set frames-compacted attribute from frame.content.framesCompacted', () => {
    let frame = makeCompactionFrame({
      content: { status: 'finished', framesCompacted: 99 },
    });
    let el = createFrameElement(frame);

    assert.equal(el.getAttribute('frames-compacted'), '99');
  });

  it('should set compactor-name from frame.content.compactorAgentID', () => {
    let frame = makeCompactionFrame({
      content: { status: 'finished', compactorAgentID: 'agt_coordinator', framesCompacted: 10 },
    });
    let el = createFrameElement(frame);

    assert.equal(el.getAttribute('compactor-name'), 'agt_coordinator');
  });

  it('should default status to started when content.status is missing', () => {
    let frame = makeCompactionFrame({
      content: { framesCompacted: 10 },
    });
    let el = createFrameElement(frame);

    assert.equal(el.getAttribute('status'), 'started');
  });

  it('should handle abandoned status', () => {
    let frame = makeCompactionFrame({
      content: { status: 'abandoned', startedAt: '2026-03-19T10:00:00Z', framesCompacted: 0 },
    });
    let el = createFrameElement(frame);

    assert.equal(el.getAttribute('status'), 'abandoned');
  });
});

// =============================================================================
// Edge cases
// =============================================================================

describe('kikx-compaction-frame — edge cases', { timeout: 5000 }, () => {
  it('should handle zero frames-compacted gracefully', () => {
    let el = createElement({
      'status':           'finished',
      'frames-compacted': '0',
    });

    let text = el.querySelector('.compaction-text');
    assert.ok(text.textContent.includes('0'), 'should show 0 frames');
  });

  it('should handle missing started-at gracefully', () => {
    let el = createElement({
      'status':           'finished',
      'frames-compacted': '10',
    });

    let text = el.querySelector('.compaction-text');
    assert.ok(text.textContent.includes('10'), 'should show frame count');
    // No relative time, so no em-dash
    assert.ok(!text.textContent.includes('\u2014'), 'should not include em-dash when no time');
  });

  it('should handle invalid started-at gracefully', () => {
    let el = createElement({
      'status':           'finished',
      'frames-compacted': '10',
      'started-at':       'not-a-date',
    });

    let text = el.querySelector('.compaction-text');
    assert.ok(text.textContent.includes('10'), 'should show frame count');
  });

  it('should handle unknown status gracefully', () => {
    let el = createElement({ status: 'unknown-state' });

    let text = el.querySelector('.compaction-text');
    assert.equal(text.textContent, '');
  });

  it('should use light DOM (not shadow DOM)', () => {
    let el = createElement({ status: 'finished', 'frames-compacted': '5' });

    assert.equal(el.shadowRoot, null, 'should not have a shadow root');

    let divider = el.querySelector('.compaction-divider');
    assert.ok(divider, 'should find divider in light DOM');
  });

  it('should initialize only once on re-connect', () => {
    let doc = getDocument();
    let el  = createElement({ status: 'finished', 'frames-compacted': '5' });

    // Disconnect and reconnect
    doc.body.removeChild(el);
    doc.body.appendChild(el);

    // Should not have duplicated inner elements
    let dividers = el.querySelectorAll('.compaction-divider');
    assert.equal(dividers.length, 1, 'should have exactly one divider');
  });
});

// =============================================================================
// Malformed inputs
// =============================================================================

describe('kikx-compaction-frame — malformed inputs', { timeout: 5000 }, () => {
  it('should handle missing status attribute (defaults to started)', () => {
    let el = createElement({});

    let text = el.querySelector('.compaction-text');
    assert.equal(text.textContent, 'Compacting session history...');
  });

  it('should not throw when no attributes are set', () => {
    assert.doesNotThrow(() => {
      createElement({});
    });
  });

  it('should handle frames-compacted as non-numeric string', () => {
    let el = createElement({
      'status':           'finished',
      'frames-compacted': 'abc',
    });

    let text = el.querySelector('.compaction-text');
    // NaN parsed from 'abc' → displays as NaN, which is acceptable
    assert.ok(text.textContent.includes('Compacted'), 'should still show "Compacted" text');
  });
});
