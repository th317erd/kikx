'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { PermissionHandler } from '../../../src/core/interaction/permission-handler.mjs';

// =============================================================================
// PermissionHandler Tests
// =============================================================================
// After Phase 3 legacy removal, only hardBreak and _denyNoUser remain.
// Approve / deny flows are handled by PermissionApprovalPlugin via FrameRouter.
// =============================================================================

describe('PermissionHandler', () => {
  let handler;
  let mockLoop;
  let emitted;
  let createdFrames;

  beforeEach(() => {
    emitted       = [];
    createdFrames = [];

    mockLoop = {
      _active: new Map(),
      _context: {
        getProperty(name) {
          if (name === 'models') return mockLoop._models;
          return null;
        },
      },
      _models: null,
      _activeKey(sessionID, agentID) {
        return (agentID) ? `${sessionID}:${agentID}` : sessionID;
      },
      async _createFrame(_sid, frameData, _fm, _opts) {
        createdFrames.push(frameData);
        return frameData;
      },
      emit(event, data) {
        emitted.push({ event, data });
      },
      async startInteraction(sessionID, params) {
        mockLoop._lastReplay = { sessionID, params };
        return 'int_replay';
      },
    };

    handler = new PermissionHandler(mockLoop);
  });

  // ---------------------------------------------------------------------------
  // hardBreak
  // ---------------------------------------------------------------------------

  describe('hardBreak', () => {
    it('should create pending-action, permission-request, and tool-result frames', async () => {
      let generator = { return: async () => {} };
      let block     = { content: { toolName: 'shell:execute', arguments: { command: 'ls' }, toolUseID: 'tu_1' } };

      mockLoop._active.set('ses_1', { generator });

      await handler.hardBreak('ses_1', generator, block, 'int_1', {}, null);

      assert.equal(createdFrames.length, 3);
      assert.equal(createdFrames[0].type, 'PendingAction');
      assert.equal(createdFrames[1].type, 'PermissionRequest');
      assert.equal(createdFrames[2].type, 'ToolResult');
      assert.ok(createdFrames[2].content.output.includes('PERMISSION REQUIRED'));
      assert.equal(createdFrames[2].content.toolUseID, 'tu_1');
    });

    it('should clean up active interaction after hardBreak', async () => {
      let generator = { return: async () => {} };
      let block     = { content: { toolName: 'test', arguments: {}, toolUseID: 'tu_1' } };

      mockLoop._active.set('ses_1', { generator });

      await handler.hardBreak('ses_1', generator, block, 'int_1', {}, null);

      assert.ok(!mockLoop._active.has('ses_1'), 'active interaction should be removed');
    });

    it('should destroy the generator', async () => {
      let returnCalled = false;
      let generator    = { return: async () => { returnCalled = true; } };
      let block        = { content: { toolName: 'test', arguments: {}, toolUseID: 'tu_1' } };

      mockLoop._active.set('ses_1', { generator });

      await handler.hardBreak('ses_1', generator, block, 'int_1', {}, null);
      assert.ok(returnCalled);
    });

    it('should emit interaction:end and permission:request', async () => {
      let generator = { return: async () => {} };
      let block     = { content: { toolName: 'test', arguments: {}, toolUseID: 'tu_1' } };

      mockLoop._active.set('ses_1', { generator });
      await handler.hardBreak('ses_1', generator, block, 'int_1', {}, null);

      let events = emitted.map((e) => e.event);
      assert.ok(events.includes('permission:request'));
      assert.ok(events.includes('interaction:end'));
    });
  });
});
