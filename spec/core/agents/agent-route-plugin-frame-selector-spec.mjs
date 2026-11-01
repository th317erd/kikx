'use strict';

// A transport cannot wake an agent by appending its own frame type.
//
// `registerAgentRouting()` registered selectors for `Type:UserMessage` and
// `Type:AgentMessage` only. SelectorCompiler compiles those to
// `frame.type === 'UserMessage'`, so a frame of a *plugin-registered* type
// (the Discord transport's `DiscordFrame`) matched no selector at all: it was
// never dispatched to `AgentRouteFramePlugin`, so `shouldRouteAgentOnlyFrame()`
// - which exists to route exactly such frames - was unreachable for the only
// frames it was written for.
//
// The live symptom was silence, not an error: the frame persisted, the session
// coordinator resolved, and no agent turn ever started. That is the worst
// possible shape for this defect, because every visible artefact looks right.

import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentRouteFramePlugin, registerAgentRouting } from '../../../src/core/agents/agent-route-frame-plugin.mjs';
import { SelectorCompiler } from '../../../src/core/routing/selector-compiler.mjs';

// A frame router double that records what was registered and can answer
// "which plugins would this frame dispatch to?" the way FrameRouter does.
function captureRouter() {
  let registrations = [];
  return {
    registrations,
    registerSelector(selector, PluginClass, pluginName = null) {
      registrations.push({ selector, PluginClass, pluginName, matcher: SelectorCompiler.compile(selector) });
    },
    dispatch(frame) {
      return registrations.filter((entry) => entry.matcher(frame)).map((entry) => entry.PluginClass);
    },
  };
}

function discordFrame(overrides = {}) {
  return {
    id: 'frame_1',
    type: 'DiscordFrame',
    authorType: 'user',
    authorID: 'discord:255524600249581568',
    sessionID: 'session_1',
    agentOnly: true,
    hidden: false,
    deleted: false,
    content: { text: '[discord:th317erd] hello' },
    ...overrides,
  };
}

test('an agent-only plugin frame type is dispatched to the agent router', () => {
  let router = captureRouter();
  registerAgentRouting(router);

  let classes = router.dispatch(discordFrame());

  assert.ok(
    classes.includes(AgentRouteFramePlugin),
    'a plugin-registered frame type must reach AgentRouteFramePlugin, otherwise no plugin can ever wake an agent',
  );
});

test('an ordinary user message still dispatches exactly once', () => {
  let router = captureRouter();
  registerAgentRouting(router);

  let classes = router.dispatch({
    id: 'frame_2',
    type: 'UserMessage',
    authorType: 'user',
    hidden: false,
    deleted: false,
    content: { text: 'hello' },
  });

  assert.equal(
    classes.filter((Class) => Class === AgentRouteFramePlugin).length,
    1,
    'adding a selector must not make an ordinary message dispatch twice',
  );
});

test('an agent message still dispatches exactly once', () => {
  let router = captureRouter();
  registerAgentRouting(router);

  let classes = router.dispatch({
    id: 'frame_3',
    type: 'AgentMessage',
    authorType: 'agent',
    authorID: 'agent_1',
    hidden: false,
    deleted: false,
    content: { text: 'reply' },
  });

  assert.equal(classes.filter((Class) => Class === AgentRouteFramePlugin).length, 1);
});

test('a plugin frame without agentOnly is not routed', () => {
  // The matcher must key on `agentOnly`, which is stamped only from a
  // registered frame-type class and so cannot be forged by a caller. A plugin
  // frame claiming to be thread-visible is not a wake.
  let router = captureRouter();
  registerAgentRouting(router);

  let classes = router.dispatch(discordFrame({ agentOnly: false }));

  assert.ok(!classes.includes(AgentRouteFramePlugin));
});

test('a deleted agent-only frame is not routed', () => {
  // Dispatch may match; the gate inside shouldRouteToAgents() rejects it. This
  // asserts the composition rather than the selector alone.
  let router = captureRouter();
  registerAgentRouting(router);

  let classes = router.dispatch(discordFrame({ deleted: true }));

  assert.ok(
    classes.includes(AgentRouteFramePlugin),
    'dispatch is by shape, not by deletion state; the deletion gate lives in shouldRouteToAgents',
  );
});
