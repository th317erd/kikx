'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compactFrameSummary,
  frameStatus,
  frameStatusClass,
  isCompactFrame,
  normalizeFrameStatus,
  stripInjectedCwdPrefix,
} from '../../src/client/components/tool-frame-summary.mjs';

function toolFrame(toolName, input = {}, content = {}) {
  return {
    id: 'tool-1',
    type: 'ToolCall',
    content: { toolName, input, ...content },
  };
}

test('read-file renders the exact read wording and a document icon', () => {
  let summary = compactFrameSummary(toolFrame('read-file', { path: '/tmp/notes.txt' }, { status: 'success' }));

  assert.equal(summary.description, 'Read file /tmp/notes.txt <-');
  assert.equal(summary.icon, 'file-read');
  assert.equal(summary.status, 'success');
});

test('read-file failures are red and write-file uses the write arrow', () => {
  assert.equal(frameStatus(toolFrame('read-file', { path: '/tmp/x' }, { status: 'error' })), 'error');
  assert.equal(
    compactFrameSummary(toolFrame('write-file', { path: '/tmp/out.txt' }, { status: 'success' })).description,
    'Write file /tmp/out.txt ->',
  );
  assert.equal(
    compactFrameSummary(toolFrame('write-file', { path: '/tmp/out.txt' }, { status: 'failed' })).status,
    'error',
  );
});

test('exec uses the terminal icon without repeating the command inline', () => {
  let summary = compactFrameSummary(toolFrame('exec', { command: 'ls /tmp' }, { status: 'running' }));

  assert.equal(summary.description, 'Running command');
  assert.equal(summary.code, undefined);
  assert.equal(summary.command, 'ls /tmp');
  assert.equal(summary.icon, 'terminal');
  assert.equal(summary.status, 'running');
});

test('a completed exec result says completed instead of Running', () => {
  let summary = compactFrameSummary({
    id: 'exec-result',
    type: 'ShellToolFrame',
    content: { toolName: 'exec', phase: 'result', status: 'success', input: { command: 'ls /tmp' } },
  });

  assert.equal(summary.description, 'Command completed');
  assert.equal(summary.code, undefined);
  assert.equal(summary.command, 'ls /tmp');
});

test('a result frame without an explicit status is green', () => {
  let frame = {
    id: 'tool-2',
    type: 'ShellToolFrame',
    content: { toolName: 'exec', phase: 'result', input: { command: 'pwd' } },
  };

  assert.equal(frameStatus(frame), 'success');
  assert.equal(compactFrameSummary(frame).status, 'success');
});

test('stripInjectedCwdPrefix removes only the leading shell cwd wrapper', () => {
  assert.equal(stripInjectedCwdPrefix('cd /home/wyatt/project && ls -la'), 'ls -la');
  assert.equal(stripInjectedCwdPrefix('cd "/home/wyatt/project with space" && npm test'), 'npm test');
  assert.equal(stripInjectedCwdPrefix("cd '/tmp/project' && echo ok"), 'echo ok');
  assert.equal(stripInjectedCwdPrefix('ls -la'), 'ls -la');
  assert.equal(stripInjectedCwdPrefix('cd /tmp && cd /other && ls'), 'cd /other && ls');
  assert.equal(stripInjectedCwdPrefix('cd /tmp &&'), 'cd /tmp &&', 'never reduce a command to empty');
});

test('other tool frames derive a short verb and subject', () => {
  assert.equal(
    compactFrameSummary(toolFrame('web-search', { query: 'hottest pokemon' })).description,
    'Search for hottest pokemon',
  );
  assert.equal(
    compactFrameSummary(toolFrame('web-fetch', { url: 'https://example.com' })).description,
    'Fetch https://example.com',
  );
  assert.equal(
    compactFrameSummary(toolFrame('session-create', { title: 'Child session' })).description,
    'Create session Child session',
  );
  assert.equal(
    compactFrameSummary(toolFrame('todo-add', { title: 'Write tests' })).description,
    'Add todo Write tests',
  );
  assert.equal(
    compactFrameSummary(toolFrame('session-invite-agents', { session_id: 'session_2' })).description,
    'Invite agents to session_2',
  );
  assert.equal(
    compactFrameSummary(toolFrame('exec-status', { processID: 'proc_1' })).description,
    'Check exec status proc_1',
  );
  assert.equal(
    compactFrameSummary(toolFrame('cwd-set', { cwd: '/tmp/project' })).description,
    'Set shell cwd /tmp/project',
  );
  assert.equal(
    compactFrameSummary(toolFrame('mystery-tool', { query: 'find me' })).description,
    'Mystery Tool find me',
  );
});

test('communication frames are never compact', () => {
  for (let type of [ 'UserMessage', 'AgentMessage', 'AgentMessageDelta', 'AgentProgress', 'AgentThinking', 'BeginTyping', 'EndTyping' ])
    assert.equal(isCompactFrame({ id: type, type }), false, `${type} must stay a normal frame`);
});

test('tool and control frames are compact', () => {
  assert.equal(isCompactFrame(toolFrame('exec')), true);
  assert.equal(isCompactFrame({ type: 'ToolResult', content: { toolName: 'exec' } }), true);

  for (let type of [ 'CompactionFrame', 'AgentError', 'SystemNotice', 'CommandResult', 'FrameLoadError' ])
    assert.equal(isCompactFrame({ type }), true, `${type} should use the compact line`);
});

test('compaction statuses drive the compact wording and color', () => {
  let success = compactFrameSummary({
    type: 'CompactionFrame',
    content: { status: 'complete', frameCount: 3 },
  });
  assert.equal(success.description, 'Compaction complete (3 frames)');
  assert.equal(success.status, 'success');
  assert.equal(success.icon, 'compaction');

  let error = compactFrameSummary({ type: 'CompactionFrame', content: { status: 'failed' } });
  assert.equal(error.description, 'Compaction failed');
  assert.equal(error.status, 'error');

  let trimmed = compactFrameSummary({ type: 'CompactionFrame', content: { status: 'trimmed' } });
  assert.equal(trimmed.description, 'Compaction trimmed context');
  assert.equal(trimmed.status, 'running');

  let running = compactFrameSummary({ type: 'CompactionFrame', content: { status: 'running', frameCount: 1 } });
  assert.equal(running.description, 'Compacting context (1 frame)');
  assert.equal(running.status, 'running');
});

test('system and control frames get a human line and status', () => {
  assert.equal(
    compactFrameSummary({ type: 'AgentError', content: { text: 'Provider refused' } }).description,
    'Provider refused',
  );
  assert.equal(compactFrameSummary({ type: 'AgentError', content: {} }).status, 'error');

  assert.equal(
    compactFrameSummary({ type: 'SystemNotice', content: { text: 'Autonomous run paused', status: 'paused' } }).description,
    'Autonomous run paused',
  );
  assert.equal(
    compactFrameSummary({ type: 'SystemNotice', content: { text: 'Autonomous run paused', status: 'paused' } }).status,
    'running',
  );

  assert.equal(
    compactFrameSummary({ type: 'CommandResult', content: { command: 'compact', status: 'ok' } }).description,
    'Command /compact',
  );
  assert.equal(
    compactFrameSummary({ type: 'CommandResult', content: { command: 'compact', status: 'ok' } }).status,
    'success',
  );

  let loadError = compactFrameSummary({ type: 'FrameLoadError', content: { error: 'missing' } });
  assert.equal(loadError.description, 'Frame failed to load');
  assert.equal(loadError.status, 'error');

  let progress = compactFrameSummary({ type: 'AgentProgress', content: { text: 'Halfway there', status: 'progress' } });
  assert.equal(progress.description, 'Halfway there');
  assert.equal(progress.status, 'running');
});

test('status normalization accepts the runtime spellings', () => {
  for (let value of [ 'success', 'complete', 'completed', 'ok', 'saved', 'done' ])
    assert.equal(normalizeFrameStatus(value), 'success', value);

  for (let value of [ 'error', 'failed', 'failure', 'fail' ])
    assert.equal(normalizeFrameStatus(value), 'error', value);

  for (let value of [ 'running', 'progress', 'paused', 'trimmed', '', null, undefined ])
    assert.equal(normalizeFrameStatus(value), 'running', String(value));

  assert.equal(frameStatusClass('complete'), 'kikx-frame--status-success');
  assert.equal(frameStatusClass('failed'), 'kikx-frame--status-error');
  assert.equal(frameStatusClass('running'), 'kikx-frame--status-running');
});

test('recovers the file path from a truncated input preview', () => {
  let summary = compactFrameSummary({
    type: 'WriteFileToolFrame',
    content: {
      toolName: 'write-file',
      phase: 'result',
      status: 'success',
      input: { truncated: true, preview: '{"path":"/tmp/a.txt","content":"hello"}' },
    },
  });

  assert.equal(summary.description, 'Write file /tmp/a.txt ->');
  assert.equal(summary.icon, 'file-write');
});
