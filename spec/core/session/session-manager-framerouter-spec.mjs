'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }   from '../../../src/core/index.mjs';
import { SessionManager }   from '../../../src/core/session/index.mjs';
import { FrameRouter }      from '../../../src/core/routing/frame-router.mjs';

// =============================================================================
// Phase C2 — SessionManager ↔ FrameRouter Auto-Connection
// =============================================================================

describe('SessionManager FrameRouter auto-connection (C2)', () => {
  let core;
  let context;

  before(async () => {
    core = createKikxCore();
    await core.start();
    context = core.getContext();
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  it('should auto-connect FrameRouter to new FrameManagers', () => {
    let router = new FrameRouter({ logger: console });
    let connectCalls = 0;
    let originalConnectTo = router.connectTo.bind(router);
    router.connectTo = (fm, ctx) => {
      connectCalls++;
      return originalConnectTo(fm, ctx);
    };

    context.setProperty('frameRouter', router);

    let sessionManager = new SessionManager(context);
    let frameManager   = sessionManager.getFrameManager('ses_auto_1');

    assert.ok(frameManager);
    assert.equal(connectCalls, 1);

    // Clean up
    context.setProperty('frameRouter', null);
  });

  it('should NOT connect when no FrameRouter on context', () => {
    context.setProperty('frameRouter', null);

    let sessionManager = new SessionManager(context);
    let frameManager   = sessionManager.getFrameManager('ses_no_router');

    assert.ok(frameManager);
    // No error thrown — gracefully skipped
  });

  it('should reuse cached FrameManager without reconnecting', () => {
    let router = new FrameRouter({ logger: console });
    let connectCalls = 0;
    let originalConnectTo = router.connectTo.bind(router);
    router.connectTo = (fm, ctx) => {
      connectCalls++;
      return originalConnectTo(fm, ctx);
    };

    context.setProperty('frameRouter', router);

    let sessionManager = new SessionManager(context);

    let fm1 = sessionManager.getFrameManager('ses_cache_1');
    let fm2 = sessionManager.getFrameManager('ses_cache_1');

    assert.strictEqual(fm1, fm2);
    // Only connected once (second call returns cached)
    assert.equal(connectCalls, 1);

    context.setProperty('frameRouter', null);
  });

  it('should route commits from auto-connected FrameManagers', async () => {
    let router = new FrameRouter({ logger: console });

    // Register a simple selector
    let processed = [];
    let { BasePluginClass } = await import('../../../src/core/routing/base-plugin-class.mjs');

    class TestPlugin extends BasePluginClass {
      async process(next, done) {
        processed.push(this.context);
        return await next(this.context);
      }
    }

    router.registerSelector('type:user-message', TestPlugin);
    context.setProperty('frameRouter', router);

    let sessionManager = new SessionManager(context);
    let frameManager   = sessionManager.getFrameManager('ses_route_test');

    // Create a user-message frame
    frameManager.merge([{
      id:         'frm_route_1',
      type:       'user-message',
      content:    { text: 'Test routing' },
      authorType: 'user',
      authorID:   'usr_1',
    }], { authorType: 'user', authorID: 'usr_1' });

    // Give async routing time to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(processed.length, 1);
    assert.equal(processed[0].session.id, 'ses_route_test');

    context.setProperty('frameRouter', null);
  });
});
