'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert                        from 'node:assert/strict';

import { FrameRouter }    from '../../../src/core/routing/frame-router.mjs';
import { BasePluginClass } from '../../../src/core/routing/base-plugin-class.mjs';
import { FrameManager }   from '../../../src/shared/frame-manager/frame-manager.mjs';

// =============================================================================
// Helpers
// =============================================================================

function silentLogger() {
  return {
    log:   () => {},
    warn:  () => {},
    error: () => {},
    info:  () => {},
  };
}

function createRouter() {
  return new FrameRouter({ logger: silentLogger() });
}

function createTrackerPlugin(tracker, label) {
  return class TrackerPlugin extends BasePluginClass {
    async process(next, done) {
      tracker.push(label || 'tracker');
      return await next(this.context);
    }
  };
}

// Wait for any queued async processing to complete
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

// =============================================================================
// FrameRouter
// =============================================================================

describe('FrameRouter', () => {

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  describe('registration', () => {
    it('should accept string selectors', () => {
      let router = createRouter();
      router.registerSelector('type:UserMessage', BasePluginClass, 'test');
      assert.strictEqual(router.getRegistrations().length, 1);
    });

    it('should accept function selectors', () => {
      let router = createRouter();
      router.registerSelector(() => true, BasePluginClass, 'test');
      assert.strictEqual(router.getRegistrations().length, 1);
    });

    it('should throw on invalid selectors', () => {
      let router = createRouter();
      assert.throws(
        () => router.registerSelector('invalid', BasePluginClass, 'test'),
        { message: /Invalid selector/ },
      );
    });

    it('should load from a registry', () => {
      let router = createRouter();

      let registry = {
        getSelectors: () => [
          { selector: 'type:UserMessage', PluginClass: BasePluginClass, pluginName: 'a' },
          { selector: 'type:ToolCall', PluginClass: BasePluginClass, pluginName: 'b' },
        ],
      };

      router.loadFromRegistry(registry);
      assert.strictEqual(router.getRegistrations().length, 2);
    });
  });

  // ---------------------------------------------------------------------------
  // connectTo / basic routing
  // ---------------------------------------------------------------------------

  describe('connectTo and commit-driven routing', () => {
    it('should route non-silent commits to matching plugins', async () => {
      let router = createRouter();
      let fm     = new FrameManager();
      let calls  = [];

      router.registerSelector('type:UserMessage', createTrackerPlugin(calls, 'matched'), 'test');
      router.connectTo(fm);

      fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }]);
      await tick();

      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0], 'matched');
    });

    it('should NOT route silent commits', async () => {
      let router = createRouter();
      let fm     = new FrameManager();
      let calls  = [];

      router.registerSelector('type:UserMessage', createTrackerPlugin(calls, 'matched'), 'test');
      router.connectTo(fm);

      fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }], { silent: true });
      await tick();

      assert.strictEqual(calls.length, 0);
    });

    it('should not match selectors that do not match the frame', async () => {
      let router = createRouter();
      let fm     = new FrameManager();
      let calls  = [];

      router.registerSelector('type:ToolCall', createTrackerPlugin(calls, 'tool'), 'test');
      router.connectTo(fm);

      fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }]);
      await tick();

      assert.strictEqual(calls.length, 0);
    });

    it('should return a cleanup function to disconnect', async () => {
      let router    = createRouter();
      let fm        = new FrameManager();
      let calls     = [];
      let disconnect = router.connectTo(fm);

      router.registerSelector('type:UserMessage', createTrackerPlugin(calls, 'matched'), 'test');

      disconnect();

      fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }]);
      await tick();

      assert.strictEqual(calls.length, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // Middleware chain
  // ---------------------------------------------------------------------------

  describe('middleware chain', () => {
    it('should execute multiple matching plugins in registration order', async () => {
      let router = createRouter();
      let fm     = new FrameManager();
      let calls  = [];

      router.registerSelector('type:UserMessage', createTrackerPlugin(calls, 'A'), 'pluginA');
      router.registerSelector('type:UserMessage', createTrackerPlugin(calls, 'B'), 'pluginB');
      router.registerSelector('type:UserMessage', createTrackerPlugin(calls, 'C'), 'pluginC');
      router.connectTo(fm);

      fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }]);
      await tick();

      assert.deepStrictEqual(calls, ['A', 'B', 'C']);
    });

    it('should stop chain when a plugin calls done()', async () => {
      let router = createRouter();
      let fm     = new FrameManager();
      let calls  = [];

      class StopPlugin extends BasePluginClass {
        async process(next, done) {
          calls.push('stop');
          return await done(this.context);
        }
      }

      router.registerSelector('type:UserMessage', createTrackerPlugin(calls, 'A'), 'pluginA');
      router.registerSelector('type:UserMessage', StopPlugin, 'stopper');
      router.registerSelector('type:UserMessage', createTrackerPlugin(calls, 'C'), 'pluginC');
      router.connectTo(fm);

      fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }]);
      await tick();

      assert.deepStrictEqual(calls, ['A', 'stop']);
    });

    it('should auto-call next() when plugin forgets to call next or done', async () => {
      let router = createRouter();
      let fm     = new FrameManager();
      let calls  = [];

      class ForgetPlugin extends BasePluginClass {
        async process(next, done) {
          calls.push('forget');
          // Intentionally not calling next() or done()
        }
      }

      router.registerSelector('type:UserMessage', ForgetPlugin, 'forgetful');
      router.registerSelector('type:UserMessage', createTrackerPlugin(calls, 'B'), 'pluginB');
      router.connectTo(fm);

      fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }]);
      await tick();

      assert.deepStrictEqual(calls, ['forget', 'B']);
    });

    it('should continue chain when a plugin throws', async () => {
      let router = createRouter();
      let fm     = new FrameManager();
      let calls  = [];

      class CrashPlugin extends BasePluginClass {
        async process(next, done) {
          calls.push('crash');
          throw new Error('plugin crashed');
        }
      }

      router.registerSelector('type:UserMessage', CrashPlugin, 'crasher');
      router.registerSelector('type:UserMessage', createTrackerPlugin(calls, 'B'), 'pluginB');
      router.connectTo(fm);

      fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }]);
      await tick();

      assert.deepStrictEqual(calls, ['crash', 'B']);
    });

    it('should continue chain when plugin constructor throws', async () => {
      let router = createRouter();
      let fm     = new FrameManager();
      let calls  = [];

      class BadConstructor extends BasePluginClass {
        constructor(context) {
          super(context);
          throw new Error('constructor failed');
        }
      }

      router.registerSelector('type:UserMessage', BadConstructor, 'bad');
      router.registerSelector('type:UserMessage', createTrackerPlugin(calls, 'B'), 'pluginB');
      router.connectTo(fm);

      fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }]);
      await tick();

      assert.deepStrictEqual(calls, ['B']);
    });
  });

  // ---------------------------------------------------------------------------
  // Context building
  // ---------------------------------------------------------------------------

  describe('context building', () => {
    it('should provide newFrame in context', async () => {
      let router   = createRouter();
      let fm       = new FrameManager();
      let captured = null;

      class CapPlugin extends BasePluginClass {
        async process(next, done) {
          captured = this.context;
          return await next(this.context);
        }
      }

      router.registerSelector('type:UserMessage', CapPlugin, 'cap');
      router.connectTo(fm);

      fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }]);
      await tick();

      assert.ok(captured);
      assert.strictEqual(captured.newFrame.id, 'f1');
      assert.strictEqual(captured.newFrame.type, 'UserMessage');
    });

    it('should provide null previousFrame for new frames', async () => {
      let router   = createRouter();
      let fm       = new FrameManager();
      let captured = null;

      class CapPlugin extends BasePluginClass {
        async process(next, done) {
          captured = this.context;
          return await next(this.context);
        }
      }

      router.registerSelector('type:UserMessage', CapPlugin, 'cap');
      router.connectTo(fm);

      fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }]);
      await tick();

      assert.strictEqual(captured.previousFrame, null);
    });

    it('should provide previousFrame and changes for updated frames', async () => {
      let router   = createRouter();
      let fm       = new FrameManager();
      let contexts = [];

      class CapPlugin extends BasePluginClass {
        async process(next, done) {
          contexts.push(this.context);
          return await next(this.context);
        }
      }

      router.registerSelector('type:UserMessage', CapPlugin, 'cap');

      // Create the frame first (silently so router doesn't fire)
      fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }], { silent: true });

      // Now connect and update it via a different source frame targeting f1
      router.connectTo(fm);

      fm.merge([{
        id:      'f1-patch',
        type:    'UserMessage',
        targets: ['f1'],
        content: { text: 'updated' },
      }]);

      await tick();

      // Should fire for both f1-patch (create) and f1 (update)
      let updateCtx = contexts.find((c) => c.newFrame.id === 'f1');
      assert.ok(updateCtx, 'should have routed the updated frame');
      assert.ok(updateCtx.previousFrame, 'should provide previousFrame for updates');
      assert.ok(updateCtx.changes.length > 0, 'should have property-level changes');
    });

    it('should provide commit in context', async () => {
      let router   = createRouter();
      let fm       = new FrameManager();
      let captured = null;

      class CapPlugin extends BasePluginClass {
        async process(next, done) {
          captured = this.context;
          return await next(this.context);
        }
      }

      router.registerSelector('type:UserMessage', CapPlugin, 'cap');
      router.connectTo(fm);

      fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }]);
      await tick();

      assert.ok(captured.commit);
      assert.ok(captured.commit.order);
    });

    it('should provide engine (frameManager) in context', async () => {
      let router   = createRouter();
      let fm       = new FrameManager();
      let captured = null;

      class CapPlugin extends BasePluginClass {
        async process(next, done) {
          captured = this.context;
          return await next(this.context);
        }
      }

      router.registerSelector('type:UserMessage', CapPlugin, 'cap');
      router.connectTo(fm);

      fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }]);
      await tick();

      assert.strictEqual(captured.engine, fm);
      assert.strictEqual(captured.frames, fm);
    });

    it('should provide session context when passed to connectTo', async () => {
      let router   = createRouter();
      let fm       = new FrameManager();
      let captured = null;

      class CapPlugin extends BasePluginClass {
        async process(next, done) {
          captured = this.context;
          return await next(this.context);
        }
      }

      let session = { id: 'session-1', participants: ['agent-a'] };
      router.registerSelector('type:UserMessage', CapPlugin, 'cap');
      router.connectTo(fm, session);

      fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }]);
      await tick();

      assert.strictEqual(captured.session, session);
    });

    it('should provide logger in context', async () => {
      let router   = createRouter();
      let fm       = new FrameManager();
      let captured = null;

      class CapPlugin extends BasePluginClass {
        async process(next, done) {
          captured = this.context;
          return await next(this.context);
        }
      }

      router.registerSelector('type:UserMessage', CapPlugin, 'cap');
      router.connectTo(fm);

      fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }]);
      await tick();

      assert.ok(captured.logger);
    });
  });

  // ---------------------------------------------------------------------------
  // Re-entrant safety
  // ---------------------------------------------------------------------------

  describe('re-entrant safety', () => {
    it('should handle plugins that create new frames (re-entrant commits)', async () => {
      let router = createRouter();
      let fm     = new FrameManager();
      let calls  = [];

      // Plugin that creates a new frame when it sees user-message
      class CreatorPlugin extends BasePluginClass {
        async process(next, done) {
          calls.push('creator');

          if (this.context.newFrame.type === 'UserMessage') {
            // This will trigger a new commit, queued for later
            fm.merge([{
              id:      'f-response',
              type:    'agent-response',
              content: { text: 'reply' },
            }]);
          }

          return await next(this.context);
        }
      }

      class ResponsePlugin extends BasePluginClass {
        async process(next, done) {
          calls.push('response-handler');
          return await next(this.context);
        }
      }

      router.registerSelector('type:UserMessage', CreatorPlugin, 'creator');
      router.registerSelector('type:agent-response', ResponsePlugin, 'responder');
      router.connectTo(fm);

      fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }]);
      await tick();

      // Creator fires for user-message, then response-handler fires for agent-response
      assert.ok(calls.includes('creator'));
      assert.ok(calls.includes('response-handler'));
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple frames per commit
  // ---------------------------------------------------------------------------

  describe('multiple frames per commit', () => {
    it('should route each frame in the commit independently', async () => {
      let router = createRouter();
      let fm     = new FrameManager();
      let calls  = [];

      class TypeTracker extends BasePluginClass {
        async process(next, done) {
          calls.push(this.context.newFrame.type);
          return await next(this.context);
        }
      }

      router.registerSelector('type:UserMessage', TypeTracker, 'tracker');
      router.registerSelector('type:ToolCall', TypeTracker, 'tracker');
      router.connectTo(fm);

      fm.merge([
        { id: 'f1', type: 'UserMessage', content: { text: 'hello' } },
        { id: 'f2', type: 'ToolCall', content: { toolName: 'test' } },
      ]);
      await tick();

      assert.strictEqual(calls.length, 2);
      assert.ok(calls.includes('UserMessage'));
      assert.ok(calls.includes('ToolCall'));
    });
  });

  // ---------------------------------------------------------------------------
  // Selector matching edge cases
  // ---------------------------------------------------------------------------

  describe('selector matching edge cases', () => {
    it('should survive a matcher function that throws', async () => {
      let router = createRouter();
      let fm     = new FrameManager();
      let calls  = [];

      router.registerSelector(() => { throw new Error('boom'); }, BasePluginClass, 'bad-matcher');
      router.registerSelector('type:UserMessage', createTrackerPlugin(calls, 'good'), 'good');
      router.connectTo(fm);

      fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }]);
      await tick();

      assert.deepStrictEqual(calls, ['good']);
    });

    it('should handle wildcard type:* matching all frames in a commit', async () => {
      let router = createRouter();
      let fm     = new FrameManager();
      let calls  = [];

      router.registerSelector('type:*', createTrackerPlugin(calls, 'any'), 'catch-all');
      router.connectTo(fm);

      fm.merge([
        { id: 'f1', type: 'UserMessage', content: {} },
        { id: 'f2', type: 'ToolCall', content: {} },
      ]);
      await tick();

      assert.strictEqual(calls.length, 2);
    });
  });

  // ---------------------------------------------------------------------------
  // Property diff computation
  // ---------------------------------------------------------------------------

  describe('property diff computation', () => {
    it('should produce empty changes array for new frames', async () => {
      let router   = createRouter();
      let fm       = new FrameManager();
      let captured = null;

      class CapPlugin extends BasePluginClass {
        async process(next, done) {
          captured = this.context;
          return await next(this.context);
        }
      }

      router.registerSelector('type:UserMessage', CapPlugin, 'cap');
      router.connectTo(fm);

      fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }]);
      await tick();

      assert.ok(captured);
      assert.deepStrictEqual(captured.changes, []);
    });
  });

  // ---------------------------------------------------------------------------
  // Fresh instances per routing cycle
  // ---------------------------------------------------------------------------

  describe('fresh instances per routing cycle', () => {
    it('should create a new plugin instance for each routing cycle', async () => {
      let router    = createRouter();
      let fm        = new FrameManager();
      let instances = [];

      class TrackInstances extends BasePluginClass {
        async process(next, done) {
          instances.push(this);
          return await next(this.context);
        }
      }

      router.registerSelector('type:UserMessage', TrackInstances, 'tracker');
      router.connectTo(fm);

      fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'first' } }]);
      await tick();

      fm.merge([{ id: 'f2', type: 'UserMessage', content: { text: 'second' } }]);
      await tick();

      assert.strictEqual(instances.length, 2);
      assert.notStrictEqual(instances[0], instances[1]);
    });
  });

  // ---------------------------------------------------------------------------
  // No registrations
  // ---------------------------------------------------------------------------

  describe('no registrations', () => {
    it('should handle commits gracefully when no selectors are registered', async () => {
      let router = createRouter();
      let fm     = new FrameManager();

      router.connectTo(fm);

      // Should not throw
      fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }]);
      await tick();
    });
  });
});
