'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

// The client component reaches browser-only modules through /vendor/... imports
// in aeor-ui.mjs. Redirect those to local stand-ins before loading it.
register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document, registry: customElements } = installDom();

// Pre-empt the real session card (a heavy preview renderer) so the sub-session
// frame can mount against a recording stub.
class StubSessionCard extends HTMLElement {
  constructor() {
    super();
    this.updates = [];
  }

  update(values) {
    this.updates.push(values);
  }
}
customElements.define('kikx-session-card', StubSessionCard);

// A recording custom frame component so the item's reuse path is observable.
class RecordingFrame extends HTMLElement {
  constructor() {
    super();
    this.frames = [];
    this.appStates = [];
  }

  updateFrame(frame, appState) {
    this.frames.push(frame);
    this.appStates.push(appState);
  }
}
customElements.define('kikx-recording-frame', RecordingFrame);

await import('../../src/client/components/kikx-frame-item.mjs');

function frameItem() {
  return document.createElement('kikx-frame-item');
}

function typingFrame(overrides = {}) {
  return {
    id: 'frame-typing',
    type: 'BeginTyping',
    authorID: 'agent-1',
    content: { agentName: 'Agent One', thinkingText: 'first thought' },
    ...overrides,
  };
}

function thinkingFrame(overrides = {}) {
  return {
    id: 'frame-thinking',
    type: 'AgentThinking',
    content: { text: 'thinking one' },
    ...overrides,
  };
}

test('BeginTyping keeps the same typing-indicator element across frame objects', () => {
  let item = frameItem();
  let state = {};

  item.updateFrame(typingFrame(), state);
  let first = item.querySelector('kikx-typing-indicator');
  assert.ok(first, 'the first render must create a typing indicator');

  item.updateFrame(typingFrame({
    content: { agentName: 'Agent Two', thinkingText: 'second thought' },
  }), state);

  let second = item.querySelector('kikx-typing-indicator');
  assert.equal(second, first, 'a new frame object for the same logical frame must not rebuild the indicator');
  assert.equal(second.agentName, 'Agent Two', 'the indicator must reflect the newest agent name');
  assert.equal(second.thinkingText, 'second thought', 'the indicator must reflect the newest thinking text');
});

test('an unchanged typing indicator value does not rewrite its text nodes', () => {
  let item = frameItem();
  let state = {};

  item.updateFrame(typingFrame(), state);
  let indicator = item.querySelector('kikx-typing-indicator');
  let thinkingSpan = indicator.querySelector('.kikx-typing-indicator__thinking span');
  let nameSpan = indicator.querySelector('.kikx-typing-indicator__name');
  let dotSpan = indicator.querySelector('.kikx-typing-indicator__dots span');
  let thinkingTextNode = thinkingSpan.firstChild;
  let nameTextNode = nameSpan.firstChild;
  let dotTextNode = dotSpan.firstChild;

  item.updateFrame(typingFrame(), state);

  let second = item.querySelector('kikx-typing-indicator');
  assert.equal(second, indicator, 'the indicator must be reused before its text can be compared');
  assert.equal(second.querySelector('.kikx-typing-indicator__thinking span'), thinkingSpan);
  assert.equal(thinkingSpan.firstChild, thinkingTextNode, 'unchanged marquee text must not be rewritten');
  assert.equal(nameSpan.firstChild, nameTextNode, 'unchanged agent name must not be rewritten');
  assert.equal(dotSpan.firstChild, dotTextNode, 'the animated dots must never be touched');
});

test('AgentThinking keeps its content element while the text updates', () => {
  let item = frameItem();
  let state = {};

  item.updateFrame(thinkingFrame(), state);
  let first = item.querySelector('.kikx-frame__thinking');
  assert.ok(first, 'the first render must create the thinking content element');

  item.updateFrame(thinkingFrame({ content: { text: 'thinking two' } }), state);

  let second = item.querySelector('.kikx-frame__thinking');
  assert.equal(second, first, 'the content element must be reconciled in place');
  assert.equal(second.textContent, 'thinking two', 'the reconciled element must show the newest text');
});

test('AgentMessageDelta keeps its stream container while the delta updates', () => {
  let item = frameItem();
  let state = {};

  item.updateFrame({ id: 'frame-delta', type: 'AgentMessageDelta', content: { text: 'Hel' } }, state);
  let first = item.querySelector('.kikx-frame__content.kikx-frame__stream');
  assert.ok(first, 'the first render must create the stream container');

  item.updateFrame({ id: 'frame-delta', type: 'AgentMessageDelta', content: { text: 'Hello' } }, state);
  let second = item.querySelector('.kikx-frame__content.kikx-frame__stream');
  assert.equal(second, first, 'the stream container must be reconciled in place');
  assert.equal(second.textContent, 'Hello');
});

test('changing the frame id rebuilds the item instead of reusing the subtree', () => {
  let item = frameItem();
  let state = {};

  item.updateFrame(thinkingFrame(), state);
  let first = item.querySelector('.kikx-frame__thinking');

  item.updateFrame(thinkingFrame({ id: 'frame-thinking-moved' }), state);
  let second = item.querySelector('.kikx-frame__thinking');

  assert.ok(second);
  assert.notEqual(second, first, 'a different frame id is a different logical frame and must rebuild');
});

test('changing the frame type rebuilds the item', () => {
  let item = frameItem();
  let state = {};

  item.updateFrame(typingFrame(), state);
  assert.ok(item.querySelector('kikx-typing-indicator'));

  item.updateFrame(thinkingFrame({ id: 'frame-typing' }), state);

  assert.equal(item.querySelector('kikx-typing-indicator'), null, 'the old indicator must be discarded');
  assert.ok(item.querySelector('.kikx-frame__thinking'), 'the new frame type must render');
});

test('a new app-state object identity still forces a rebuild', () => {
  let item = frameItem();
  let frame = thinkingFrame();

  item.updateFrame(frame, {});
  let first = item.querySelector('.kikx-frame__thinking');

  item.updateFrame(frame, {});
  let second = item.querySelector('.kikx-frame__thinking');

  assert.notEqual(second, first, 'app-state identity change remains a rebuild trigger');
});

test('an in-place update neither runs nor duplicates bindings on reused nodes', () => {
  let item = frameItem();
  let state = {};

  item.updateFrame(thinkingFrame(), state);
  let content = item.querySelector('.kikx-frame__thinking');
  let cleaned = 0;
  content.__bindings = [ () => { cleaned++; } ];

  item.updateFrame(thinkingFrame({ content: { text: 'next' } }), state);

  assert.equal(item.querySelector('.kikx-frame__thinking'), content);
  assert.equal(cleaned, 0, 'a reused node must not have its bindings cleaned');
  assert.equal(content.__bindings.length, 1, 'a reused node must not accumulate duplicate bindings');
});

test('a rebuild cleans up and drops bindings from discarded nodes', () => {
  let item = frameItem();
  let state = {};

  item.updateFrame(thinkingFrame(), state);
  let content = item.querySelector('.kikx-frame__thinking');
  let cleaned = 0;
  content.__bindings = [ () => { cleaned++; } ];

  item.updateFrame(thinkingFrame({ id: 'frame-thinking-moved' }), state);

  assert.equal(cleaned, 1, 'discarding a node must run its bindings cleanup');
  assert.deepEqual(content.__bindings, [], 'discarded nodes must have their bindings cleared');
});

test('a custom frame component is reused and receives subsequent frames', () => {
  let item = frameItem();
  let state = {
    clientFrameComponentsByType: {
      CustomThing: { tagName: 'kikx-recording-frame' },
    },
  };
  let frame = { id: 'frame-custom', type: 'CustomThing', content: { text: 'one' } };

  item.updateFrame(frame, state);
  let first = item.querySelector('kikx-recording-frame');
  assert.ok(first);

  let next = { id: 'frame-custom', type: 'CustomThing', content: { text: 'two' } };
  item.updateFrame(next, state);
  let second = item.querySelector('kikx-recording-frame');

  assert.equal(second, first, 'the same custom tag must be reused');
  assert.equal(first.frames.length, 2, 'the reused component must receive the update');
  assert.equal(first.frames[1], next, 'the reused component must receive the newest frame');
});

test('a sub-session card is reused and receives subsequent frames', () => {
  let item = frameItem();
  let state = {};
  let frame = {
    id: 'frame-sub',
    type: 'ToolResult',
    content: {
      references: [ { type: 'session', id: 'session-1', title: 'Child', heads: [] } ],
    },
  };

  item.updateFrame(frame, state);
  let first = item.querySelector('kikx-sub-session-frame');
  assert.ok(first);

  item.updateFrame({ ...frame, content: { ...frame.content, preview: 'updated' } }, state);
  let second = item.querySelector('kikx-sub-session-frame');

  assert.equal(second, first, 'the sub-session frame element must be reused');
});

test('a ToolCall to ToolResult type change rebuilds without stale content', () => {
  let item = frameItem();
  let state = {};

  item.updateFrame(
    { id: 'frame-tool', type: 'ToolCall', content: { toolName: 'Bash', text: 'ran the old call' } },
    state,
  );
  let first = item.querySelector('p');
  assert.ok(first, 'the tool call must render a content element');
  assert.match(first.textContent, /ran the old call/);

  item.updateFrame(
    { id: 'frame-tool', type: 'ToolResult', content: { toolName: 'Bash', text: 'showed the new result' } },
    state,
  );
  let second = item.querySelector('p');

  assert.notEqual(second, first, 'a frame type change is a new logical frame and must rebuild');
  assert.match(second.textContent, /showed the new result/, 'the rebuilt element must show the result');
  assert.doesNotMatch(item.textContent, /ran the old call/, 'stale tool-call content must not survive');
});

test('identical markdown keeps its rendered children while changed text rebuilds them', () => {
  let item = frameItem();
  let state = {};
  let frame = { id: 'frame-md', type: 'AgentMessage', content: { text: 'hello world' } };

  item.updateFrame(frame, state);
  let content = item.querySelector('.kikx-frame__content.kikx-markdown');
  assert.ok(content, 'the markdown container must render');
  let child = content.firstChild;
  assert.ok(child, 'the markdown must render inner children');

  item.updateFrame({ ...frame, content: { text: 'hello world' } }, state);
  assert.equal(item.querySelector('.kikx-frame__content.kikx-markdown'), content);
  assert.equal(content.firstChild, child, 'an unchanged markdown body must not rebuild its children');

  item.updateFrame({ ...frame, content: { text: 'changed world' } }, state);
  assert.equal(item.querySelector('.kikx-frame__content.kikx-markdown'), content);
  assert.notEqual(content.firstChild, child, 'changed markdown must rebuild its children');
  assert.match(content.textContent, /changed world/);
});
