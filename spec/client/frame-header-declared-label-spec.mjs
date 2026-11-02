'use strict';

// A plugin-declared frame label must reach the frame header.
//
// The gap this pins, measured on live 3098: a Discord plugin registered its frame
// TYPE (so inbound messages were typed, agentOnly and attributed) and then added a
// renderer for it -- but the collapsed header still named the frame after its raw
// type. `frameHeaderStatus()` returned a label only for AgentMessage /
// AgentMessageDelta / AgentProgress / UserMessage, and `null` for everything else,
// including the built-in summary path that already knows how to turn a type name
// into a description.
//
// The descriptor fields had always been honoured for `sidebar-item`,
// `settings-panel` and `topbar` surfaces (kikx-settings-panel.mjs:56,
// kikx-topbar.mjs:398, kikx-sidebar-session-objects.mjs:144) and never for
// `frame`, so a plugin could ship a working card and still be unlabelled.
//
// Two directions matter, and the second is the one that would be a regression:
//   - a declared label IS used for a plugin frame type;
//   - a declared label is NEVER used for the built-ins, where the mood word is
//     different information and a plugin must not be able to relabel the owner's
//     own turn or an agent's reply.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

// The helpers module imports the client element library, which touches
// HTMLElement at import time. These two stubs are enough; no DOM is required for
// the pure header logic under test.
globalThis.HTMLElement ??= class {};
globalThis.customElements ??= { get: () => null, define: () => {} };

const { frameHeaderStatus } = await import('../../src/client/components/kikx-frame-item-helpers.mjs');

function stateWith(descriptors) {
  return { clientFrameComponentsByType: descriptors };
}

test('a plugin-declared label and icon are used for its frame type', () => {
  let frame = { type: 'DiscordFrame', content: {} };
  let state = stateWith({
    DiscordFrame: { kind: 'frame', frameType: 'DiscordFrame', label: 'Discord Message', icon: 'chat' },
  });

  assert.deepEqual(frameHeaderStatus(frame, false, state), { label: 'Discord Message', icon: 'chat' });
});

test('without a declared label the frame is not relabelled with a guess', () => {
  let frame = { type: 'DiscordFrame', content: {} };

  // No descriptor at all: the previous behaviour, which the built-in summary path
  // still falls back on.
  assert.equal(frameHeaderStatus(frame, false, stateWith({})), null);

  // A descriptor with a blank label must not produce an empty chip either.
  assert.equal(
    frameHeaderStatus(frame, false, stateWith({ DiscordFrame: { kind: 'frame', label: '   ' } })),
    null,
  );
});

test('a missing icon falls back instead of leaving the chip iconless', () => {
  let frame = { type: 'DiscordFrame', content: {} };
  let state = stateWith({ DiscordFrame: { kind: 'frame', label: 'Discord Message' } });

  assert.deepEqual(frameHeaderStatus(frame, false, state), { label: 'Discord Message', icon: 'diamond' });
});

test('a plugin cannot relabel the owner turn or an agent reply', () => {
  // Negative control for the change above: the built-in branches are checked
  // BEFORE the descriptor lookup, so a colliding plugin descriptor is ignored.
  let hostile = stateWith({
    UserMessage: { kind: 'frame', label: 'Not You', icon: 'warning' },
    AgentMessage: { kind: 'frame', label: 'Not An Agent', icon: 'warning' },
  });

  assert.deepEqual(
    frameHeaderStatus({ type: 'UserMessage', content: {} }, false, hostile),
    { label: 'Message', icon: 'chat' },
  );

  assert.deepEqual(
    frameHeaderStatus({ type: 'AgentMessage', content: {} }, false, hostile),
    { label: 'Message', icon: 'chat' },
  );

  // ...and the mood word still wins where it exists.
  assert.deepEqual(
    frameHeaderStatus({ type: 'AgentMessage', content: { moodWord: 'Elated' } }, false, hostile),
    { label: 'Elated', icon: 'chat' },
  );
});

test('a plugin-declared label is used in compact mode too', () => {
  // The gap this pins: compact mode diverted to compactFrameHeader(frame) BEFORE
  // consulting the descriptor, so a collapsed plugin frame fell through to
  // humanizeToolName and read 'Discord Frame' -- the exact raw-type-name outcome
  // the descriptor path exists to prevent. A label that only works uncollapsed is
  // half a label.
  let frame = { type: 'DiscordFrame', content: {} };
  let state = stateWith({
    DiscordFrame: { kind: 'frame', frameType: 'DiscordFrame', label: 'Discord Message', icon: 'chat' },
  });

  assert.deepEqual(frameHeaderStatus(frame, true, state), { label: 'Discord Message', icon: 'chat' });
});

test('compact mode still refuses to relabel the built-ins', () => {
  // Negative control for the change above: consulting the descriptor earlier must
  // not hand a plugin a way into the owner turn, an agent reply, or a tool frame.
  let hostile = stateWith({
    UserMessage: { kind: 'frame', label: 'Not You' },
    AgentMessage: { kind: 'frame', label: 'Not An Agent' },
    DiscordSendToolFrame: { kind: 'frame', label: 'Not A Tool' },
  });

  assert.deepEqual(
    frameHeaderStatus({ type: 'AgentMessage', content: {} }, true, hostile),
    { label: 'Message', icon: 'chat' },
  );
  // Compact mode has always rendered an AgentMessage as plain 'Message' and
  // dropped the mood word -- pre-existing behaviour, deliberately NOT changed
  // here. The point of this assertion is only that the hostile descriptor does
  // not get in; the mood-word-in-compact question is a separate, open one.
  assert.deepEqual(
    frameHeaderStatus({ type: 'AgentMessage', content: { moodWord: 'Elated' } }, true, hostile),
    { label: 'Message', icon: 'chat' },
  );

  // A tool frame keeps its own compact wording rather than taking a plugin
  // label. Asserted as a property ('not the hostile label') rather than an exact
  // string, so this spec does not pin wording that is not its business.
  let toolFrame = { type: 'DiscordSendToolFrame', content: { toolName: 'discord:send' } };
  let toolHeader = frameHeaderStatus(toolFrame, true, hostile);
  assert.ok(toolHeader, 'a tool frame must still get a header');
  assert.notEqual(toolHeader.label, 'Not A Tool');
  assert.match(toolHeader.label, /discord/i);
});

test('a plugin frame with no declared label still gets the built-in summary', () => {
  // No regression for plugin frames that ship a renderer but no label: the
  // compact path must still produce its own description rather than nothing.
  let frame = { type: 'DiscordFrame', content: {} };
  let compact = frameHeaderStatus(frame, true, stateWith({}));
  assert.ok(compact && typeof compact.label === 'string' && compact.label !== '');
});
