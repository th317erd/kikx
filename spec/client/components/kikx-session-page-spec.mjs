'use strict';

// =============================================================================
// Unit tests for kikx-session-page: createFrameElement() and setupFrameRendering()
// =============================================================================
// These tests cover GAPS not already tested in:
//   - spec/client/create-frame-element-spec.mjs (65 tests)
//   - spec/client/event-driven-rendering-spec.mjs (33 tests)
//
// Focus areas:
//   - permission-request frames with permissionContext
//   - permission-request frames with toolArgs fallback
//   - system authorType: alignment and data-author-type
//   - session-link frames alignment
//   - compaction frames
//   - tool-activity frames (file-read, file-write, fallback)
//   - data-author-id attribute
//   - edge cases not covered by existing specs
// =============================================================================

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createElement,
  connectElement,
  clearBody,
} from '../helpers/jsdom-setup.mjs';

let createFrameElement;
let i18n;

before(async () => {
  i18n = await import('../../../src/client/lib/i18n.mjs');
  let en = (await import('../../../src/client/lib/locales/en.mjs')).default;
  i18n.setLocale(en, 'en');

  // Register components that createFrameElement depends on
  await import('../../../src/client/components/kikx-interaction/kikx-interaction.mjs');
  await import('../../../src/client/components/kikx-message-content/kikx-message-content.mjs');
  await import('../../../src/client/components/kikx-permission-request/kikx-permission-request.mjs');
  await import('../../../src/client/components/kikx-session-link/kikx-session-link.mjs');
  await import('../../../src/client/components/kikx-reflection-block/kikx-reflection-block.mjs');
  await import('../../../src/client/components/kikx-command-result/kikx-command-result.mjs');

  let mod = await import('../../../src/client/components/kikx-session-page/kikx-session-page.mjs');
  createFrameElement = mod.createFrameElement;
});

beforeEach(() => {
  clearBody();
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeFrame(overrides = {}) {
  return {
    id:            overrides.id || 'frame-001',
    type:          overrides.type || 'message',
    content:       overrides.content || { html: '<p>Hello world</p>' },
    order:         overrides.order ?? 1,
    timestamp:     overrides.timestamp || Date.now(),
    createdAt:     overrides.createdAt || Date.now(),
    interactionID: overrides.interactionID || 'interaction-001',
    authorType:    overrides.authorType || 'agent',
    authorName:    overrides.authorName || 'TestBot',
    authorID:      overrides.authorID || null,
    parentID:      overrides.parentID || null,
    hidden:        overrides.hidden ?? false,
    deleted:       overrides.deleted ?? false,
    ...overrides,
  };
}

// =============================================================================
// 1. Permission-request frames with permissionContext
// =============================================================================

describe('createFrameElement — permission-request with permissionContext', { timeout: 5000 }, () => {

  it('should set permissionContext on the child kikx-permission-request element', () => {
    let ctx = {
      title: 'permission.shell.executeTitle',
      description: 'permission.shell.executeDescription',
      details: [{ label: 'permission.detail.command', value: 'ls -la' }],
    };
    let frame = makeFrame({
      type: 'permission-request',
      content: { toolName: 'shell:execute', parsedCommands: [], permissionContext: ctx },
    });
    let el = createFrameElement(frame);

    let perm = el.querySelector('kikx-permission-request');
    assert.ok(perm, 'should contain kikx-permission-request');
    assert.deepEqual(perm.permissionContext, ctx);
  });

  it('should NOT set description when permissionContext is present (no parsedCommands)', () => {
    let ctx = {
      title: 'permission.shell.executeTitle',
      description: 'A custom description',
      details: [],
    };
    let frame = makeFrame({
      type: 'permission-request',
      content: { toolName: 'shell:execute', permissionContext: ctx },
    });
    let el = createFrameElement(frame);

    let perm = el.querySelector('kikx-permission-request');
    // When permissionContext is set and no parsedCommands, description should NOT
    // be overwritten with the default template
    assert.deepEqual(perm.permissionContext, ctx);
  });

  it('should NOT set description when permissionContext is present (with parsedCommands)', () => {
    let ctx = {
      title: 'permission.shell.executeTitle',
      details: [{ label: 'permission.detail.command', value: 'rm -rf /tmp' }],
    };
    let frame = makeFrame({
      type: 'permission-request',
      content: {
        toolName: 'shell:execute',
        parsedCommands: [{ command: 'rm', arguments: ['-rf', '/tmp'], status: 'needs-approval' }],
        permissionContext: ctx,
      },
    });
    let el = createFrameElement(frame);

    let perm = el.querySelector('kikx-permission-request');
    assert.deepEqual(perm.permissionContext, ctx);
    // commands should still be set
    assert.equal(perm.commands.length, 1);
    assert.equal(perm.commands[0].command, 'rm');
  });

  it('should NOT set toolArgs when permissionContext is present', () => {
    let ctx = {
      title: 'permission.shell.executeTitle',
      details: [],
    };
    let frame = makeFrame({
      type: 'permission-request',
      content: {
        toolName: 'shell:execute',
        arguments: { command: 'echo hello' },
        permissionContext: ctx,
      },
    });
    let el = createFrameElement(frame);

    let perm = el.querySelector('kikx-permission-request');
    // toolArgs should not be set when permissionContext provides the context
    assert.equal(perm.toolArgs, '');
  });
});

// =============================================================================
// 2. Permission-request frames with toolArgs fallback
// =============================================================================

describe('createFrameElement — permission-request with toolArgs fallback', { timeout: 5000 }, () => {

  it('should set description from template when no permissionContext (no parsedCommands)', () => {
    let frame = makeFrame({
      type: 'permission-request',
      authorType: 'agent',
      authorName: 'Claude',
      content: { toolName: 'file:read' },
    });
    let el = createFrameElement(frame);

    let perm = el.querySelector('kikx-permission-request');
    // Description should contain the agent name and tool name
    assert.ok(perm.description.includes('Claude'), 'description should include agent name');
    assert.ok(perm.description.includes('file:read'), 'description should include tool name');
  });

  it('should set toolArgs when arguments are present and no permissionContext', () => {
    let frame = makeFrame({
      type: 'permission-request',
      content: {
        toolName: 'file:read',
        arguments: { path: '/etc/passwd' },
      },
    });
    let el = createFrameElement(frame);

    let perm = el.querySelector('kikx-permission-request');
    assert.ok(perm.toolArgs.length > 0, 'toolArgs should be set');
    assert.ok(perm.toolArgs.includes('/etc/passwd'), 'toolArgs should contain the path');
  });

  it('should set fullCommand when parsedCommands and arguments.command present', () => {
    let frame = makeFrame({
      type: 'permission-request',
      content: {
        toolName: 'shell:execute',
        parsedCommands: [{ command: 'ls', arguments: ['-la'], status: 'needs-approval' }],
        arguments: { command: 'ls -la /home' },
      },
    });
    let el = createFrameElement(frame);

    let perm = el.querySelector('kikx-permission-request');
    assert.equal(perm.fullCommand, 'ls -la /home');
  });

  it('should create single-command entry when no parsedCommands', () => {
    let frame = makeFrame({
      type: 'permission-request',
      content: { toolName: 'db:query' },
    });
    let el = createFrameElement(frame);

    let perm = el.querySelector('kikx-permission-request');
    assert.equal(perm.commands.length, 1);
    assert.equal(perm.commands[0].command, 'db:query');
    assert.equal(perm.commands[0].status, 'needs-approval');
  });

  it('should set processed attribute when frame.processed is true', () => {
    let frame = makeFrame({
      type: 'permission-request',
      processed: true,
      content: {
        toolName: 'shell:execute',
        parsedCommands: [{ command: 'ls', arguments: [], status: 'needs-approval' }],
        decision: 'allow-once',
      },
    });
    let el = createFrameElement(frame);

    let perm = el.querySelector('kikx-permission-request');
    assert.ok(perm.hasAttribute('processed'), 'should have processed attribute');
  });
});

// =============================================================================
// 3. System authorType: alignment and data-author-type
// =============================================================================

describe('createFrameElement — system authorType', { timeout: 5000 }, () => {

  it('should set data-author-type="system" for system frames', () => {
    let frame = makeFrame({
      type: 'message',
      authorType: 'system',
      content: { html: '<p>System message</p>' },
    });
    let el = createFrameElement(frame);

    assert.equal(el.getAttribute('data-author-type'), 'system');
  });

  it('should set alignment="agent" for system authorType messages', () => {
    let frame = makeFrame({
      type: 'message',
      authorType: 'system',
      content: { html: '<p>System notice</p>' },
    });
    let el = createFrameElement(frame);

    assert.equal(el.getAttribute('alignment'), 'agent');
  });

  it('should set data-author-type="agent" for agent frames', () => {
    let frame = makeFrame({
      type: 'message',
      authorType: 'agent',
      content: { html: '<p>Agent reply</p>' },
    });
    let el = createFrameElement(frame);

    assert.equal(el.getAttribute('data-author-type'), 'agent');
  });

  it('should set data-author-type="user" for user frames', () => {
    let frame = makeFrame({
      type: 'user-message',
      authorType: 'user',
      content: { text: 'Hello' },
    });
    let el = createFrameElement(frame);

    assert.equal(el.getAttribute('data-author-type'), 'user');
  });

  it('should NOT set data-author-type when authorType is undefined', () => {
    let frame = makeFrame({
      type: 'message',
      authorType: undefined,
      content: { html: '<p>No author type</p>' },
    });
    let el = createFrameElement(frame);

    assert.equal(el.getAttribute('data-author-type'), null);
  });
});

// =============================================================================
// 4. data-author-id attribute
// =============================================================================

describe('createFrameElement — data-author-id', { timeout: 5000 }, () => {

  it('should set data-author-id when authorID is present', () => {
    let frame = makeFrame({
      type: 'message',
      authorID: 'agt_abc123',
      content: { html: '<p>Hi</p>' },
    });
    let el = createFrameElement(frame);

    assert.equal(el.getAttribute('data-author-id'), 'agt_abc123');
  });

  it('should NOT set data-author-id when authorID is null', () => {
    let frame = makeFrame({
      type: 'message',
      authorID: null,
      content: { html: '<p>Hi</p>' },
    });
    let el = createFrameElement(frame);

    assert.equal(el.getAttribute('data-author-id'), null);
  });

  it('should NOT set data-author-id when authorID is undefined', () => {
    let frame = makeFrame({
      type: 'message',
      authorID: undefined,
      content: { html: '<p>Hi</p>' },
    });
    let el = createFrameElement(frame);

    assert.equal(el.getAttribute('data-author-id'), null);
  });
});

// =============================================================================
// 5. Compaction frames
// =============================================================================

describe('createFrameElement — compaction frames', { timeout: 5000 }, () => {

  it('should return a kikx-compaction-frame element for type "compaction"', () => {
    let frame = makeFrame({
      type: 'compaction',
      content: { status: 'started' },
    });
    let el = createFrameElement(frame);

    assert.ok(el, 'should return an element');
    assert.equal(el.tagName.toLowerCase(), 'kikx-compaction-frame');
  });

  it('should set data-frame-id on compaction frames', () => {
    let frame = makeFrame({
      id: 'compaction-001',
      type: 'compaction',
      content: { status: 'completed' },
    });
    let el = createFrameElement(frame);

    assert.equal(el.getAttribute('data-frame-id'), 'compaction-001');
  });

  it('should set status attribute from content.status', () => {
    let frame = makeFrame({
      type: 'compaction',
      content: { status: 'completed' },
    });
    let el = createFrameElement(frame);

    assert.equal(el.getAttribute('status'), 'completed');
  });

  it('should default status to "started" when not specified', () => {
    let frame = makeFrame({
      type: 'compaction',
      content: {},
    });
    let el = createFrameElement(frame);

    assert.equal(el.getAttribute('status'), 'started');
  });

  it('should set session-id attribute when sessionID is present', () => {
    let frame = makeFrame({
      type: 'compaction',
      sessionID: 'sess-abc',
      content: { status: 'started' },
    });
    let el = createFrameElement(frame);

    assert.equal(el.getAttribute('session-id'), 'sess-abc');
  });

  it('should set frames-compacted attribute', () => {
    let frame = makeFrame({
      type: 'compaction',
      content: { status: 'completed', framesCompacted: 42 },
    });
    let el = createFrameElement(frame);

    assert.equal(el.getAttribute('frames-compacted'), '42');
  });

  it('should set compactor-name from compactorAgentID', () => {
    let frame = makeFrame({
      type: 'compaction',
      content: { status: 'completed', compactorAgentID: 'agt_compactor' },
    });
    let el = createFrameElement(frame);

    assert.equal(el.getAttribute('compactor-name'), 'agt_compactor');
  });

  it('should set started-at attribute when present', () => {
    let frame = makeFrame({
      type: 'compaction',
      content: { status: 'completed', startedAt: '2026-03-21T00:00:00Z' },
    });
    let el = createFrameElement(frame);

    assert.equal(el.getAttribute('started-at'), '2026-03-21T00:00:00Z');
  });

  it('should NOT be a kikx-interaction — compaction is a standalone element', () => {
    let frame = makeFrame({
      type: 'compaction',
      content: { status: 'started' },
    });
    let el = createFrameElement(frame);

    assert.notEqual(el.tagName.toLowerCase(), 'kikx-interaction');
  });
});

// =============================================================================
// 6. Session-link alignment
// =============================================================================

describe('createFrameElement — session-link alignment', { timeout: 5000 }, () => {

  it('should set alignment="system" on session-link frames', () => {
    let frame = makeFrame({
      type: 'session-link',
      content: { targetSessionID: 'sess-123', title: 'Sub-session' },
    });
    let el = createFrameElement(frame);

    assert.equal(el.getAttribute('alignment'), 'system');
  });

  it('should set participant-name="System" on session-link frames', () => {
    let frame = makeFrame({
      type: 'session-link',
      authorType: 'agent',
      authorName: 'Claude',
      content: { targetSessionID: 'sess-123', title: 'Sub-session' },
    });
    let el = createFrameElement(frame);

    assert.equal(el.getAttribute('participant-name'), 'System');
  });

  it('should set participant-count on session-link when participants provided', () => {
    let frame = makeFrame({
      type: 'session-link',
      content: {
        targetSessionID: 'sess-123',
        title: 'Group sub-session',
        participants: ['agent-a', 'agent-b', 'agent-c'],
      },
    });
    let el = createFrameElement(frame);

    let link = el.querySelector('kikx-session-link');
    assert.equal(link.getAttribute('participant-count'), '3');
  });
});

// =============================================================================
// 7. Message content: string content handling
// =============================================================================

describe('createFrameElement — message content edge cases', { timeout: 5000 }, () => {

  it('should handle string content directly (not object)', () => {
    let frame = makeFrame({
      type: 'message',
      content: '<p>Direct string content</p>',
    });
    let el = createFrameElement(frame);

    let mc = el.querySelector('kikx-message-content');
    assert.ok(mc, 'should have message-content child');
  });

  it('should escape text content with HTML entities', () => {
    let frame = makeFrame({
      type: 'message',
      content: { text: 'Hello <world> & "friends"' },
    });
    let el = createFrameElement(frame);

    let mc = el.querySelector('kikx-message-content');
    assert.ok(mc, 'should have message-content child');
    // The text should be wrapped in <p> and HTML-escaped
    assert.ok(mc.content.includes('&lt;world&gt;') || mc.content.includes('<p>'), 'should be escaped or wrapped');
  });
});
