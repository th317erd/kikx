'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }        from '../../../src/core/index.mjs';
import { Keystore }              from '../../../src/core/crypto/keystore.mjs';
import { PermissionEngine }      from '../../../src/core/permissions/permission-engine.mjs';
import { PermissionService }     from '../../../src/core/permissions/permission-service.mjs';
import { setup }                 from '../../../src/core/internal-plugins/permissions/index.mjs';
import { FrameManager }          from '../../../src/shared/frame-manager/frame-manager.mjs';
import { PluginRegistry }        from '../../../src/core/plugin-loader/registry.mjs';

// =============================================================================
// Phase C3 — Permission Plugin Tests
// =============================================================================

// Helper: call setup(provide) and return the registered selectors
function setupAndCapture(ctx) {
  let registry = new PluginRegistry();
  setup((cb) => cb({ registry, context: ctx }));
  return registry.getSelectors();
}

// Helper: call setup(provide), return the PluginClass from registered selectors
function setupAndGetPluginClass(ctx) {
  let selectors = setupAndCapture(ctx);
  return selectors.length > 0 ? selectors[0].PluginClass : null;
}

describe('PermissionPlugin (C3)', () => {
  let core;
  let context;
  let keystore;
  let permissionService;

  before(async () => {
    core = createKikxCore();
    await core.start();
    context = core.getContext();

    keystore = new Keystore({ devMode: true, devSeed: 'perm-plugin-test' });
    keystore.initialize();
    context.setProperty('keystore', keystore);

    let permissionEngine = new PermissionEngine(context);
    permissionService = new PermissionService({ context, permissionEngine, keystore });
    context.setProperty('permissionService', permissionService);
  });

  after(async () => {
    if (keystore)
      keystore.destroy();

    if (core && core.isStarted())
      await core.stop();
  });

  // ---------------------------------------------------------------------------
  // setup()
  // ---------------------------------------------------------------------------

  describe('setup()', () => {
    it('should register a selector for type:ToolCall', () => {
      let selectors = setupAndCapture(context);

      assert.equal(selectors.length, 1);
      assert.equal(selectors[0].selector, 'type:ToolCall');
      assert.ok(selectors[0].PluginClass);
    });

    it('should skip registration when no permissionService on context', () => {
      let mockContext = {
        getProperty: (key) => undefined,
      };

      let selectors = setupAndCapture(mockContext);

      assert.equal(selectors.length, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // process()
  // ---------------------------------------------------------------------------

  describe('process()', () => {
    it('should pass through tool-call frames without signatures', async () => {
      let PluginClass = setupAndGetPluginClass(context);

      let frameManager = new FrameManager({ history: true });

      frameManager.merge([{
        id:         'frm_tc_1',
        type:       'ToolCall',
        content:    { toolName: 'shell:execute', arguments: { command: 'ls' } },
        authorType: 'agent',
        authorID:   'agt_1',
      }], { authorType: 'agent', authorID: 'agt_1' });

      let commit = frameManager.getLatestCommit();

      let plugin = new PluginClass({
        commit,
        session:      { id: 'ses_1' },
        frameManager,
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
    });

    it('should verify valid signatures on tool-call frames', async () => {
      let PluginClass = setupAndGetPluginClass(context);

      let signature    = permissionService.signApproval('shell:execute', { command: 'ls' }, 'ses_1');
      let frameManager = new FrameManager({ history: true });

      // Signature on frame.signature (HMAC fallback — no author public key in DB)
      frameManager.merge([{
        id:         'frm_tc_valid',
        type:       'ToolCall',
        content:    { toolName: 'shell:execute', arguments: { command: 'ls' } },
        signature,
        authorType: 'agent',
        authorID:   'agt_1',
      }], { authorType: 'agent', authorID: 'agt_1' });

      let commit = frameManager.getLatestCommit();

      let plugin = new PluginClass({
        commit,
        session:      { id: 'ses_1' },
        frameManager,
      });

      let nextCalled = false;
      // Should not throw or warn (valid HMAC signature, no public key to Ed25519-verify)
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
    });

    it('should warn on invalid signatures', async () => {
      let PluginClass = setupAndGetPluginClass(context);

      let frameManager = new FrameManager({ history: true });

      // Invalid signature on frame.signature (HMAC fallback path — no author in DB)
      frameManager.merge([{
        id:         'frm_tc_invalid',
        type:       'ToolCall',
        content:    { toolName: 'shell:execute', arguments: { command: 'ls' } },
        signature:  'a'.repeat(64),
        authorType: 'agent',
        authorID:   'agt_1',
      }], { authorType: 'agent', authorID: 'agt_1' });

      let commit = frameManager.getLatestCommit();

      let warnings = [];
      let plugin = new PluginClass({
        commit,
        session:      { id: 'ses_1' },
        frameManager,
        logger: {
          warn: (msg) => warnings.push(msg),
          error: console.error,
        },
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes('invalid signature'));
    });

    it('should handle commits with no changes', async () => {
      let PluginClass = setupAndGetPluginClass(context);

      let plugin = new PluginClass({
        commit:  { changes: [] },
        session: { id: 'ses_1' },
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
    });

    it('should handle null commit', async () => {
      let PluginClass = setupAndGetPluginClass(context);

      let plugin = new PluginClass({
        commit:  null,
        session: { id: 'ses_1' },
      });

      let nextCalled = false;
      await plugin.process(
        async () => { nextCalled = true; },
        async () => {},
      );

      assert.equal(nextCalled, true);
    });
  });
});
