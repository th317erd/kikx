'use strict';

// =============================================================================
// Additional tests for <kikx-permission-request> — approval flow & gaps
// =============================================================================
// Covers scenarios NOT tested in kikx-permission-request-spec.mjs:
//   - titleParams interpolation in title and description
//   - Decision label text/class updates per decision type
//   - Processed badge rendering for each decision type
//   - Processed badge with mixed decisions
//   - Processed badge with resolvedDecision fallback
//   - Pre-connection permissionContext rendered after connect
//   - Detail value rendering (approved/pending status labels)
// =============================================================================

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createElement,
  connectElement,
  disconnectElement,
  clearBody,
} from '../helpers/jsdom-setup.mjs';

let i18n;

before(async () => {
  i18n = await import('../../../src/client/lib/i18n.mjs');
  let en = (await import('../../../src/client/lib/locales/en.mjs')).default;
  i18n.setLocale(en, 'en');

  await import('../../../src/client/components/kikx-permission-request/kikx-permission-request.mjs');
});

beforeEach(() => {
  clearBody();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeElement(opts = {}) {
  let el = createElement('kikx-permission-request');

  if (opts.permissionId)
    el.setAttribute('permission-id', opts.permissionId);

  if (opts.description !== undefined)
    el.description = opts.description;

  if (opts.toolArgs !== undefined)
    el.toolArgs = opts.toolArgs;

  if (opts.fullCommand !== undefined)
    el.fullCommand = opts.fullCommand;

  if (opts.permissionContext !== undefined)
    el.permissionContext = opts.permissionContext;

  if (opts.commands !== undefined)
    el.commands = opts.commands;

  return el;
}

function clickDecision(el, command, decision) {
  let rows = el.querySelectorAll('.command-row:not(.header-row)');
  for (let row of rows) {
    if (row.getAttribute('data-command') === command) {
      let btn = row.querySelector(`.decision-button[data-decision="${decision}"]`);
      if (btn) btn.click();
      return;
    }
  }
}

// =============================================================================
// 1. titleParams interpolation
// =============================================================================

describe('kikx-permission-request — titleParams interpolation', { timeout: 5000 }, () => {
  it('interpolates titleParams into title (e.g. permission.systemCommand.title)', () => {
    let ctx = {
      title: 'permission.systemCommand.title',
      titleParams: { command: 'compact' },
      details: [],
    };

    let el = makeElement({ permissionContext: ctx });
    connectElement(el);

    // en locale: 'Run /{command}' → 'Run /compact'
    assert.equal(el.querySelector('.title-text').textContent, 'Run /compact');
  });

  it('interpolates titleParams into description', () => {
    let ctx = {
      title: 'permission.shell.executeTitle',
      description: 'permission.systemCommand.description',
      titleParams: { command: 'restart' },
      details: [],
    };

    let el = makeElement({ permissionContext: ctx });
    connectElement(el);

    // en locale: 'Execute the /{command} command.' → 'Execute the /restart command.'
    assert.equal(
      el.querySelector('.permission-description').textContent,
      'Execute the /restart command.',
    );
  });

  it('title without titleParams renders resolved string as-is', () => {
    let ctx = {
      title: 'permission.shell.executeTitle',
      details: [],
    };

    let el = makeElement({ permissionContext: ctx });
    connectElement(el);

    assert.equal(el.querySelector('.title-text').textContent, 'Execute Shell Command');
  });
});

// =============================================================================
// 2. Decision label text and CSS classes
// =============================================================================

describe('kikx-permission-request — decision label updates', { timeout: 5000 }, () => {
  it('allow-forever sets label text and label-allow + label-nod classes', () => {
    let cmds = [{ command: 'ls', arguments: [], status: 'needs-approval' }];
    let el = makeElement({ commands: cmds });
    connectElement(el);

    clickDecision(el, 'ls', 'allow-forever');

    let row = el.querySelector('.command-row[data-command="ls"]');
    let label = row.querySelector('.decision-label');
    assert.equal(label.textContent, 'Allow');
    assert.ok(label.classList.contains('label-allow'));
    assert.ok(label.classList.contains('label-nod'));
  });

  it('allow-once sets label text and label-allow + label-nod classes', () => {
    let cmds = [{ command: 'ls', arguments: [], status: 'needs-approval' }];
    let el = makeElement({ commands: cmds });
    connectElement(el);

    clickDecision(el, 'ls', 'allow-once');

    let row = el.querySelector('.command-row[data-command="ls"]');
    let label = row.querySelector('.decision-label');
    assert.equal(label.textContent, 'Allow once');
    assert.ok(label.classList.contains('label-allow'));
    assert.ok(label.classList.contains('label-nod'));
  });

  it('deny-once sets label text and label-caution + label-shake classes', () => {
    let cmds = [{ command: 'rm', arguments: [], status: 'needs-approval' }];
    let el = makeElement({ commands: cmds });
    connectElement(el);

    clickDecision(el, 'rm', 'deny-once');

    let row = el.querySelector('.command-row[data-command="rm"]');
    let label = row.querySelector('.decision-label');
    assert.equal(label.textContent, 'Deny');
    assert.ok(label.classList.contains('label-caution'));
    assert.ok(label.classList.contains('label-shake'));
  });

  it('deny-forever sets label text and label-deny + label-shake classes', () => {
    let cmds = [{ command: 'rm', arguments: [], status: 'needs-approval' }];
    let el = makeElement({ commands: cmds });
    connectElement(el);

    clickDecision(el, 'rm', 'deny-forever');

    let row = el.querySelector('.command-row[data-command="rm"]');
    let label = row.querySelector('.decision-label');
    assert.equal(label.textContent, 'Deny forever');
    assert.ok(label.classList.contains('label-deny'));
    assert.ok(label.classList.contains('label-shake'));
  });

  it('changing decision replaces previous label classes', () => {
    let cmds = [{ command: 'ls', arguments: [], status: 'needs-approval' }];
    let el = makeElement({ commands: cmds });
    connectElement(el);

    clickDecision(el, 'ls', 'allow-forever');
    clickDecision(el, 'ls', 'deny-once');

    let row = el.querySelector('.command-row[data-command="ls"]');
    let label = row.querySelector('.decision-label');
    assert.equal(label.textContent, 'Deny');
    assert.ok(!label.classList.contains('label-allow'), 'should not have label-allow');
    assert.ok(!label.classList.contains('label-nod'), 'should not have label-nod');
    assert.ok(label.classList.contains('label-caution'));
    assert.ok(label.classList.contains('label-shake'));
  });
});

// =============================================================================
// 3. Processed badge rendering
// =============================================================================

describe('kikx-permission-request — processed badge', { timeout: 5000 }, () => {
  it('shows "Allow" badge when all decisions are allow-forever', () => {
    let cmds = [{ command: 'ls', arguments: [], status: 'needs-approval' }];
    let el = makeElement({ commands: cmds });
    connectElement(el);

    clickDecision(el, 'ls', 'allow-forever');
    el.setAttribute('processed', '');

    let badge = el.querySelector('.processed-badge');
    assert.ok(badge.textContent.includes('Allow'));
    assert.ok(badge.classList.contains('badge-allow'));
  });

  it('shows "Allow once" badge for allow-once decision', () => {
    let cmds = [{ command: 'ls', arguments: [], status: 'needs-approval' }];
    let el = makeElement({ commands: cmds });
    connectElement(el);

    clickDecision(el, 'ls', 'allow-once');
    el.setAttribute('processed', '');

    let badge = el.querySelector('.processed-badge');
    assert.ok(badge.textContent.includes('Allow once'));
    assert.ok(badge.classList.contains('badge-allow'));
  });

  it('shows "Deny once" badge with badge-caution class', () => {
    let cmds = [{ command: 'rm', arguments: [], status: 'needs-approval' }];
    let el = makeElement({ commands: cmds });
    connectElement(el);

    clickDecision(el, 'rm', 'deny-once');
    el.setAttribute('processed', '');

    let badge = el.querySelector('.processed-badge');
    assert.ok(badge.textContent.includes('Deny'));
    assert.ok(badge.classList.contains('badge-caution'));
  });

  it('shows "Deny forever" badge with badge-deny class', () => {
    let cmds = [{ command: 'rm', arguments: [], status: 'needs-approval' }];
    let el = makeElement({ commands: cmds });
    connectElement(el);

    clickDecision(el, 'rm', 'deny-forever');
    el.setAttribute('processed', '');

    let badge = el.querySelector('.processed-badge');
    assert.ok(badge.textContent.includes('Deny forever'));
    assert.ok(badge.classList.contains('badge-deny'));
  });

  it('shows "Mixed decisions applied" badge with badge-caution for mixed allow+deny', () => {
    let cmds = [
      { command: 'ls', arguments: [], status: 'needs-approval' },
      { command: 'rm', arguments: [], status: 'needs-approval' },
    ];
    let el = makeElement({ commands: cmds });
    connectElement(el);

    clickDecision(el, 'ls', 'allow-once');
    clickDecision(el, 'rm', 'deny-once');
    el.setAttribute('processed', '');

    let badge = el.querySelector('.processed-badge');
    assert.ok(badge.textContent.includes('Mixed decisions'));
    assert.ok(badge.classList.contains('badge-caution'));
  });

  it('shows "Allowed" badge when multiple commands all allowed', () => {
    let cmds = [
      { command: 'ls', arguments: [], status: 'needs-approval' },
      { command: 'cat', arguments: [], status: 'needs-approval' },
    ];
    let el = makeElement({ commands: cmds });
    connectElement(el);

    clickDecision(el, 'ls', 'allow-once');
    clickDecision(el, 'cat', 'allow-forever');
    el.setAttribute('processed', '');

    let badge = el.querySelector('.processed-badge');
    assert.ok(badge.textContent.includes('Allowed'));
    assert.ok(badge.classList.contains('badge-allow'));
  });

  it('shows "Denied" badge when multiple commands all denied', () => {
    let cmds = [
      { command: 'rm', arguments: [], status: 'needs-approval' },
      { command: 'dd', arguments: [], status: 'needs-approval' },
    ];
    let el = makeElement({ commands: cmds });
    connectElement(el);

    clickDecision(el, 'rm', 'deny-once');
    clickDecision(el, 'dd', 'deny-forever');
    el.setAttribute('processed', '');

    let badge = el.querySelector('.processed-badge');
    assert.ok(badge.textContent.includes('Denied'));
    assert.ok(badge.classList.contains('badge-deny'));
  });

  it('falls back to resolvedDecision when no live decisions exist', () => {
    let el = makeElement({ commands: [] });
    connectElement(el);

    el.resolvedDecision = 'allow-once';
    el.setAttribute('processed', '');

    let badge = el.querySelector('.processed-badge');
    assert.ok(badge.textContent.includes('Allow once'));
    assert.ok(badge.classList.contains('badge-allow'));
  });

  it('does not update badge when no decisions and no resolvedDecision', () => {
    let el = makeElement({ commands: [] });
    connectElement(el);

    el.setAttribute('processed', '');

    let badge = el.querySelector('.processed-badge');
    // Should keep default text (from template)
    assert.ok(badge.textContent.includes('Processed'));
  });
});

// =============================================================================
// 4. Pre-connection permissionContext renders after connect
// =============================================================================

describe('kikx-permission-request — pre-connect permissionContext rendering', { timeout: 5000 }, () => {
  it('permissionContext set before connect is fully rendered after connect', () => {
    let ctx = {
      title: 'permission.crossSession.postTitle',
      titleParams: { sessionName: 'Ops Channel' },
      description: 'permission.crossSession.postDescription',
      details: [
        { label: 'permission.detail.targetSession', value: 'Ops Channel' },
        { label: 'permission.detail.messagePreview', value: 'Hello from agent' },
      ],
    };

    let el = makeElement({ permissionContext: ctx });

    // Before connect — backing field set, no DOM elements
    assert.deepEqual(el.permissionContext, ctx);
    assert.equal(el._detailsEl, undefined);

    // Connect
    connectElement(el);

    // Title interpolated: 'Post to "{sessionName}"' → 'Post to "Ops Channel"'
    assert.equal(el.querySelector('.title-text').textContent, 'Post to "Ops Channel"');

    // Detail rows rendered
    let rows = el.querySelectorAll('.detail-row');
    assert.equal(rows.length, 2);

    // First detail: known key → 'Target Session:'
    let labels = el.querySelectorAll('.detail-label');
    assert.equal(labels[0].textContent, 'Target Session:');

    // Values rendered
    let values = el.querySelectorAll('.detail-value');
    assert.equal(values[0].textContent, 'Ops Channel');
    assert.equal(values[1].textContent, 'Hello from agent');
  });

  it('toolArgs set before connect are hidden when permissionContext is also set', () => {
    let el = makeElement({
      toolArgs: '{"some":"fallback"}',
      permissionContext: {
        title: 'permission.shell.executeTitle',
        details: [{ label: 'permission.detail.command', value: 'echo hi' }],
      },
    });

    connectElement(el);

    assert.equal(el.querySelector('.permission-tool-args').style.display, 'none');
    assert.equal(el.querySelectorAll('.detail-row').length, 1);
  });
});

// =============================================================================
// 5. Detail value rendering for status labels
// =============================================================================

describe('kikx-permission-request — detail values with status labels', { timeout: 5000 }, () => {
  it('renders detail value with approved checkmark text', () => {
    let ctx = {
      title: 'permission.shell.executeTitle',
      details: [
        { label: 'permission.detail.command', value: '\u2705 ls -la (approved)' },
      ],
    };

    let el = makeElement({ permissionContext: ctx });
    connectElement(el);

    let valueEl = el.querySelector('.detail-value');
    assert.ok(valueEl.textContent.includes('\u2705'));
    assert.ok(valueEl.textContent.includes('ls -la'));
  });

  it('renders detail value with pending hourglass text', () => {
    let ctx = {
      title: 'permission.shell.executeTitle',
      details: [
        { label: 'permission.detail.command', value: '\u231B rm -rf /tmp (pending)' },
      ],
    };

    let el = makeElement({ permissionContext: ctx });
    connectElement(el);

    let valueEl = el.querySelector('.detail-value');
    assert.ok(valueEl.textContent.includes('\u231B'));
    assert.ok(valueEl.textContent.includes('rm -rf'));
  });

  it('renders empty string for detail with no value', () => {
    let ctx = {
      title: 'permission.shell.executeTitle',
      details: [
        { label: 'permission.detail.command', value: '' },
      ],
    };

    let el = makeElement({ permissionContext: ctx });
    connectElement(el);

    let valueEl = el.querySelector('.detail-value');
    assert.equal(valueEl.textContent, '');
  });

  it('renders empty string for detail with undefined value', () => {
    let ctx = {
      title: 'permission.shell.executeTitle',
      details: [
        { label: 'permission.detail.command', value: undefined },
      ],
    };

    let el = makeElement({ permissionContext: ctx });
    connectElement(el);

    let valueEl = el.querySelector('.detail-value');
    assert.equal(valueEl.textContent, '');
  });
});

// =============================================================================
// 6. Expired attribute behavior
// =============================================================================

describe('kikx-permission-request — expired state', { timeout: 5000 }, () => {
  it('expired attribute is set without crashing', () => {
    let el = makeElement({ commands: [{ command: 'ls', arguments: [], status: 'needs-approval' }] });
    connectElement(el);

    el.setAttribute('expired', '');
    assert.ok(el.hasAttribute('expired'));
  });

  it('expired badge element exists in template', () => {
    let el = makeElement();
    connectElement(el);

    let expiredBadge = el.querySelector('.expired-badge');
    assert.ok(expiredBadge, 'expired badge should exist');
  });
});
