'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { PermissionHandler } from '../../../src/core/interaction/permission-handler.mjs';

// =============================================================================
// Phase C5 — PermissionHandler Tests
// =============================================================================

describe('PermissionHandler (C5)', () => {
  let handler;
  let mockLoop;
  let emitted;
  let createdFrames;

  beforeEach(() => {
    emitted       = [];
    createdFrames = [];

    mockLoop = {
      _permissionWaiting: new Map(),
      _active:            new Map(),
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
    it('should create pending-action and permission-request frames', async () => {
      let generator = { return: async () => {} };
      let block     = { content: { toolName: 'shell:execute', arguments: { command: 'ls' }, toolUseID: 'tu_1' } };

      mockLoop._active.set('ses_1', { generator });

      await handler.hardBreak('ses_1', generator, block, 'int_1', {}, null);

      assert.equal(createdFrames.length, 2);
      assert.equal(createdFrames[0].type, 'pending-action');
      assert.equal(createdFrames[1].type, 'permission-request');
    });

    it('should store permission-waiting state', async () => {
      let generator = { return: async () => {} };
      let block     = { content: { toolName: 'test', arguments: {}, toolUseID: 'tu_1' } };
      let params    = { agentPlugin: {} };

      mockLoop._active.set('ses_1', { generator });

      await handler.hardBreak('ses_1', generator, block, 'int_1', params, null);

      assert.ok(mockLoop._permissionWaiting.has('ses_1'));
      let waiting = mockLoop._permissionWaiting.get('ses_1');
      assert.equal(waiting.interactionID, 'int_1');
      assert.equal(waiting.params, params);
    });

    it('should destroy the generator', async () => {
      let returnCalled = false;
      let generator    = { return: async () => { returnCalled = true; } };
      let block        = { content: { toolName: 'test', arguments: {}, toolUseID: 'tu_1' } };

      mockLoop._active.set('ses_1', { generator });

      await handler.hardBreak('ses_1', generator, block, 'int_1', {}, null);
      assert.ok(returnCalled);
    });

    it('should clean up active interaction', async () => {
      let generator = { return: async () => {} };
      let block     = { content: { toolName: 'test', arguments: {}, toolUseID: 'tu_1' } };

      mockLoop._active.set('ses_1', { generator });
      await handler.hardBreak('ses_1', generator, block, 'int_1', {}, null);

      assert.ok(!mockLoop._active.has('ses_1'));
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

  // ---------------------------------------------------------------------------
  // approve
  // ---------------------------------------------------------------------------

  describe('approve', () => {
    it('should throw when no pending permission', async () => {
      await assert.rejects(
        () => handler.approve('ses_1', 'frm_1'),
        /No pending permission/,
      );
    });

    it('should execute tool and store result frame', async () => {
      let toolCalled = false;

      mockLoop._permissionWaiting.set('ses_1', {
        pendingFrameID:  'frm_pending',
        requestFrameID:  'frm_request',
        interactionID:   'int_1',
        params:          {
          executeTool: async (name, args) => { toolCalled = true; return 'tool output'; },
        },
        frameManager:    null,
      });

      mockLoop._models = {
        Frame: {
          where: {
            id: {
              EQ: (id) => ({
                first: async () => ({
                  getContent: () => ({ toolName: 'test', arguments: {}, toolUseID: 'tu_1' }),
                  processed: false,
                  save: async () => {},
                }),
              }),
            },
          },
        },
      };

      await handler.approve('ses_1', 'frm_pending');

      assert.ok(toolCalled);
      assert.ok(createdFrames.some((f) => f.type === 'tool-result'));
    });

    it('should clear permission-waiting state', async () => {
      mockLoop._permissionWaiting.set('ses_1', {
        pendingFrameID: 'frm_pending',
        requestFrameID: 'frm_request',
        interactionID:  'int_1',
        params:         { executeTool: async () => 'ok' },
        frameManager:   null,
      });

      mockLoop._models = {
        Frame: {
          where: {
            id: {
              EQ: () => ({
                first: async () => ({
                  getContent: () => ({ toolName: 'test', arguments: {}, toolUseID: 'tu_1' }),
                  processed: false,
                  save: async () => {},
                }),
              }),
            },
          },
        },
      };

      await handler.approve('ses_1', 'frm_pending');

      assert.ok(!mockLoop._permissionWaiting.has('ses_1'));
    });

    it('should start new interaction with replayFromPermission', async () => {
      mockLoop._permissionWaiting.set('ses_1', {
        pendingFrameID: 'frm_pending',
        requestFrameID: null,
        interactionID:  'int_1',
        params:         { executeTool: async () => 'ok', agent: { id: 'agt_1' } },
        frameManager:   null,
      });

      mockLoop._models = {
        Frame: {
          where: {
            id: {
              EQ: () => ({
                first: async () => ({
                  getContent: () => ({ toolName: 'test', arguments: {} }),
                  processed: false,
                  save: async () => {},
                }),
              }),
            },
          },
        },
      };

      await handler.approve('ses_1', null);

      assert.ok(mockLoop._lastReplay);
      assert.equal(mockLoop._lastReplay.params.replayFromPermission, true);
    });
  });

  // ---------------------------------------------------------------------------
  // deny
  // ---------------------------------------------------------------------------

  describe('deny', () => {
    it('should throw when no pending permission', async () => {
      await assert.rejects(
        () => handler.deny('ses_1', 'frm_1'),
        /No pending permission/,
      );
    });

    it('should mark pending frame as processed and create denial frame', async () => {
      let savedRecords = [];

      mockLoop._permissionWaiting.set('ses_1', {
        pendingFrameID: 'frm_pending',
        requestFrameID: 'frm_request',
        interactionID:  'int_1',
        params:         { agent: { id: 'agt_1' } },
        frameManager:   null,
      });

      mockLoop._models = {
        Frame: {
          where: {
            id: {
              EQ: () => ({
                first: async () => ({
                  processed: false,
                  content:   { toolName: 'shell:execute', toolUseID: 'tu_1' },
                  save: async function() { savedRecords.push(this); },
                }),
              }),
            },
          },
        },
      };

      await handler.deny('ses_1', 'frm_pending');

      assert.ok(createdFrames.some((f) => f.type === 'permission-denied'));
      assert.ok(createdFrames.some((f) => f.type === 'tool-result' && f.content.toolUseID === 'tu_1'));
      assert.ok(createdFrames.some((f) => f.type === 'tool-result' && f.content.output.includes('Permission denied')));
      assert.ok(!mockLoop._permissionWaiting.has('ses_1'));
    });

    it('should start new interaction with replayFromPermission', async () => {
      mockLoop._permissionWaiting.set('ses_1', {
        pendingFrameID: 'frm_pending',
        requestFrameID: null,
        interactionID:  'int_1',
        params:         { agent: { id: 'agt_1' } },
        frameManager:   null,
      });

      mockLoop._models = {
        Frame: {
          where: {
            id: {
              EQ: () => ({
                first: async () => ({
                  processed: false,
                  content:   { toolName: 'shell:execute', toolUseID: 'tu_2' },
                  save: async () => {},
                }),
              }),
            },
          },
        },
      };

      await handler.deny('ses_1', 'frm_pending');

      assert.ok(mockLoop._lastReplay);
      assert.equal(mockLoop._lastReplay.params.replayFromPermission, true);
    });
  });
});
