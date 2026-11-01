'use strict';

// =============================================================================
// Agent-only frames — a plugin-owned frame type that is hidden from the thread
// but still delivered to the agent
// =============================================================================
// The owner's requirement: a transport (Discord) should write a frame of its own
// type, that frame must NOT appear in the session thread, and the bot must still
// receive it. Three existing mechanisms each fail on their own:
//
//   hidden: true        — removes it from the thread, but `frame-type-base`
//                         nulls `toAgentMessage()` and `targeting.mjs` refuses to
//                         route it, so the bot goes deaf.
//   MessageDone-style   — never rendered, but also never routed or projected.
//   type: 'UserMessage' — routes and projects, but renders as the owner speaking.
//
// So the type class declares `agentOnly` and the write path stamps it on the
// record. Every gate then reads one persisted boolean instead of inferring
// intent, which also means a frame written by a plugin cannot lie about it: the
// flag is copied from the registered class, never taken from the caller.
// =============================================================================

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameTypeBase, FrameTypeUserMessage } from '../../../src/core/frames/frame-types/index.mjs';
import { isThreadVisibleFrame } from '../../../src/shared/coordination-visibility.mjs';
import {
  frameMatchesWindowFilters,
  defaultFrameWindowFilters,
} from '../../../src/shared/frame-window-filters.mjs';

class FrameTypeAgentOnlyProbe extends FrameTypeUserMessage {
  static agentOnly = true;
}

test('a frame type declares agentOnly; the base class does not', () => {
  let declared = new FrameTypeAgentOnlyProbe({ id: 'f', type: 'Probe', content: { text: 'hi' } });
  let plain = new FrameTypeUserMessage({ id: 'g', type: 'UserMessage', content: { text: 'hi' } });

  assert.equal(declared.agentOnly, true);
  assert.equal(plain.agentOnly, false);
  // The declaration is the only thing that differs: an agent-only frame is still
  // a normal user turn as far as the model is concerned.
  assert.deepEqual(declared.toAgentMessage(), { role: 'user', content: 'hi' });
});

test('the base class defaults agentOnly to false', () => {
  let base = new FrameTypeBase({ id: 'b', type: 'Unknown', content: { text: 'x' } });
  assert.equal(base.agentOnly, false);
});

test('an agent-only frame is never visible in the thread, gate or no gate', () => {
  let frame = { id: 'f1', type: 'Probe', agentOnly: true, hidden: false, content: { text: 'hi' } };

  assert.equal(isThreadVisibleFrame(frame), false);

  // The Hidden gate reveals hidden and soft-deleted frames. It must NOT reveal a
  // frame whose whole purpose is to stay out of the thread, or the second half of
  // the owner's request ("I don't want it shown in the Session") is defeated by
  // turning on a filter he uses for something else entirely.
  let filters = { ...defaultFrameWindowFilters(), deleted: true };
  assert.equal(frameMatchesWindowFilters(frame, filters), false);
});

test('an ordinary frame is unaffected by the agent-only gate', () => {
  let frame = { id: 'f2', type: 'UserMessage', authorType: 'user', hidden: false, content: { text: 'hi' } };
  assert.equal(isThreadVisibleFrame(frame), true);
  assert.equal(frameMatchesWindowFilters(frame, defaultFrameWindowFilters()), true);
});
