'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { PermissionHandler } from '../../../src/core/interaction/permission-handler.mjs';

// =============================================================================
// Step 1.4 — PermissionHandler rich permission context
// =============================================================================

describe('PermissionHandler — rich permissionContext (Step 1.4)', () => {
  let handler;
  let mockLoop;
  let createdFrames;

  beforeEach(() => {
    createdFrames = [];

    mockLoop = {
      _active:            new Map(),
      _activeKey(sessionID, agentID) {
        return (agentID) ? `${sessionID}:${agentID}` : sessionID;
      },
      async _createFrame(_sid, frameData, _fm, _opts) {
        createdFrames.push(frameData);
        return frameData;
      },
      emit() {},
    };

    handler = new PermissionHandler(mockLoop);
  });

  // Helper to build a minimal block for hardBreak
  function makeBlock(toolName, args) {
    return {
      content: {
        toolName:  toolName || 'test:tool',
        arguments: args || { key: 'value' },
        toolUseID: 'tu_1',
      },
    };
  }

  function makeGenerator() {
    return { return: async () => {} };
  }

  // ---------------------------------------------------------------------------
  // Happy paths
  // ---------------------------------------------------------------------------

  it('hardBreak with permissionContext includes it in permission-request frame', async () => {
    let permissionContext = {
      title:       'permission.crossSession.postTitle',
      titleParams: { sessionName: 'My Project' },
      description: 'permission.crossSession.postDescription',
      details:     [{ label: 'permission.detail.targetSession', value: 'My Project (ses_xxx)' }],
    };

    await handler.hardBreak('ses_1', makeGenerator(), makeBlock(), 'int_1', {}, null, permissionContext);

    let requestFrame = createdFrames.find((f) => f.type === 'PermissionRequest');
    assert.ok(requestFrame, 'permission-request frame should exist');
    assert.deepStrictEqual(requestFrame.content.permissionContext, permissionContext);
  });

  it('permissionContext.details array is preserved in full', async () => {
    let details = [
      { label: 'permission.detail.targetSession', value: 'My Project (ses_xxx)' },
      { label: 'permission.detail.messagePreview', value: 'Hello world' },
      { label: 'permission.detail.command', value: 'ls -la' },
    ];

    let permissionContext = {
      title:       'permission.shell.executeTitle',
      description: 'permission.shell.executeDescription',
      details,
    };

    await handler.hardBreak('ses_1', makeGenerator(), makeBlock(), 'int_1', {}, null, permissionContext);

    let requestFrame = createdFrames.find((f) => f.type === 'PermissionRequest');
    assert.equal(requestFrame.content.permissionContext.details.length, 3);
    assert.deepStrictEqual(requestFrame.content.permissionContext.details, details);
  });

  it('permissionContext.title and description are preserved', async () => {
    let permissionContext = {
      title:       'permission.crossSession.postTitle',
      titleParams: { sessionName: 'Test Session' },
      description: 'permission.crossSession.postDescription',
      details:     [],
    };

    await handler.hardBreak('ses_1', makeGenerator(), makeBlock(), 'int_1', {}, null, permissionContext);

    let requestFrame = createdFrames.find((f) => f.type === 'PermissionRequest');
    assert.equal(requestFrame.content.permissionContext.title, 'permission.crossSession.postTitle');
    assert.equal(requestFrame.content.permissionContext.description, 'permission.crossSession.postDescription');
    assert.deepStrictEqual(requestFrame.content.permissionContext.titleParams, { sessionName: 'Test Session' });
  });

  it('existing fields (toolName, arguments) are unchanged when permissionContext is provided', async () => {
    let permissionContext = {
      title:       'permission.defaultTitle',
      description: 'permission.defaultDescription',
      details:     [],
    };

    let block = makeBlock('shell:execute', { command: 'echo hi' });
    await handler.hardBreak('ses_1', makeGenerator(), block, 'int_1', {}, null, permissionContext);

    let requestFrame = createdFrames.find((f) => f.type === 'PermissionRequest');
    assert.equal(requestFrame.content.toolName, 'shell:execute');
    assert.deepStrictEqual(requestFrame.content.arguments, { command: 'echo hi' });
    assert.ok(requestFrame.content.pendingFrameID, 'pendingFrameID should be present');
  });

  // ---------------------------------------------------------------------------
  // Sad paths
  // ---------------------------------------------------------------------------

  it('hardBreak without permissionContext does not add the key to frame content', async () => {
    await handler.hardBreak('ses_1', makeGenerator(), makeBlock(), 'int_1', {}, null);

    let requestFrame = createdFrames.find((f) => f.type === 'PermissionRequest');
    assert.ok(requestFrame, 'permission-request frame should exist');
    assert.equal(requestFrame.content.permissionContext, undefined, 'permissionContext should not be present');
    assert.equal('permissionContext' in requestFrame.content, false, 'key should not exist on content');
  });

  it('permissionContext as null is not included in frame content', async () => {
    await handler.hardBreak('ses_1', makeGenerator(), makeBlock(), 'int_1', {}, null, null);

    let requestFrame = createdFrames.find((f) => f.type === 'PermissionRequest');
    assert.ok(requestFrame, 'permission-request frame should exist');
    assert.equal('permissionContext' in requestFrame.content, false, 'null permissionContext should not appear');
  });
});
