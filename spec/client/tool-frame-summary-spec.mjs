'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compactFrameBodyDescription,
  compactFrameHeader,
  compactFrameSummary,
  shellCommandFocusWord,
  frameMoodBand,
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

test('every read tool uses the eyeball icon', () => {
  for (let toolName of [ 'read-file', 'read', 'exec-read', 'output-read' ]) {
    let input = toolName === 'read-file' ? { path: '/tmp/notes.txt' } : { id: 'OUT1', processID: 'proc_1' };
    assert.equal(compactFrameSummary(toolFrame(toolName, input, { status: 'success' })).icon, 'eyeball', toolName);
  }
});

test('frameMoodBand exposes only bad, meh, and good bands', () => {
  assert.equal(frameMoodBand({ type: 'AgentProgress', content: { mood: -2.4 } }), 'bad');
  assert.equal(frameMoodBand({ type: 'AgentProgress', content: { mood: -1 } }), 'meh');
  assert.equal(frameMoodBand({ type: 'AgentProgress', content: { mood: 0.4 } }), 'meh');
  assert.equal(frameMoodBand({ type: 'AgentProgress', content: { mood: 1 } }), 'meh');
  assert.equal(frameMoodBand({ type: 'AgentProgress', content: { mood: 2.4 } }), 'good');
  assert.equal(frameMoodBand({ type: 'AgentProgress', content: {} }), 'meh', 'legacy progress frames default to meh');
  assert.equal(frameMoodBand({ type: 'AgentMessage', content: { mood: 2 } }), 'good');
  assert.equal(frameMoodBand({ type: 'AgentMessage', content: {} }), '', 'ordinary final messages stay unbanded');
});

test('compact headers use short action labels while bodies keep the full detail', () => {
  let read = toolFrame('read-file', { path: '/tmp/notes.txt' }, { status: 'success' });
  assert.deepEqual(compactFrameHeader(read), { label: 'Read File', icon: 'eyeball' });
  assert.equal(compactFrameBodyDescription(read), '<- Read file /tmp/notes.txt');
  assert.equal(
    compactFrameBodyDescription(toolFrame('read-file', { path: '/tmp/notes.txt', startLine: 10, endLine: 20 })),
    '<- Read file /tmp/notes.txt (lines 10-20)',
  );
  assert.equal(
    compactFrameHeader(toolFrame('read-file', { path: '/tmp/notes.txt', startLine: 10, endLine: 20 })).label,
    'Read File [10-20]',
  );
  assert.equal(
    compactFrameHeader(toolFrame('read-file', { path: '/tmp/notes.txt', startLine: 130 })).label,
    'Read File [130+]',
  );

  let shell = toolFrame('exec', { command: 'ls /tmp' }, { status: 'success' });
  assert.deepEqual(compactFrameHeader(shell), { label: 'ls', icon: 'gear', code: true });
  assert.equal(compactFrameBodyDescription(shell), '', 'shell status lives only in the header');
});

test('todo headers are complete read/write phrases with useful titles', () => {
  let read = compactFrameSummary(toolFrame('todo-get')).icon;
  assert.equal(compactFrameHeader(toolFrame('todo-get')).label, 'Read Todo List');
  assert.equal(read, 'check');
  assert.equal(compactFrameHeader(toolFrame('todo-add', { title: 'Ship it' })).label, 'Ship it Todo List Add');
  assert.equal(compactFrameHeader(toolFrame('todo-complete', { id: 'x' }, { preview: '{"items":[{"id":"x","title":"Ship it"}]}' })).label, 'Ship it Todo List Complete');
});

test('shell header focus skips mundane echo/cd/setup prefixes', () => {
  assert.equal(shellCommandFocusWord('echo "=== remote + upstream ===" && git remote -v && git status'), 'git remote');
  assert.equal(shellCommandFocusWord('cd ~/Projects/foo || exit 1; npm test'), 'npm test');
  assert.equal(shellCommandFocusWord('set -e; printf hi > /tmp/x; grep needle file'), 'grep');
  assert.equal(shellCommandFocusWord('FOO=bar git status'), 'git status');
  assert.equal(shellCommandFocusWord('timeout 60 git status'), 'git status');
  assert.equal(shellCommandFocusWord('TOKEN=$(timeout 60 node scripts/tool.mjs)'), 'node');
  assert.equal(shellCommandFocusWord('echo only'), 'echo');
  assert.deepEqual(compactFrameHeader(toolFrame('exec', { command: 'echo heading && git status' })), {
    label: 'git status',
    icon: 'gear',
    code: true,
  });
});

test('shell focus keeps a useful subcommand for known commands', () => {
  assert.equal(shellCommandFocusWord('git diff --stat'), 'git diff');
  assert.equal(shellCommandFocusWord('git status --short'), 'git status');
  assert.equal(shellCommandFocusWord('git -C repo status'), 'git');
  assert.equal(shellCommandFocusWord('npm run build'), 'npm run build');
  assert.equal(shellCommandFocusWord('docker compose up -d'), 'docker compose');
});

test('exec management tools use short header titles', () => {
  assert.equal(compactFrameHeader(toolFrame('exec-status', { processID: 'proc_1' })).label, 'Exec Status');
  assert.equal(compactFrameHeader(toolFrame('exec-list')).label, 'Exec List');
  assert.equal(compactFrameHeader(toolFrame('exec-grep', { processID: 'proc_1' })).label, 'Exec Search');
});

test('read-file renders the exact read wording and an eyeball icon', () => {
  let summary = compactFrameSummary(toolFrame('read-file', { path: '/tmp/notes.txt' }, { status: 'success' }));

  assert.equal(summary.description, '<- Read file /tmp/notes.txt');
  assert.equal(summary.icon, 'eyeball');
  assert.equal(summary.status, 'success');
});

test('read-file failures are red and write-file uses the quill icon', () => {
  assert.equal(frameStatus(toolFrame('read-file', { path: '/tmp/x' }, { status: 'error' })), 'error');
  assert.equal(
    compactFrameSummary(toolFrame('write-file', { path: '/tmp/out.txt' }, { status: 'success' })).description,
    '-> Write file /tmp/out.txt',
  );
  assert.equal(
    compactFrameSummary(toolFrame('write-file', { path: '/tmp/out.txt' }, { status: 'failed' })).status,
    'error',
  );
});

test('exec uses the gear icon without repeating the command inline', () => {
  let summary = compactFrameSummary(toolFrame('exec', { command: 'ls /tmp' }, { status: 'running' }));

  assert.equal(summary.description, 'Running command');
  assert.equal(summary.code, undefined);
  assert.equal(summary.command, 'ls /tmp');
  assert.equal(summary.icon, 'gear');
  assert.equal(summary.status, 'running');
});

test('exec-script uses a script header and keeps the entry in the body', () => {
  let frame = {
    id: 'script-1',
    type: 'ScriptToolFrame',
    content: { toolName: 'exec-script', status: 'running', input: { entry: 'src/main.mjs' } },
  };

  assert.deepEqual(compactFrameHeader(frame), { label: 'Script', icon: 'hash' });
  assert.equal(compactFrameBodyDescription(frame), 'Run script src/main.mjs');
  assert.equal(compactFrameSummary(frame).icon, 'hash');

  let arbitrary = {
    id: 'script-2',
    type: 'ScriptToolFrame',
    content: { toolName: 'exec-script', status: 'running', input: { start: 'python3 main.py' } },
  };
  assert.equal(compactFrameBodyDescription(arbitrary), 'Run script python3 main.py');
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

test('todo tools use the check icon', () => {
  for (let toolName of [ 'todo-add', 'todo-get', 'todo-update', 'todo-complete' ])
    assert.equal(compactFrameSummary(toolFrame(toolName, { title: 'Ship it' }, { status: 'success' })).icon, 'check');
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
  assert.equal(stripInjectedCwdPrefix('cd /home/wyatt/project\nPW=secret\necho ok'), 'PW=secret\necho ok');
  assert.equal(stripInjectedCwdPrefix('cd /home/wyatt/project\r\n  echo ok'), 'echo ok');
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
    'Add todo: Write tests',
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

test('todo result summaries name the target from the preview without IDs', () => {
  let preview = JSON.stringify({
    items: [
      { id: 'first', title: 'Unrelated todo' },
      { id: 'target', title: 'Fix the todo card' },
    ],
  });
  let summary = compactFrameSummary({
    id: 'todo-update-result',
    type: 'TodoUpdateToolFrame',
    content: { toolName: 'todo-update', phase: 'result', status: 'success', input: { id: 'target' }, preview },
  });

  assert.equal(summary.description, 'Update todo: Fix the todo card');
  assert.equal(summary.description.includes('target'), false);
});

test('todo result summaries recover a title from a truncated preview', () => {
  let preview = '{"items":[{"id":"first","title":"Unrelated todo"},{"id":"target","title":"Recovered title"}],"truncated":';
  let summary = compactFrameSummary({
    id: 'todo-update-result',
    type: 'TodoUpdateToolFrame',
    content: { toolName: 'todo-update', phase: 'result', status: 'success', input: { id: 'target' }, preview },
  });

  assert.equal(summary.description, 'Update todo: Recovered title');
});

test('ordinary communication frames are never compact', () => {
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

  assert.equal(summary.description, '-> Write file /tmp/a.txt');
  assert.equal(summary.icon, 'quill');
});

test('end-turn report messages compact while ordinary AgentMessages stay expanded', () => {
  let report = {
    id: 'turn-1',
    type: 'AgentMessage',
    content: {
      status: 'complete',
      summary: '- Synced the branch.\n- Ran the focused spec.',
      text: 'Full evidence table and logs.',
      turnReport: true,
    },
  };
  assert.equal(isCompactFrame(report), true);
  assert.equal(compactFrameSummary(report).description, '- Synced the branch.\n- Ran the focused spec.');
  assert.deepEqual(compactFrameHeader(report), { label: 'Message', icon: 'chat' });

  let ordinary = { id: 'msg-1', type: 'AgentMessage', content: { text: 'A normal reply.' } };
  assert.equal(isCompactFrame(ordinary), false);
});


test('invite command results name who was invited instead of repeating the command', () => {
  let agent = {
    type: 'CommandResult',
    content: {
      command: 'invite',
      status: 'ok',
      text: 'Zav joined this session.',
      data: { agentName: 'Zav', alreadyParticipant: false },
    },
  };
  assert.equal(compactFrameHeader(agent).label, 'Command /invite');
  assert.equal(compactFrameBodyDescription(agent), 'Zav joined this session.');

  let team = {
    type: 'CommandResult',
    content: {
      command: 'invite',
      status: 'ok',
      text: 'Team Review joined this session (2 agents, 1 user).',
      data: {
        teamName: 'Review',
        invitedAgents: [ { name: 'Zav' }, { name: 'Reviewer' } ],
        invitedUsers: [ { name: 'Wyatt' } ],
        alreadyParticipants: [],
      },
    },
  };
  assert.equal(compactFrameBodyDescription(team), 'Zav, Reviewer, and Wyatt joined this session.');

  let already = {
    type: 'CommandResult',
    content: {
      command: 'invite',
      status: 'ok',
      text: 'Zav is already in this session.',
      data: { agentName: 'Zav', alreadyParticipant: true },
    },
  };
  assert.equal(compactFrameBodyDescription(already), 'Zav was already in this session.');
});


test('shell focus labels skip compound syntax, comments, and quoted separators', () => {
  let cases = [
    [ 'cd /x 2>/dev/null || { echo "DIR MISSING"; exit 1; }\necho "== files =="\nls -la src/', 'ls' ],
    [ 'echo "=== listeners ==="; (ss -ltnp 2>/dev/null || netstat -ltnp) | grep -E ":(3001|3002)"', 'ss' ],
    [ '(command -v ss && ss -ltnp) 2>/dev/null | head -30', 'ss' ],
    [ 'cd /x || exit 1\ngrep -rn \'mozavcodec\\|Library(\' media/ffvpx/moz.build | head -20', 'grep' ],
    [ 'SSH="ssh -i $HOME/key -o ConnectTimeout=10 host"\n$SSH \'uptime\' 2>&1', 'ssh' ],
    [ 'cd /home/wyatt && echo "open: $(curl -s \'http://127.0.0.1:3001/api/v1/questions\' | python3 -c "import sys,json;print(len(json.load(sys.stdin)))")"', 'curl' ],
    [ 'set -u\nCAND=/tmp/x\n# comment\nCF=$(python3 - "$CAND" <<\'PY\'\nprint("x")\nPY\n)\necho "$CF"', 'python3' ],
    [ 'for f in *.txt; do echo "$f"; grep -n foo "$f"; done', 'grep' ],
    [ 'for d in /a /b; do if [ -d "$d" ]; then echo yes; else echo no; fi; done', 'shell' ],
    [ 'cd /tmp && norm() { sed -n "s/x/y/p" "$1" | sort -u; }; norm k2.log', 'norm' ],
    [ 'BODY=\'{"answer":"<User chose not to respond>","silent":true}\'\ncurl -s -d "$BODY" http://127.0.0.1:3002/x', 'curl' ],
    [ 'cd ~/x && echo "PWD: $(pwd)" && echo "---GIT---" && git rev-parse --show-toplevel', 'pwd' ],
    [ 'cd /x && case "spec/foo.mjs" in *-spec.mjs) echo IN;; *) echo OUT;; esac && git add spec/foo.mjs', 'git add' ],
    [ 'cd /tmp\nPROMPT=\'You are auditing a UI\'\n~/Programs/bot-ocr --help', 'bot-ocr' ],
    [ '~/.bot-common/tools/bot-ocr --help', 'bot-ocr' ],
  ];

  for (let [ command, expected ] of cases)
    assert.equal(shellCommandFocusWord(command), expected, command);
});
