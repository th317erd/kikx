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

function createRouter(options = {}) {
  return new FrameRouter({ logger: silentLogger(), ...options });
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

// Mock FramePersistence — tracks updateFrameState calls
function createMockPersistence() {
  let calls = [];
  return {
    calls,
    async updateFrameState(frameID, state) {
      calls.push({ frameID, state });
    },
  };
}

// =============================================================================
// FrameRouter — Plugin State Integration
// =============================================================================

describe('FrameRouter — plugin state integration', () => {

  // ---------------------------------------------------------------------------
  // Happy paths
  // ---------------------------------------------------------------------------

  it('should provide this.state hydrated from frame before process()', async () => {
    let router = createRouter();
    let fm     = new FrameManager();
    let captured = null;

    class StateReader extends BasePluginClass {
      async process(next, done) {
        captured = { ...this.state };
        return await next(this.context);
      }
    }

    router.registerSelector('type:UserMessage', StateReader, 'reader');
    router.connectTo(fm);

    // Merge a frame with pre-existing state
    fm.merge([{
      id:      'f1',
      type:    'UserMessage',
      content: { text: 'hello' },
      state:   JSON.stringify({ step: 'ready', count: 5 }),
    }]);
    await tick();

    assert.ok(captured);
    assert.strictEqual(captured.step, 'ready');
    assert.strictEqual(captured.count, 5);
  });

  it('should persist state changes after process() completes', async () => {
    let router     = createRouter();
    let fm         = new FrameManager();
    let persistence = createMockPersistence();

    class StateWriter extends BasePluginClass {
      async process(next, done) {
        this.state.step = 'processed';
        this.state.result = 42;
        return await next(this.context);
      }
    }

    router.registerSelector('type:UserMessage', StateWriter, 'writer');
    router.connectTo(fm, null, { framePersistence: persistence });

    fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }]);
    await tick();

    // State should have been persisted
    assert.strictEqual(persistence.calls.length, 1);
    assert.strictEqual(persistence.calls[0].frameID, 'f1');
    assert.deepStrictEqual(persistence.calls[0].state, { step: 'processed', result: 42 });
  });

  it('should NOT persist state if not dirty (read-only access)', async () => {
    let router      = createRouter();
    let fm          = new FrameManager();
    let persistence = createMockPersistence();

    class ReadOnly extends BasePluginClass {
      async process(next, done) {
        let _step = this.state.step; // read-only
        return await next(this.context);
      }
    }

    router.registerSelector('type:UserMessage', ReadOnly, 'reader');
    router.connectTo(fm, null, { framePersistence: persistence });

    fm.merge([{
      id:      'f1',
      type:    'UserMessage',
      content: { text: 'hello' },
      state:   JSON.stringify({ step: 'ready' }),
    }]);
    await tick();

    assert.strictEqual(persistence.calls.length, 0);
  });

  it('should persist state between routing cycles (round-trip)', async () => {
    let router      = createRouter();
    let fm          = new FrameManager();
    let persistence = createMockPersistence();
    let captured    = [];

    class RoundTrip extends BasePluginClass {
      async process(next, done) {
        captured.push({ ...this.state });
        if (!this.state.visits)
          this.state.visits = 0;
        this.state.visits++;
        return await next(this.context);
      }
    }

    router.registerSelector('type:UserMessage', RoundTrip, 'roundtrip');
    router.connectTo(fm, null, { framePersistence: persistence });

    // First routing cycle
    fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }]);
    await tick();

    assert.deepStrictEqual(captured[0], {}); // starts empty
    assert.strictEqual(persistence.calls.length, 1);
    assert.deepStrictEqual(persistence.calls[0].state, { visits: 1 });

    // Simulate the frame now having the persisted state (as if loaded from DB)
    // Update the frame with the state that was persisted
    fm.merge([{
      id:      'f1',
      type:    'UserMessage',
      content: { text: 'hello again' },
      state:   JSON.stringify({ visits: 1 }),
    }]);
    await tick();

    assert.deepStrictEqual(captured[1], { visits: 1 }); // hydrated from previous cycle
    assert.strictEqual(persistence.calls.length, 2);
    assert.deepStrictEqual(persistence.calls[1].state, { visits: 2 });
  });

  // ---------------------------------------------------------------------------
  // Sad paths
  // ---------------------------------------------------------------------------

  it('should provide empty state when frame has no state field', async () => {
    let router   = createRouter();
    let fm       = new FrameManager();
    let captured = null;

    class StateReader extends BasePluginClass {
      async process(next, done) {
        captured = { ...this.state };
        return await next(this.context);
      }
    }

    router.registerSelector('type:UserMessage', StateReader, 'reader');
    router.connectTo(fm);

    fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }]);
    await tick();

    assert.ok(captured);
    assert.deepStrictEqual(captured, {});
  });

  it('should NOT persist state when plugin throws during process()', async () => {
    let router      = createRouter();
    let fm          = new FrameManager();
    let persistence = createMockPersistence();

    class CrashPlugin extends BasePluginClass {
      async process(next, done) {
        this.state.step = 'should-not-persist';
        throw new Error('plugin crashed');
      }
    }

    router.registerSelector('type:UserMessage', CrashPlugin, 'crasher');
    router.connectTo(fm, null, { framePersistence: persistence });

    fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }]);
    await tick();

    // State should NOT be persisted on error
    assert.strictEqual(persistence.calls.length, 0);
  });

  it('should not crash when FramePersistence is not available', async () => {
    let router = createRouter();
    let fm     = new FrameManager();

    class StateWriter extends BasePluginClass {
      async process(next, done) {
        this.state.step = 'written';
        return await next(this.context);
      }
    }

    router.registerSelector('type:UserMessage', StateWriter, 'writer');
    router.connectTo(fm); // no persistence passed

    // Should not throw
    fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }]);
    await tick();

    // Frame should still have state updated in memory
    let frame = fm.getHead('f1');
    let state = (typeof frame.state === 'string') ? JSON.parse(frame.state) : frame.state;
    assert.deepStrictEqual(state, { step: 'written' });
  });

  it('should provide empty state when frame has corrupted state JSON', async () => {
    let router   = createRouter();
    let fm       = new FrameManager();
    let captured = null;

    class StateReader extends BasePluginClass {
      async process(next, done) {
        captured = { ...this.state };
        return await next(this.context);
      }
    }

    router.registerSelector('type:UserMessage', StateReader, 'reader');
    router.connectTo(fm);

    fm.merge([{
      id:      'f1',
      type:    'UserMessage',
      content: { text: 'hello' },
      state:   '{corrupted-json!!!',
    }]);
    await tick();

    assert.ok(captured);
    assert.deepStrictEqual(captured, {});
  });

  // ---------------------------------------------------------------------------
  // Each plugin in chain gets its own fresh state proxy
  // ---------------------------------------------------------------------------

  it('should give each plugin in the chain a fresh state proxy backed by same raw state', async () => {
    let router      = createRouter();
    let fm          = new FrameManager();
    let persistence = createMockPersistence();
    let statesA     = [];
    let statesB     = [];

    class PluginA extends BasePluginClass {
      async process(next, done) {
        this.state.a = 'from-A';
        statesA.push({ ...this.state });
        return await next(this.context);
      }
    }

    class PluginB extends BasePluginClass {
      async process(next, done) {
        statesB.push({ ...this.state });
        this.state.b = 'from-B';
        return await next(this.context);
      }
    }

    router.registerSelector('type:UserMessage', PluginA, 'A');
    router.registerSelector('type:UserMessage', PluginB, 'B');
    router.connectTo(fm, null, { framePersistence: persistence });

    fm.merge([{ id: 'f1', type: 'UserMessage', content: { text: 'hello' } }]);
    await tick();

    // PluginA sets a='from-A'
    assert.strictEqual(statesA[0].a, 'from-A');

    // PluginB should see PluginA's state changes (same backing object)
    assert.strictEqual(statesB[0].a, 'from-A');

    // Final persisted state should include both
    assert.strictEqual(persistence.calls.length, 1);
    assert.deepStrictEqual(persistence.calls[0].state, { a: 'from-A', b: 'from-B' });
  });

  // ---------------------------------------------------------------------------
  // BasePluginClass.state getter fallback
  // ---------------------------------------------------------------------------

  it('should return empty object from this.state when _state is not set', () => {
    let plugin = new BasePluginClass({});
    let state = plugin.state;
    assert.deepStrictEqual(state, {});
  });
});
