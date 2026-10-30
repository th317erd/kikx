'use strict';

// Regression guard for the "agent looks idle while it is thinking" defect.
//
// The pinned thinking rack was repainted from two places, both requiring a
// visible thread frame: afterRender() (a render happened) and
// syncFrameThreadBody() (a frame landed in the thread). Thinking frames are
// deliberately NOT thread frames, so a batch carrying only BeginTyping /
// AgentThinking / AgentMessageDelta reached neither path: the buffer advanced,
// the rack was never told, and the panel stayed dead.
//
// This drives the real production flush and asserts the rack is repainted. A
// guard on the pure buffer helpers would pass with and without the fix, so it
// would guard nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

// Imported after the DOM and vendor shims are in place: the event layer now
// reaches the rack repaint, which pulls in the shell builders and therefore the
// `/vendor/aeor-web-components/*` imports the loader above resolves.
const { queueFrameRuntimeEvent, flushFrameRuntimeEvents } =
  await import('../../src/client/components/kikx-runtime-events.mjs');
const { createThinkingBuffer } = await import('../../src/client/state/thinking-state.mjs');

const SESSION_ID = 'session_1';

function buildApp(rack) {
  // kikx-app installs this bound flush callback; the flush scheduler reads it off
  // the app instance, so a stub without it throws inside setTimeout.
  let app = {
    _state: { selectedSessionID: SESSION_ID, frameFilters: {} },
    _thinking: createThinkingBuffer(),
    _pendingFrameRuntimeEvents: [],
    _syncFrameThread() {},
    _schedulePreviewRefresh() {},
    _requestRender() {},
    querySelector(selector) {
      return selector === 'kikx-thinking-rack' ? rack : null;
    },
  };
  app._flushFrameRuntimeEvents = () => flushFrameRuntimeEvents(app);
  return app;
}

function buildRack() {
  let rack = {
    calls: [],
    update(agents) { rack.calls.push(agents); },
  };
  return rack;
}

function beginTyping(content = { agentID: 'agent_1', agentName: 'Zav' }, sessionID = SESSION_ID) {
  return {
    type: 'frame.phantom',
    sessionID,
    frame: {
      id: 'resp_1:BeginTyping',
      type: 'BeginTyping',
      phantom: true,
      responseFrameID: 'resp_1',
      content,
    },
  };
}

test('a thinking-only frame repaints the rack even though it never enters the thread', () => {
  let rack = buildRack();
  let app = buildApp(rack);

  queueFrameRuntimeEvent(app, beginTyping());
  flushFrameRuntimeEvents(app);

  assert.equal(
    rack.calls.length,
    1,
    'the rack must be repainted for a thinking-only batch; without this the buffer advances and the panel stays dead',
  );
  assert.equal(rack.calls[0].length, 1, 'the repaint carries the thinking agent');
  assert.equal(rack.calls[0][0].id, 'agent_1', 'the panel is keyed by the agent id');
  assert.equal(rack.calls[0][0].name, 'Zav', 'the panel is named after the agent');
});

test('the rack repaint does not depend on the visible thread sync', () => {
  let rack = buildRack();
  let app = buildApp(rack);
  let threadSyncs = 0;

  app._syncFrameThread = () => { threadSyncs += 1; };

  queueFrameRuntimeEvent(app, beginTyping());
  flushFrameRuntimeEvents(app);

  assert.equal(rack.calls.length, 1, 'the rack is repainted');
  assert.equal(threadSyncs, 0, 'a thinking-only batch correctly skips the visible thread sync');
});

test('another session thinking does not put a foreign agent in this rack', () => {
  let rack = buildRack();
  let app = buildApp(rack);

  queueFrameRuntimeEvent(app, beginTyping({ agentID: 'agent_1', agentName: 'Zav' }, 'session_2'));
  flushFrameRuntimeEvents(app);

  assert.equal(rack.calls.length, 1, 'a repaint still occurs for a changed buffer');
  assert.equal(rack.calls[0].length, 0, "the selected session's rack lists no foreign agent");
});

test('an event that leaves the buffer unchanged does not repaint the rack', () => {
  let rack = buildRack();
  let app = buildApp(rack);

  queueFrameRuntimeEvent(app, {
    type: 'frame.phantom',
    sessionID: SESSION_ID,
    frame: { id: 'unrelated', type: 'AgentMessage', phantom: true, content: { status: 'complete' } },
  });
  flushFrameRuntimeEvents(app);

  assert.equal(rack.calls.length, 0, 'no buffer change means no rack repaint');
});
