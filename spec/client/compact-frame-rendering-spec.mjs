'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document, registry: customElements } = installDom();

class RecordingTool extends HTMLElement {
  constructor() {
    super();
    this.frames = [];
  }

  updateFrame(frame) {
    this.frames.push(frame);
  }
}

class RecordingReadFileTool extends RecordingTool {}
class RecordingShellTool extends RecordingTool {}

class RecordingCompaction extends HTMLElement {
  constructor() {
    super();
    this.frames = [];
  }

  updateFrame(frame) {
    this.frames.push(frame);
  }
}

class StubSessionCard extends HTMLElement {
  update(values) {
    this.values = values;
  }
}

customElements.define('kikx-read-file-use', RecordingReadFileTool);
customElements.define('kikx-shell-tool-use', RecordingShellTool);
customElements.define('kikx-compaction-frame', RecordingCompaction);
customElements.define('kikx-session-card', StubSessionCard);

await import('../../src/client/components/kikx-frame-item.mjs');

function frameItem() {
  return document.createElement('kikx-frame-item');
}

function toolState(toolName, tagName) {
  return {
    clientToolComponentsByName: {
      [toolName]: { tagName },
    },
  };
}

function compactDetails(item) {
  return item.querySelector('details.kikx-frame__compact');
}

function summaryDescription(item) {
  return item.querySelector('.kikx-frame__compact-description').textContent;
}

function summaryIcon(item) {
  return item.querySelector('.kikx-frame__compact-icon').textContent;
}

test('a successful read-file frame renders one compact line with the existing tool card in its body', () => {
  let item = frameItem();
  let state = toolState('read-file', 'kikx-read-file-use');
  let frame = {
    id: 'read-1',
    type: 'ReadFileToolFrame',
    content: {
      toolName: 'read-file',
      phase: 'result',
      status: 'success',
      input: { path: '/tmp/notes.txt' },
    },
  };

  item.updateFrame(frame, state);

  assert.ok(item.classList.contains('kikx-frame--compact'));
  assert.ok(item.classList.contains('kikx-frame--status-success'));
  assert.equal(item.dataset.frameStatus, 'success');

  let details = compactDetails(item);
  assert.ok(details, 'the frame must use the native details disclosure');
  assert.equal(summaryDescription(item), 'Read file /tmp/notes.txt <-');
  assert.equal(summaryIcon(item), '\u25a4');

  let summary = details.querySelector('summary');
  let summaryChildren = summary.children;
  assert.equal(summaryChildren[0], summary.querySelector('.kikx-frame__compact-icon'), 'the icon must sit on the left');

  let body = details.querySelector('.kikx-frame__compact-body');
  assert.ok(body, 'the disclosure must have a body');
  assert.ok(body.querySelector('kikx-read-file-use'), 'the existing tool card must be preserved');
  assert.ok(item.querySelector('.kikx-frame__meta'), 'the metadata header must stay visible on the frame');

  details.setAttribute('open', '');
  assert.equal(details.hasAttribute('open'), true, 'the native disclosure owns expansion');
});

test('a re-rendered tool frame keeps its disclosure and recolors red on failure', () => {
  let item = frameItem();
  let state = toolState('read-file', 'kikx-read-file-use');
  let success = {
    id: 'read-1',
    type: 'ReadFileToolFrame',
    content: { toolName: 'read-file', phase: 'result', status: 'success', input: { path: '/tmp/notes.txt' } },
  };

  item.updateFrame(success, state);
  let details = compactDetails(item);
  let tool = item.querySelector('kikx-read-file-use');

  let failed = {
    ...success,
    content: { ...success.content, status: 'error' },
  };
  item.updateFrame(failed, state);

  assert.equal(compactDetails(item), details, 'a same-key frame update must not replace the disclosure');
  assert.equal(item.querySelector('kikx-read-file-use'), tool, 'the tool card must be reconciled in place');
  assert.equal(tool.frames.length, 2, 'the tool card must receive the updated frame');
  assert.ok(item.classList.contains('kikx-frame--status-error'));
  assert.equal(item.classList.contains('kikx-frame--status-success'), false);
  assert.equal(item.dataset.frameStatus, 'error');
});

test('exec renders the command in inline code and switches from neutral to green', () => {
  let item = frameItem();
  let state = toolState('exec', 'kikx-shell-tool-use');
  let running = {
    id: 'exec-1',
    type: 'ShellToolFrame',
    content: {
      toolName: 'exec',
      phase: 'call',
      status: 'running',
      input: { command: 'ls /tmp' },
    },
  };

  item.updateFrame(running, state);

  assert.ok(item.classList.contains('kikx-frame--status-running'));
  assert.equal(summaryDescription(item), 'Running ls /tmp');
  assert.equal(item.querySelector('.kikx-frame__compact-description code').textContent, 'ls /tmp');
  assert.equal(summaryIcon(item), '\u2699');

  item.updateFrame({
    ...running,
    type: 'ToolResult',
    content: { ...running.content, phase: 'result', status: 'success' },
  }, state);

  assert.ok(item.classList.contains('kikx-frame--status-success'));
  assert.equal(item.dataset.frameStatus, 'success');
  assert.equal(item.querySelector('.kikx-frame__compact-description code').textContent, 'ls /tmp');
});

test('communication frames keep the normal meta and content layout', () => {
  let item = frameItem();
  item.updateFrame({ id: 'agent-1', type: 'AgentMessage', content: { text: 'hello' } }, {});

  assert.equal(item.classList.contains('kikx-frame--compact'), false);
  assert.equal(compactDetails(item), null);
  assert.ok(item.querySelector('.kikx-frame__meta'));
  assert.match(item.textContent, /hello/);
});

test('a tool result with a session reference keeps the sub-session card intact', () => {
  let item = frameItem();
  let frame = {
    id: 'session-create-1',
    type: 'ToolResult',
    content: {
      toolName: 'session-create',
      phase: 'result',
      status: 'success',
      references: [ { type: 'session', id: 'session_child', title: 'Child', heads: [] } ],
    },
  };

  item.updateFrame(frame, {});

  assert.equal(item.classList.contains('kikx-frame--compact'), false);
  assert.equal(compactDetails(item), null);
  assert.ok(item.querySelector('kikx-sub-session-frame'));
});

test('compaction wraps its existing component instead of reimplementing it', () => {
  let item = frameItem();
  let state = {
    clientFrameComponentsByType: {
      CompactionFrame: { tagName: 'kikx-compaction-frame' },
    },
  };
  let frame = {
    id: 'compact-1',
    type: 'CompactionFrame',
    content: { status: 'complete', frameCount: 2 },
  };

  item.updateFrame(frame, state);

  assert.ok(item.classList.contains('kikx-frame--compact'));
  assert.ok(item.classList.contains('kikx-frame--status-success'));
  assert.equal(summaryDescription(item), 'Compaction complete (2 frames)');

  let compaction = item.querySelector('kikx-compaction-frame');
  assert.ok(compaction, 'the dedicated compaction component must still render');
  assert.equal(compaction.frames.length, 1);
});
