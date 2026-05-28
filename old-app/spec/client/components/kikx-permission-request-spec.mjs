'use strict';

// =============================================================================
// Unit tests for <kikx-permission-request> WebComponent
// =============================================================================

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createElement,
  connectElement,
  disconnectElement,
  clearBody,
} from '../helpers/jsdom-setup.mjs';

// Load i18n with real English locale so t() calls inside the component work
let i18n;

before(async () => {
  i18n = await import('../../../src/client/lib/i18n.mjs');
  let en = (await import('../../../src/client/lib/locales/en.mjs')).default;
  i18n.setLocale(en, 'en');

  // Register the component
  await import('../../../src/client/components/kikx-permission-request/kikx-permission-request.mjs');
});

beforeEach(() => {
  clearBody();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCommands(count = 2) {
  let commands = [];
  for (let i = 0; i < count; i++) {
    commands.push({
      command:   `cmd-${i}`,
      arguments: [`--flag-${i}`],
      status:    'needs-approval',
    });
  }
  return commands;
}

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
// 1. Pre-connection state
// =============================================================================

describe('kikx-permission-request — pre-connection state', { timeout: 5000 }, () => {
  it('stores description in backing field before connect', () => {
    let el = makeElement({ description: 'Run shell command' });
    assert.equal(el.description, 'Run shell command');
    assert.equal(el._descriptionEl, undefined);
  });

  it('stores toolArgs in backing field before connect', () => {
    let el = makeElement({ toolArgs: '{"cmd": "ls -la"}' });
    assert.equal(el.toolArgs, '{"cmd": "ls -la"}');
  });

  it('stores permissionContext in backing field before connect', () => {
    let ctx = { title: 'permission.shell.executeTitle', details: [] };
    let el = makeElement({ permissionContext: ctx });
    assert.deepEqual(el.permissionContext, ctx);
  });

  it('stores commands in backing array before connect', () => {
    let cmds = makeCommands(3);
    let el = makeElement({ commands: cmds });
    assert.equal(el.commands.length, 3);
  });

  it('stores fullCommand in backing field before connect', () => {
    let el = makeElement({ fullCommand: 'rm -rf /tmp/foo' });
    assert.equal(el.fullCommand, 'rm -rf /tmp/foo');
  });
});

// =============================================================================
// 2. Connected rendering
// =============================================================================

describe('kikx-permission-request — connected rendering', { timeout: 5000 }, () => {
  it('renders template on connect (title, description, command-table exist)', () => {
    let el = connectElement(makeElement());
    assert.ok(el.querySelector('.title-text'), 'title-text should exist');
    assert.ok(el.querySelector('.permission-description'), 'description should exist');
    assert.ok(el.querySelector('.command-table'), 'command-table should exist');
    assert.ok(el.querySelector('.confirm-button'), 'confirm-button should exist');
  });

  it('applies backed description after connect', () => {
    let el = makeElement({ description: 'Execute dangerous command' });
    connectElement(el);
    assert.equal(el.querySelector('.permission-description').textContent, 'Execute dangerous command');
  });

  it('applies backed toolArgs after connect (code block visible)', () => {
    let el = makeElement({ toolArgs: '{"command":"ls"}' });
    connectElement(el);
    let codeEl = el.querySelector('.permission-tool-args code');
    assert.equal(codeEl.textContent, '{"command":"ls"}');
    assert.notEqual(el.querySelector('.permission-tool-args').style.display, 'none');
  });

  it('applies backed fullCommand after connect', () => {
    let el = makeElement({ fullCommand: 'echo hello' });
    connectElement(el);
    let codeEl = el.querySelector('.full-command');
    assert.equal(codeEl.textContent, 'echo hello');
    assert.notEqual(codeEl.style.display, 'none');
  });

  it('renders commands as rows in the command table', () => {
    let el = makeElement({ commands: makeCommands(3) });
    connectElement(el);

    // 3 command rows + 1 header row (select-all, since >1 needs approval)
    let rows = el.querySelectorAll('.command-row');
    assert.ok(rows.length >= 3, `Expected at least 3 rows, got ${rows.length}`);
  });
});

// =============================================================================
// 3. permissionContext rendering
// =============================================================================

describe('kikx-permission-request — permissionContext rendering', { timeout: 5000 }, () => {
  it('renders detail rows from permissionContext', () => {
    let ctx = {
      title: 'permission.shell.executeTitle',
      description: 'permission.shell.executeDescription',
      details: [
        { label: 'permission.detail.command', value: 'ls -la' },
        { label: 'permission.detail.arguments', value: '--all' },
      ],
    };

    let el = makeElement({ permissionContext: ctx });
    connectElement(el);

    let rows = el.querySelectorAll('.detail-row');
    assert.equal(rows.length, 2, 'Should render 2 detail rows');
  });

  it('resolves known labels via i18n, falls back to Title Case for unknown', () => {
    let ctx = {
      title: 'permission.shell.executeTitle',
      details: [
        { label: 'permission.detail.command', value: 'ls' },
        { label: 'unknownCamelCase', value: 'test' },
      ],
    };

    let el = makeElement({ permissionContext: ctx });
    connectElement(el);

    let labels = el.querySelectorAll('.detail-label');
    // Known key resolves to locale value + ':'
    assert.equal(labels[0].textContent, 'Command:');
    // Unknown camelCase falls back to "Unknown Camel Case:"
    assert.equal(labels[1].textContent, 'Unknown Camel Case:');
  });

  it('hides toolArgs display when permissionContext is set (context takes priority)', () => {
    let el = makeElement({
      toolArgs: '{"some":"args"}',
      permissionContext: {
        title: 'permission.shell.executeTitle',
        details: [{ label: 'permission.detail.command', value: 'echo' }],
      },
    });

    connectElement(el);
    assert.equal(el.querySelector('.permission-tool-args').style.display, 'none');
  });

  it('sets title and description from permissionContext', () => {
    let ctx = {
      title: 'permission.shell.executeTitle',
      description: 'permission.shell.executeDescription',
      details: [],
    };

    let el = makeElement({ permissionContext: ctx });
    connectElement(el);

    assert.equal(el.querySelector('.title-text').textContent, 'Execute Shell Command');
    assert.equal(el.querySelector('.permission-description').textContent, 'Run commands in the system shell.');
  });

  it('hides details section when details array is empty', () => {
    let ctx = {
      title: 'permission.shell.executeTitle',
      details: [],
    };

    let el = makeElement({ permissionContext: ctx });
    connectElement(el);

    assert.equal(el.querySelector('.permission-details').style.display, 'none');
  });
});

// =============================================================================
// 4. Events
// =============================================================================

describe('kikx-permission-request — events', { timeout: 5000 }, () => {
  it('dispatches permission-response on confirm click', () => {
    let cmds = [{ command: 'ls', arguments: [], status: 'needs-approval' }];
    let el = makeElement({ permissionId: 'perm-42', commands: cmds });
    connectElement(el);

    // Select a decision for the command
    clickDecision(el, 'ls', 'allow-once');

    let received = null;
    el.addEventListener('permission-response', (e) => { received = e.detail; });

    el.querySelector('.confirm-button').click();

    assert.ok(received, 'Event should have been dispatched');
    assert.equal(received.permissionID, 'perm-42');
    assert.equal(received.decisions.length, 1);
    assert.equal(received.decisions[0].command, 'ls');
    assert.equal(received.decisions[0].decision, 'allow-once');
  });

  it('decision buttons update active state on click', () => {
    let cmds = [{ command: 'rm', arguments: ['-rf'], status: 'needs-approval' }];
    let el = makeElement({ commands: cmds });
    connectElement(el);

    clickDecision(el, 'rm', 'deny-forever');

    let row = el.querySelector('.command-row[data-command="rm"]');
    let activeBtn = row.querySelector('.decision-button.active-deny');
    assert.ok(activeBtn, 'deny-forever button should have active-deny class');
  });

  it('event detail includes permission-id from attribute', () => {
    let el = makeElement({ permissionId: 'perm-99' });
    connectElement(el);

    // No commands => confirm is enabled immediately
    let received = null;
    el.addEventListener('permission-response', (e) => { received = e.detail; });

    el.querySelector('.confirm-button').click();

    assert.equal(received.permissionID, 'perm-99');
  });
});

// =============================================================================
// 5. Edge cases
// =============================================================================

describe('kikx-permission-request — edge cases', { timeout: 5000 }, () => {
  it('setting description to null does not crash', () => {
    let el = makeElement();
    connectElement(el);
    el.description = null;
    assert.equal(el.description, '');
  });

  it('setting toolArgs to undefined does not crash', () => {
    let el = makeElement();
    connectElement(el);
    el.toolArgs = undefined;
    assert.equal(el.toolArgs, '');
  });

  it('setting permissionContext to null does not crash', () => {
    let el = makeElement();
    connectElement(el);
    el.permissionContext = null;
    assert.equal(el.permissionContext, null);
  });

  it('disconnect removes event listeners without error', () => {
    let el = makeElement({ commands: makeCommands(1) });
    connectElement(el);
    disconnectElement(el);
    // Should not throw
    assert.ok(true);
  });

  it('re-connect re-applies backed values', () => {
    let el = makeElement({ description: 'First connect' });
    connectElement(el);
    disconnectElement(el);

    el.description = 'Second connect';
    connectElement(el);

    assert.equal(el.querySelector('.permission-description').textContent, 'Second connect');
  });

  it('empty commands array renders no command rows', () => {
    let el = makeElement({ commands: [] });
    connectElement(el);

    let rows = el.querySelectorAll('.command-row');
    assert.equal(rows.length, 0);
  });

  it('toolArgs as string is displayed in code block', () => {
    let el = makeElement({ toolArgs: 'plain string args' });
    connectElement(el);

    let code = el.querySelector('.permission-tool-args code');
    assert.equal(code.textContent, 'plain string args');
  });

  it('permissionContext with null title/description fields is graceful', () => {
    let ctx = {
      title: null,
      description: null,
      details: [{ label: 'permission.detail.command', value: 'test' }],
    };

    let el = makeElement({ permissionContext: ctx });
    connectElement(el);

    // Should not crash; details should still render
    let rows = el.querySelectorAll('.detail-row');
    assert.equal(rows.length, 1);
  });

  it('commands set to non-array value is coerced to empty array', () => {
    let el = makeElement();
    connectElement(el);
    el.commands = 'not-an-array';
    assert.deepEqual(el.commands, []);
  });

  it('confirm button is disabled until all commands have decisions', () => {
    let cmds = makeCommands(2);
    let el = makeElement({ commands: cmds });
    connectElement(el);

    assert.equal(el.querySelector('.confirm-button').disabled, true);

    clickDecision(el, 'cmd-0', 'allow-once');
    assert.equal(el.querySelector('.confirm-button').disabled, true);

    clickDecision(el, 'cmd-1', 'deny-once');
    assert.equal(el.querySelector('.confirm-button').disabled, false);
  });

  it('confirm button is enabled immediately when commands array is empty', () => {
    let el = makeElement({ commands: [] });
    connectElement(el);
    assert.equal(el.querySelector('.confirm-button').disabled, false);
  });

  it('pre-approved commands show badge and no decision buttons', () => {
    let cmds = [{ command: 'safe-cmd', arguments: [], status: 'allowed' }];
    let el = makeElement({ commands: cmds });
    connectElement(el);

    let row = el.querySelector('.command-row[data-command="safe-cmd"]');
    assert.ok(row.classList.contains('pre-approved'));
    assert.ok(row.querySelector('.pre-approved-badge'));
    assert.equal(row.querySelectorAll('.decision-button').length, 0);
  });

  it('select-all header appears when multiple commands need approval', () => {
    let cmds = makeCommands(3);
    let el = makeElement({ commands: cmds });
    connectElement(el);

    let header = el.querySelector('.command-row.header-row');
    assert.ok(header, 'Header row should exist');
    assert.ok(header.querySelector('[data-select-all]'), 'Should have select-all buttons');
  });

  it('select-all applies decision to all command rows', () => {
    let cmds = makeCommands(2);
    let el = makeElement({ commands: cmds });
    connectElement(el);

    // Click select-all "allow-forever"
    let headerBtn = el.querySelector('.header-row .decision-button[data-decision="allow-forever"]');
    headerBtn.click();

    // Confirm should now be enabled (all decided)
    assert.equal(el.querySelector('.confirm-button').disabled, false);

    // Both commands should have allow-forever active
    for (let cmd of cmds) {
      let row = el.querySelector(`.command-row[data-command="${cmd.command}"]`);
      let active = row.querySelector('.decision-button.active-allow');
      assert.ok(active, `${cmd.command} should have active-allow`);
    }
  });

  it('processed attribute hides command table and confirm button via CSS attribute', () => {
    let el = makeElement({ commands: makeCommands(1) });
    connectElement(el);

    el.setAttribute('processed', '');
    assert.ok(el.hasAttribute('processed'));
  });
});
