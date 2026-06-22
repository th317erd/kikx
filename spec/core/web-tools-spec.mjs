'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { PluginRegistry } from '../../src/core/plugins/index.mjs';
import {
  AgentListTool,
  CwdClearTool,
  CwdGetTool,
  CwdSetTool,
  DatabaseFetchTool,
  DatabaseSearchTool,
  ExecTool,
  ExecGrepTool,
  ExecKillTool,
  ExecListTool,
  ExecReadTool,
  ExecStatusTool,
  FeedbackReportTool,
  LocalCommandExecutionService,
  LocalFileAccessService,
  OutputGrepTool,
  OutputReadTool,
  OutputSearchTool,
  ProcessManager,
  PuppeteerBrowserService,
  ReadFileTool,
  registerBuiltInTools,
  SessionCreateTool,
  SessionFramesTool,
  SessionGetTool,
  SessionInviteAgentsTool,
  SessionListTool,
  SessionMessageTool,
  SessionSearchTool,
  TodoAddTool,
  TodoClearTool,
  TodoCompleteTool,
  TodoDeleteTool,
  TodoFocusClearTool,
  TodoFocusSetTool,
  TodoGetTool,
  TodoUpdateTool,
  ToolExecutionService,
  ToolOutputStore,
  WebFetchTool,
  WebSearchTool,
  WriteFileTool,
} from '../../src/core/tools/index.mjs';

class EchoTool {
  constructor(context = {}) {
    this.context = context;
  }

  async execute(input = {}) {
    return {
      text: input.text,
      agentID: input._agentID,
      sessionID: input._sessionID,
      frameID: input._frameID,
    };
  }
}

test('registerBuiltInTools registers global web tools with OpenAI-safe names', () => {
  let registry = new PluginRegistry({ logger: { warn() {} } });

  registerBuiltInTools(registry);

  assert.equal(registry.getTool('web-search'), WebSearchTool);
  assert.equal(registry.getTool('web-fetch'), WebFetchTool);
  assert.equal(registry.getTool('read-file'), ReadFileTool);
  assert.equal(registry.getTool('write-file'), WriteFileTool);
  assert.equal(registry.getTool('exec'), ExecTool);
  assert.equal(registry.getTool('exec-list'), ExecListTool);
  assert.equal(registry.getTool('exec-status'), ExecStatusTool);
  assert.equal(registry.getTool('exec-read'), ExecReadTool);
  assert.equal(registry.getTool('exec-grep'), ExecGrepTool);
  assert.equal(registry.getTool('exec-kill'), ExecKillTool);
  assert.equal(registry.getTool('cwd-get'), CwdGetTool);
  assert.equal(registry.getTool('cwd-set'), CwdSetTool);
  assert.equal(registry.getTool('cwd-clear'), CwdClearTool);
  assert.equal(registry.getTool('feedback-report'), FeedbackReportTool);
  assert.equal(registry.getTool('database-search'), DatabaseSearchTool);
  assert.equal(registry.getTool('database-fetch'), DatabaseFetchTool);
  assert.equal(registry.getTool('process-list'), null);
  assert.equal(registry.getTool('process-response-fetch'), null);
  assert.equal(registry.getTool('process-wake-on-completion'), null);
  assert.equal(registry.getTool('output-read'), OutputReadTool);
  assert.equal(registry.getTool('output-grep'), OutputGrepTool);
  assert.equal(registry.getTool('output-search'), OutputSearchTool);
  assert.equal(registry.getTool('agent-list'), AgentListTool);
  assert.equal(registry.getTool('session-list'), SessionListTool);
  assert.equal(registry.getTool('session-create'), SessionCreateTool);
  assert.equal(registry.getTool('session-invite-agents'), SessionInviteAgentsTool);
  assert.equal(registry.getTool('session-get'), SessionGetTool);
  assert.equal(registry.getTool('session-frames'), SessionFramesTool);
  assert.equal(registry.getTool('session-search'), SessionSearchTool);
  assert.equal(registry.getTool('session-message'), SessionMessageTool);
  assert.equal(registry.getTool('todo-get'), TodoGetTool);
  assert.equal(registry.getTool('todo-add'), TodoAddTool);
  assert.equal(registry.getTool('todo-update'), TodoUpdateTool);
  assert.equal(registry.getTool('todo-complete'), TodoCompleteTool);
  assert.equal(registry.getTool('todo-delete'), TodoDeleteTool);
  assert.equal(registry.getTool('todo-clear'), TodoClearTool);
  assert.equal(registry.getTool('todo-focus-set'), TodoFocusSetTool);
  assert.equal(registry.getTool('todo-focus-clear'), TodoFocusClearTool);
  assert.equal([...registry.getTools().keys()].every((name) => /^[A-Za-z0-9_-]+$/.test(name)), true);
});

test('FeedbackReportTool writes reports through the consolidated feedback store', async () => {
  let calls = [];
  let feedbackStore = {
    async createFeedback(input, context) {
      calls.push({ input, context });
      return {
        id: 'FB1',
        path: '/feedback/feedback-FB1.md',
        title: input.title,
        severity: input.severity || 'medium',
        message: 'saved',
      };
    },
  };
  let context = {
    agent: { id: 'agent_1', name: 'Coder' },
    session: { id: 'ses_1' },
    frame: { id: 'frm_1' },
    services: { feedbackStore },
  };

  let result = await new FeedbackReportTool(context).execute({
    title: 'Tool loop error',
    severity: 'high',
    report: 'The agent hit a repeated tool loop.',
  });

  assert.equal(result.path, '/feedback/feedback-FB1.md');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.title, 'Tool loop error');
  assert.equal(calls[0].context.agent.id, 'agent_1');
});

test('cwd tools mutate only the calling agent session cwd', async () => {
  let calls = [];
  let agentCwdStore = {
    async getCWD(agentID, sessionID) {
      calls.push({ method: 'getCWD', agentID, sessionID });
      return { agentID, sessionID, cwd: '/tmp', configured: false };
    },
    async setCWD(agentID, sessionID, cwd) {
      calls.push({ method: 'setCWD', agentID, sessionID, cwd });
      return { agentID, sessionID, cwd: '/tmp/project', configured: true };
    },
    async clearCWD(agentID, sessionID) {
      calls.push({ method: 'clearCWD', agentID, sessionID });
      return { agentID, sessionID, cwd: '/tmp', configured: false };
    },
  };
  let context = {
    agent: { id: 'agent_1', name: 'Coder' },
    session: { id: 'ses_1' },
    services: { agentCwdStore },
  };

  let get = await new CwdGetTool(context).execute({});
  let set = await new CwdSetTool(context).execute({ cwd: 'project' });
  let cleared = await new CwdClearTool(context).execute({});

  assert.equal(get.cwd, '/tmp');
  assert.equal(set.cwd, '/tmp/project');
  assert.equal(cleared.configured, false);
  assert.deepEqual(calls, [
    { method: 'getCWD', agentID: 'agent_1', sessionID: 'ses_1' },
    { method: 'setCWD', agentID: 'agent_1', sessionID: 'ses_1', cwd: 'project' },
    { method: 'clearCWD', agentID: 'agent_1', sessionID: 'ses_1' },
  ]);
});

test('todo tools mutate only the calling agent todo list', async () => {
  let calls = [];
  let todoStore = {
    async getTodoState(agentID) {
      calls.push({ method: 'getTodoState', agentID });
      return { agentID, items: [], focus: null };
    },
    async addItem(agentID, input) {
      calls.push({ method: 'addItem', agentID, input });
      return { agentID, items: [ { id: 'todo_1', title: input.title, children: [] } ], focus: null };
    },
    async setFocus(agentID, input) {
      calls.push({ method: 'setFocus', agentID, input });
      return { agentID, items: [], focus: { itemID: input.id, childID: null, name: 'Build', setAt: 1 } };
    },
  };
  let context = {
    agent: { id: 'agent_1', name: 'Coder' },
    services: { agentTodoStore: todoStore },
  };

  let getResult = await new TodoGetTool(context).execute({});
  let addResult = await new TodoAddTool(context).execute({ title: 'Build', focus: true });
  let focusResult = await new TodoFocusSetTool(context).execute({ id: 'todo_1' });

  assert.deepEqual(getResult, { agentID: 'agent_1', items: [], focus: null });
  assert.equal(addResult.items[0].title, 'Build');
  assert.equal(focusResult.focus.itemID, 'todo_1');
  assert.deepEqual(calls.map((call) => call.method), [ 'getTodoState', 'addItem', 'setFocus' ]);
  assert.deepEqual(calls.map((call) => call.agentID), [ 'agent_1', 'agent_1', 'agent_1' ]);
});

test('ReadFileTool reads local files through the file access service', async () => {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-read-file-'));
  let filePath = path.join(dir, 'sample.txt');
  await fs.writeFile(filePath, 'hello world\n', 'utf8');

  let tool = new ReadFileTool({
    services: {
      fileAccess: new LocalFileAccessService({ cwd: dir }),
    },
  });
  let result = await tool.execute({
    path: 'sample.txt',
  });

  assert.equal(result.requestedPath, 'sample.txt');
  assert.equal(result.path, filePath);
  assert.equal(result.encoding, 'utf8');
  assert.equal(result.sizeBytes, 12);
  assert.equal(result.bytesRead, 12);
  assert.equal(result.truncated, false);
  assert.equal(result.ranged, false);
  assert.equal(result.rangeType, null);
  assert.equal(result.range, null);
  assert.equal(result.content, 'hello world\n');
});

test('ReadFileTool uses the agent session cwd for relative paths', async () => {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-read-file-cwd-'));
  let serverBase = path.join(dir, 'server-base');
  let workspace = path.join(dir, 'workspace');
  await fs.mkdir(serverBase);
  await fs.mkdir(workspace);
  let filePath = path.join(workspace, 'sample.txt');
  await fs.writeFile(filePath, 'from workspace\n', 'utf8');
  let agentCwdStore = {
    async getCWD(agentID, sessionID) {
      return {
        agentID,
        sessionID,
        cwd: workspace,
        configured: true,
      };
    },
  };

  let tool = new ReadFileTool({
    agent: { id: 'agent_1' },
    session: { id: 'ses_1' },
    services: {
      fileAccess: new LocalFileAccessService({ cwd: serverBase }),
      agentCwdStore,
    },
  });
  let result = await tool.execute({
    path: 'sample.txt',
  });

  assert.equal(result.requestedPath, 'sample.txt');
  assert.equal(result.path, filePath);
  assert.equal(result.content, 'from workspace\n');
});

test('ReadFileTool reads 1-based inclusive line ranges', async () => {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-read-lines-'));
  let filePath = path.join(dir, 'sample.txt');
  await fs.writeFile(filePath, 'one\ntwo\nthree\nfour\n', 'utf8');

  let tool = new ReadFileTool({
    services: {
      fileAccess: new LocalFileAccessService({ cwd: dir }),
    },
  });
  let result = await tool.execute({
    path: 'sample.txt',
    startLine: 2,
    endLine: 3,
  });

  assert.equal(result.path, filePath);
  assert.equal(result.sizeBytes, 19);
  assert.equal(result.bytesRead, 10);
  assert.equal(result.truncated, true);
  assert.equal(result.ranged, true);
  assert.equal(result.rangeType, 'line');
  assert.deepEqual(result.range, {
    type: 'line',
    startLine: 2,
    endLine: 3,
    totalLines: 4,
  });
  assert.equal(result.content, 'two\nthree\n');
});

test('ReadFileTool reads 0-based exclusive character ranges', async () => {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-read-chars-'));
  await fs.writeFile(path.join(dir, 'sample.txt'), 'abcde🙂f', 'utf8');

  let tool = new ReadFileTool({
    services: {
      fileAccess: new LocalFileAccessService({ cwd: dir }),
    },
  });
  let result = await tool.execute({
    path: 'sample.txt',
    startCharacter: 2,
    endCharacter: 6,
  });

  assert.equal(result.content, 'cde🙂');
  assert.equal(result.bytesRead, Buffer.byteLength('cde🙂', 'utf8'));
  assert.equal(result.truncated, true);
  assert.equal(result.ranged, true);
  assert.equal(result.rangeType, 'character');
  assert.deepEqual(result.range, {
    type: 'character',
    startCharacter: 2,
    endCharacter: 6,
    totalCharacters: 7,
  });
});

test('ReadFileTool rejects ambiguous ranges', async () => {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-read-bad-range-'));
  await fs.writeFile(path.join(dir, 'sample.txt'), 'hello', 'utf8');
  let tool = new ReadFileTool({
    services: {
      fileAccess: new LocalFileAccessService({ cwd: dir }),
    },
  });

  await assert.rejects(
    () => tool.execute({
      path: 'sample.txt',
      startLine: 1,
      startCharacter: 0,
    }),
    /either a line range or a character range/,
  );
});

test('WriteFileTool writes local files through the file access service', async () => {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-write-file-'));
  let filePath = path.join(dir, 'nested', 'sample.txt');
  let tool = new WriteFileTool({
    services: {
      fileAccess: new LocalFileAccessService({ cwd: dir }),
    },
  });

  let result = await tool.execute({
    path: 'nested/sample.txt',
    content: 'hello world\n',
  });

  assert.equal(result.requestedPath, 'nested/sample.txt');
  assert.equal(result.path, filePath);
  assert.equal(result.encoding, 'utf8');
  assert.equal(result.mode, 'overwrite');
  assert.equal(result.bytesWritten, 12);
  assert.equal(result.sizeBytes, 12);
  assert.equal(result.created, true);
  assert.equal(result.appended, false);
  assert.equal(result.createDirectories, true);
  assert.equal(await fs.readFile(filePath, 'utf8'), 'hello world\n');
});

test('WriteFileTool uses the agent session cwd for relative paths', async () => {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-write-file-cwd-'));
  let serverBase = path.join(dir, 'server-base');
  let workspace = path.join(dir, 'workspace');
  await fs.mkdir(serverBase);
  await fs.mkdir(workspace);
  let workspaceFile = path.join(workspace, 'nested', 'sample.txt');
  let serverBaseFile = path.join(serverBase, 'nested', 'sample.txt');
  let agentCwdStore = {
    async getCWD(agentID, sessionID) {
      return {
        agentID,
        sessionID,
        cwd: workspace,
        configured: true,
      };
    },
  };

  let tool = new WriteFileTool({
    agent: { id: 'agent_1' },
    session: { id: 'ses_1' },
    services: {
      fileAccess: new LocalFileAccessService({ cwd: serverBase }),
      agentCwdStore,
    },
  });
  let result = await tool.execute({
    path: 'nested/sample.txt',
    content: 'from workspace\n',
  });

  assert.equal(result.requestedPath, 'nested/sample.txt');
  assert.equal(result.path, workspaceFile);
  assert.equal(await fs.readFile(workspaceFile, 'utf8'), 'from workspace\n');
  await assert.rejects(
    () => fs.stat(serverBaseFile),
    /ENOENT/,
  );
});

test('WriteFileTool appends and create mode refuses existing files', async () => {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-write-append-'));
  let filePath = path.join(dir, 'sample.txt');
  await fs.writeFile(filePath, 'one\n', 'utf8');

  let tool = new WriteFileTool({
    services: {
      fileAccess: new LocalFileAccessService({ cwd: dir }),
    },
  });
  let appendResult = await tool.execute({
    path: 'sample.txt',
    content: 'two\n',
    mode: 'append',
  });

  assert.equal(appendResult.created, false);
  assert.equal(appendResult.appended, true);
  assert.equal(appendResult.sizeBytes, 8);
  assert.equal(await fs.readFile(filePath, 'utf8'), 'one\ntwo\n');

  await assert.rejects(
    () => tool.execute({
      path: 'sample.txt',
      content: 'three\n',
      mode: 'create',
    }),
    /refusing to overwrite existing file/,
  );
  assert.equal(await fs.readFile(filePath, 'utf8'), 'one\ntwo\n');
});

test('WriteFileTool supports empty and base64 content', async () => {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-write-base64-'));
  let tool = new WriteFileTool({
    services: {
      fileAccess: new LocalFileAccessService({ cwd: dir }),
    },
  });

  let emptyResult = await tool.execute({
    path: 'empty.txt',
    content: '',
  });
  assert.equal(emptyResult.bytesWritten, 0);
  assert.equal(await fs.readFile(path.join(dir, 'empty.txt'), 'utf8'), '');

  let base64Result = await tool.execute({
    path: 'binary.bin',
    content: Buffer.from([ 0, 1, 2, 255 ]).toString('base64'),
    encoding: 'base64',
  });
  assert.equal(base64Result.encoding, 'base64');
  assert.equal(base64Result.bytesWritten, 4);
  assert.deepEqual([...(await fs.readFile(path.join(dir, 'binary.bin')))], [ 0, 1, 2, 255 ]);
});

test('WriteFileTool requires consolidated file access service', async () => {
  let tool = new WriteFileTool();

  await assert.rejects(
    () => tool.execute({ path: '/tmp/example.txt', content: 'hello' }),
    /write-file requires a fileAccess service/,
  );
});

test('LocalCommandExecutionService runs commands through a login shell', async () => {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-exec-'));
  let home = path.join(dir, 'home');
  await fs.mkdir(home);
  await fs.writeFile(path.join(home, '.bash_profile'), 'export KIKX_EXEC_PROFILE_VALUE=from-profile\n', 'utf8');
  let shell = fsSyncExists('/bin/bash') ? '/bin/bash' : process.env.SHELL;
  let service = new LocalCommandExecutionService({
    cwd: dir,
    shell,
    env: {
      HOME: home,
      PATH: process.env.PATH,
    },
  });

  let result = await service.exec({
    command: 'printf "%s:%s" "$KIKX_EXEC_PROFILE_VALUE" "$PWD"',
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.cwd, dir);
  assert.equal(result.stdout, `from-profile:${dir}`);
  assert.equal(result.stderr, '');
  assert.equal(result.stdoutBytes, Buffer.byteLength(result.stdout));
});

test('LocalCommandExecutionService captures stderr and non-zero exit codes without throwing', async () => {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-exec-stderr-'));
  let home = path.join(dir, 'home');
  await fs.mkdir(home);
  let service = new LocalCommandExecutionService({
    cwd: dir,
    shell: fsSyncExists('/bin/bash') ? '/bin/bash' : process.env.SHELL,
    env: {
      HOME: home,
      PATH: process.env.PATH,
    },
  });

  let result = await service.exec({
    command: 'printf "out"; printf "err" >&2; exit 7',
  });

  assert.equal(result.exitCode, 7);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
});

test('LocalCommandExecutionService keeps RVM-style login shell hooks working after commands enable nounset', async () => {
  if (!fsSyncExists('/bin/bash'))
    return;

  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-exec-rvm-nounset-'));
  let home = path.join(dir, 'home');
  let nested = path.join(dir, 'nested');
  await fs.mkdir(home);
  await fs.mkdir(nested);
  await fs.writeFile(path.join(home, '.bash_profile'), `
__rvm_file_env_check_unload() {
  if (( \${#rvm_saved_env[@]} > 0 )); then
    :
  fi
  rvm_saved_env=()
}

__rvm_teardown_final() {
  (( rvm_bash_nounset == 1 )) && set -o nounset
}

cd() {
  builtin cd "$@"
  __rvm_file_env_check_unload
}

trap '__rvm_teardown_final' EXIT
`, 'utf8');

  let service = new LocalCommandExecutionService({
    cwd: dir,
    shell: '/bin/bash',
    env: {
      HOME: home,
      PATH: process.env.PATH,
    },
  });

  let result = await service.exec({
    command: 'set -u; cd nested; printf "%s" "$PWD"',
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, nested);
  assert.equal(result.stderr, '');
});

test('LocalCommandExecutionService times out and reports killed command state', async () => {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-exec-timeout-'));
  let home = path.join(dir, 'home');
  await fs.mkdir(home);
  let service = new LocalCommandExecutionService({
    cwd: dir,
    shell: fsSyncExists('/bin/bash') ? '/bin/bash' : process.env.SHELL,
    env: {
      HOME: home,
      PATH: process.env.PATH,
    },
  });

  let result = await service.exec({
    command: 'sleep 5',
    timeoutMs: 50,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutMs, 50);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, 'SIGTERM');
});

test('LocalCommandExecutionService completes nohup and disown commands that inherit stdio', async () => {
  if (!fsSyncExists('/bin/bash'))
    return;

  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-exec-detached-'));
  let home = path.join(dir, 'home');
  let pidPath = path.join(dir, 'background.pid');
  await fs.mkdir(home);
  let service = new LocalCommandExecutionService({
    cwd: dir,
    shell: '/bin/bash',
    exitStdioGraceMs: 50,
    env: {
      HOME: home,
      PATH: process.env.PATH,
    },
  });

  try {
    let result = await service.exec({
      command: `nohup sleep 5 & echo $! > ${shellQuote(pidPath)}; disown; printf "detached"`,
      timeoutMs: 1000,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    assert.equal(result.timedOut, false);
    assert.equal(result.stdout, 'detached');
    assert.equal(result.stdioClosedByManager, true);
  } finally {
    await killPIDFromFile(pidPath);
  }
});

test('ExecTool requires consolidated process manager service', async () => {
  let tool = new ExecTool();

  await assert.rejects(
    () => tool.execute({ command: 'true' }),
    /exec requires a processManager service/,
  );
});

test('ExecTool returns direct output when async process completes during grace window', async () => {
  let { processManager } = await createProcessHarness({ graceMs: 500 });
  let tool = new ExecTool({
    services: { processManager },
  });

  let result = await tool.execute({
    command: 'printf "quick"',
    _agentID: 'agent_1',
    _sessionID: 'ses_1',
    _frameID: 'frm_1',
  });

  assert.equal(result.completedWithinGrace, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.result.stdout, 'quick');
  assert.equal(result.completionToolOutputID, 'OUT1');
});

test('ExecTool uses the agent session cwd when cwd is omitted', async () => {
  let { processManager, dir } = await createProcessHarness({ graceMs: 500 });
  let workspace = path.join(dir, 'workspace');
  await fs.mkdir(workspace);
  let agentCwdStore = {
    async getCWD(agentID, sessionID) {
      return {
        agentID,
        sessionID,
        cwd: workspace,
        configured: true,
      };
    },
  };
  let tool = new ExecTool({
    services: { processManager, agentCwdStore },
  });

  let result = await tool.execute({
    command: 'pwd',
    _agentID: 'agent_1',
    _sessionID: 'ses_1',
    _frameID: 'frm_1',
  });

  assert.equal(result.completedWithinGrace, true);
  assert.equal(result.result.cwd, workspace);
  assert.equal(result.result.stdout.trim(), workspace);
});

test('ExecTool completes setsid-detached shell wrappers without waiting for inherited stdio', async () => {
  if (!fsSyncExists('/bin/bash') || !fsSyncExists('/usr/bin/setsid'))
    return;

  let { processManager, dir } = await createProcessHarness({
    graceMs: 1000,
    exitStdioGraceMs: 50,
  });
  let pidPath = path.join(dir, 'setsid.pid');
  let tool = new ExecTool({
    services: { processManager },
  });

  try {
    let result = await tool.execute({
      command: `setsid sleep 5 & echo $! > ${shellQuote(pidPath)}; printf "setsid-started"`,
      _agentID: 'agent_1',
      _sessionID: 'ses_1',
      _frameID: 'frm_1',
    });

    assert.equal(result.completedWithinGrace, true);
    assert.equal(result.status, 'completed');
    assert.equal(result.timedOut, false);
    assert.equal(result.stdioClosedByManager, true);
    assert.equal(result.result.stdout, 'setsid-started');
    assert.equal(result.result.stdioClosedByManager, true);
    assert.equal(result.completionToolOutputID, 'OUT1');
  } finally {
    await killPIDFromFile(pidPath);
  }
});

test('ExecTool returns running process instructions and stores completion output later', async () => {
  let { processManager, aeordb } = await createProcessHarness({ graceMs: 25 });
  let tool = new ExecTool({
    services: { processManager },
  });

  let result = await tool.execute({
    command: 'printf "start"; sleep 0.15; printf " done"',
    _agentID: 'agent_1',
    _sessionID: 'ses_1',
    _frameID: 'frm_1',
  });

  assert.equal(result.status, 'running');
  assert.match(result.message, /Async exec ID#/);
  assert.match(result.message, /automatically when it completes/);
  assert.equal(result.tools.status.tool, 'exec-status');

  await waitFor(async () => processManager.status({
    processID: result.processID,
    _agentID: 'agent_1',
  }).status === 'completed');

  let status = processManager.status({
    processID: result.processID,
    _agentID: 'agent_1',
  });
  assert.equal(status.completionToolOutputID, 'OUT1');
  assert.match(aeordb.files.get('/kikx/tool-outputs/OUT1/result.txt'), /start done/);
});

test('ExecTool automatically schedules an agent wake when a long async process completes', async () => {
  let { processManager } = await createProcessHarness({ graceMs: 10 });
  let scheduledFrames = [];
  let processedScheduledFrames = false;
  processManager.frameRuntime = {
    clock: () => 123456,
    idGenerator: () => 'wake_frame_1',
    async ensureSessionEntry(sessionID) {
      return {
        session: { id: sessionID },
        frameEngine: {
          merge(frames) {
            scheduledFrames.push(...frames);
            return frames;
          },
        },
      };
    },
    frameStore: {
      async flush() {},
    },
    async processScheduledFrames() {
      processedScheduledFrames = true;
    },
  };
  let tool = new ExecTool({
    services: { processManager },
  });

  let started = await tool.execute({
    command: 'sleep 0.05; printf "finished"',
    _agentID: 'agent_1',
    _sessionID: 'ses_1',
    _frameID: 'frm_1',
  });

  assert.equal(started.status, 'running');

  await waitFor(async () => processManager.status({
    processID: started.processID,
    _agentID: 'agent_1',
  }).status === 'completed');

  assert.equal(scheduledFrames.length, 1);
  assert.equal(scheduledFrames[0].hidden, true);
  assert.equal(scheduledFrames[0].targetAgentID, 'agent_1');
  assert.equal(scheduledFrames[0].continuation.kind, 'exec-wake-on-completion');
  assert.equal(scheduledFrames[0].content.completionToolOutputID, 'OUT1');
  assert.equal(processedScheduledFrames, true);
});

test('ExecTool wake prompt gives range and grep instructions for large completion responses', async () => {
  let { processManager } = await createProcessHarness({ graceMs: 10, inlineLimitBytes: 64 });
  let scheduledFrames = [];
  processManager.frameRuntime = {
    clock: () => 123456,
    idGenerator: () => 'wake_frame_1',
    async ensureSessionEntry(sessionID) {
      return {
        session: { id: sessionID },
        frameEngine: {
          merge(frames) {
            scheduledFrames.push(...frames);
            return frames;
          },
        },
      };
    },
    frameStore: {
      async flush() {},
    },
    async processScheduledFrames() {},
  };
  let tool = new ExecTool({
    services: { processManager },
  });

  let started = await tool.execute({
    command: 'sleep 0.05; printf "%s" "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz"',
    _agentID: 'agent_1',
    _sessionID: 'ses_1',
    _frameID: 'frm_1',
  });

  await waitFor(async () => processManager.status({
    processID: started.processID,
    _agentID: 'agent_1',
  }).status === 'completed');

  assert.match(scheduledFrames[0].content.text, /finished, but the completion response is large/);
  assert.match(scheduledFrames[0].content.text, /output-read/);
  assert.match(scheduledFrames[0].content.text, /output-grep/);
  assert.doesNotMatch(scheduledFrames[0].content.text, /process-response-fetch/);
});

test('Exec management tools read, grep, list, and kill per-agent async processes', async () => {
  let { processManager } = await createProcessHarness({ graceMs: 0 });
  let exec = new ExecTool({
    services: { processManager },
  });
  let started = await exec.execute({
    command: 'printf "alpha\\nbeta\\n"; sleep 5',
    _agentID: 'agent_1',
  });

  let listTool = new ExecListTool({ services: { processManager } });
  let list = await listTool.execute({ _agentID: 'agent_1' });
  assert.deepEqual(list.processes.map((process) => process.processID), [ started.processID ]);

  await waitFor(async () => {
    let read = await processManager.read({
      processID: started.processID,
      _agentID: 'agent_1',
      stream: 'stdout',
      full: true,
    });
    return read.content.includes('beta');
  });

  let readTool = new ExecReadTool({ services: { processManager } });
  let read = await readTool.execute({
    processID: started.processID,
    _agentID: 'agent_1',
    stream: 'stdout',
    start: 0,
    end: 5,
  });
  assert.equal(read.content, 'alpha');

  let grepTool = new ExecGrepTool({ services: { processManager } });
  let grep = await grepTool.execute({
    processID: started.processID,
    _agentID: 'agent_1',
    stream: 'stdout',
    pattern: 'bet',
  });
  assert.equal(grep.matches[0].line, 'beta');

  assert.throws(
    () => processManager.status({ processID: started.processID, _agentID: 'agent_2' }),
    /not owned/,
  );

  let killTool = new ExecKillTool({ services: { processManager } });
  let kill = await killTool.execute({
    processID: started.processID,
    _agentID: 'agent_1',
  });
  assert.equal(kill.signal, 'SIGTERM');

  await waitFor(async () => processManager.status({
    processID: started.processID,
    _agentID: 'agent_1',
  }).status === 'killed');
});

test('OutputReadTool reads persisted exec completion output by tool output ID', async () => {
  let { processManager } = await createProcessHarness({ graceMs: 5 });
  let exec = new ExecTool({
    services: { processManager },
  });
  let started = await exec.execute({
    command: 'sleep 0.05; printf "persisted-response"',
    _agentID: 'agent_1',
  });

  await waitFor(async () => processManager.status({
    processID: started.processID,
    _agentID: 'agent_1',
  }).status === 'completed');

  let outputTool = new OutputReadTool({ services: { toolOutputStore: processManager.toolOutputStore } });
  let response = await outputTool.execute({
    id: processManager.status({
      processID: started.processID,
      _agentID: 'agent_1',
    }).completionToolOutputID,
    full: true,
  });

  assert.equal(response.id, 'OUT1');
  assert.match(response.content, /persisted-response/);
});

test('ToolExecutionService stores every tool result and returns inline envelope below limit', async () => {
  let aeordb = createFakeToolOutputDB();
  let store = new ToolOutputStore({
    aeordb,
    idGenerator: () => 'OUT1',
    clock: () => '2026-06-08T00:00:00.000Z',
  });
  let result = await new ToolExecutionService({ toolOutputStore: store }).executeTool({
    toolName: 'global-echo',
    ToolClass: EchoTool,
    input: { text: 'hello' },
    context: {
      agent: { id: 'agent_1' },
      session: { id: 'ses_1' },
      frame: { id: 'frm_1' },
    },
  });

  assert.equal(result.type, 'ToolOutput');
  assert.equal(result.toolOutputID, 'OUT1');
  assert.equal(result.stored, true);
  assert.equal(result.inline, true);
  assert.equal(result.retrieval.getTool, 'output-read');
  assert.deepEqual(result.retrieval.getAll.arguments, {
    id: 'OUT1',
    full: true,
  });
  assert.deepEqual(result.result, {
    text: 'hello',
    agentID: 'agent_1',
    sessionID: 'ses_1',
    frameID: 'frm_1',
  });

  assert.ok(aeordb.files.has('/kikx/tool-outputs/.aeordb-config/indexes.json'));
  assert.equal(aeordb.files.get('/kikx/tool-outputs/OUT1/metadata.json').toolName, 'global-echo');
  assert.match(aeordb.files.get('/kikx/tool-outputs/OUT1/result.txt'), /"text": "hello"/);
});

test('ToolExecutionService emits visible typed tool frames', async () => {
  let aeordb = createFakeToolOutputDB();
  let store = new ToolOutputStore({
    aeordb,
    idGenerator: () => 'OUT1',
    clock: () => '2026-06-08T00:00:00.000Z',
  });
  let frameEngine = createRecordingFrameEngine();
  let flushCount = 0;

  await new ToolExecutionService({ toolOutputStore: store }).executeTool({
    toolName: 'global-echo',
    ToolClass: EchoTool,
    input: { text: 'hello', apiKey: 'secret' },
    context: {
      agent: { id: 'agent_1', name: 'Test Agent' },
      session: { id: 'ses_1' },
      frame: { id: 'frm_1', interactionID: 'int_1' },
      responseFrameID: 'agent_response_1',
      services: {
        frameEngine,
        clock: () => 1781035260000000,
        frameRuntime: {
          frameStore: {
            async flush() {
              flushCount++;
            },
          },
        },
      },
    },
  });

  assert.equal(frameEngine.frames.length, 2);
  assert.equal(flushCount, 2);
  assert.equal(frameEngine.frames[0].type, 'GlobalEchoToolFrame');
  assert.equal(frameEngine.frames[0].hidden, false);
  assert.equal(frameEngine.frames[0].parentID, 'agent_response_1');
  assert.equal(frameEngine.frames[0].authorDisplayName, 'Test Agent');
  assert.equal(frameEngine.frames[0].content.phase, 'call');
  assert.equal(frameEngine.frames[0].content.toolName, 'global-echo');
  assert.deepEqual(frameEngine.frames[0].content.input, {
    text: 'hello',
    apiKey: '[redacted]',
  });

  assert.equal(frameEngine.frames[1].type, 'GlobalEchoToolFrame');
  assert.equal(frameEngine.frames[1].hidden, false);
  assert.equal(frameEngine.frames[1].parentID, frameEngine.frames[0].id);
  assert.equal(frameEngine.frames[1].content.phase, 'result');
  assert.equal(frameEngine.frames[1].content.toolName, 'global-echo');
  assert.equal(frameEngine.frames[1].content.toolOutputID, 'OUT1');
  assert.equal(frameEngine.frames[1].content.status, 'success');
  assert.deepEqual(frameEngine.frames[1].content.input, {
    text: 'hello',
    apiKey: '[redacted]',
  });
  assert.match(frameEngine.frames[1].content.preview, /"text": "hello"/);
  assert.equal('result' in frameEngine.frames[1].content, false);
});

test('ToolExecutionService records tool frames and output metadata in session_id target sessions', async () => {
  let aeordb = createFakeToolOutputDB();
  let store = new ToolOutputStore({
    aeordb,
    idGenerator: () => 'OUT_TARGET',
    clock: () => '2026-06-08T00:00:00.000Z',
  });
  let sourceEngine = createRecordingFrameEngine();
  let targetEngine = createRecordingFrameEngine();
  let flushCount = 0;
  let frameRuntime = {
    frameStore: {
      async flush() {
        flushCount++;
      },
    },
    async ensureSessionEntry(sessionID) {
      assert.equal(sessionID, 'ses_target');
      return {
        session: { id: 'ses_target', title: 'Target' },
        frameEngine: targetEngine,
      };
    },
  };

  let result = await new ToolExecutionService({ toolOutputStore: store }).executeTool({
    toolName: 'global-echo',
    ToolClass: EchoTool,
    input: { text: 'hello target', session_id: 'ses_target' },
    context: {
      agent: { id: 'agent_1', name: 'Test Agent' },
      session: { id: 'ses_source', title: 'Source' },
      frame: { id: 'frm_source', sessionID: 'ses_source', interactionID: 'int_1' },
      responseFrameID: 'agent_response_source',
      frameEngine: sourceEngine,
      services: {
        frameRuntime,
        clock: () => 1781035260000000,
      },
    },
  });

  assert.equal(result.result.sessionID, 'ses_target');
  assert.equal(sourceEngine.frames.length, 0);
  assert.equal(targetEngine.frames.length, 2);
  assert.equal(flushCount, 2);
  assert.equal(targetEngine.frames[0].sessionID, 'ses_target');
  assert.equal(targetEngine.frames[0].parentID, null);
  assert.equal(targetEngine.frames[0].content.input.session_id, 'ses_target');
  assert.equal(targetEngine.frames[0].content.targetSessionID, 'ses_target');
  assert.equal(targetEngine.frames[0].content.sourceSessionID, 'ses_source');
  assert.equal(targetEngine.frames[0].content.sourceFrameID, 'frm_source');
  assert.equal(targetEngine.frames[0].content.sourceResponseFrameID, 'agent_response_source');
  assert.equal(targetEngine.frames[1].sessionID, 'ses_target');
  assert.equal(targetEngine.frames[1].parentID, targetEngine.frames[0].id);
  assert.equal(targetEngine.frames[1].content.targetSessionID, 'ses_target');
  assert.equal(aeordb.files.get('/kikx/tool-outputs/OUT_TARGET/metadata.json').sessionID, 'ses_target');
});

test('Session tools list, create, inspect frames, and post messages through FrameRuntime', async () => {
  let targetEngine = createRecordingFrameEngine();
  let sessionEngines = new Map([
    [ 'ses_2', targetEngine ],
  ]);
  let sessions = [
    { id: 'ses_1', title: 'Source', messageCount: 1, participantAgentIDs: [ 'agent_1' ], generation: 0 },
    { id: 'ses_2', title: 'Target', messageCount: 2, participantAgentIDs: [ 'agent_2' ], generation: 0 },
  ];
  let agents = [
    { id: 'agent_1', name: 'Agent One', pluginID: 'openai:codex', enabled: true },
    { id: 'agent_2', name: 'Agent Two', pluginID: 'openai:codex', enabled: true },
    { id: 'agent_3', name: 'Agent Three', pluginID: 'openai:codex', enabled: true },
    { id: 'agent_disabled', name: 'Disabled Agent', pluginID: 'openai:codex', enabled: false },
  ];
  let runtime = {
    idGenerator: (() => {
      let index = 0;
      return () => `runtime_${++index}`;
    })(),
    frameStore: {
      flushCount: 0,
      async flush() {
        this.flushCount++;
      },
    },
    clock: () => 1781035260000000,
    nextClockStamp() {
      return {
        at: 1781035260000000,
        clock: '1781035260000000-000000-test',
      };
    },
    async listSessions({ limit, offset } = {}) {
      return sessions.slice(offset || 0, (offset || 0) + (limit || sessions.length));
    },
    async createSession(input = {}) {
      let id = `ses_${sessions.length + 1}`;
      let session = {
        id,
        title: input.title || `Session ${sessions.length + 1}`,
        participantAgentIDs: input.participantAgentIDs || [],
        createdByAgentID: input.createdByAgentID || null,
        parentSessionID: input.parentSessionID || null,
        generation: input.generation ?? 0,
        messageCount: 0,
      };
      sessions.push(session);
      sessionEngines.set(id, createRecordingFrameEngine());
      return session;
    },
    async inviteAgentToSession(sessionID, agent) {
      let session = sessions.find((candidate) => candidate.id === sessionID);
      if (!session) {
        let error = new Error(`Unknown session: ${sessionID}`);
        error.status = 404;
        throw error;
      }

      let alreadyParticipant = session.participantAgentIDs.includes(agent.id);
      if (!alreadyParticipant)
        session.participantAgentIDs.push(agent.id);

      session.coordinatorAgentID ||= session.participantAgentIDs[0] || null;
      return { session, agentID: agent.id, alreadyParticipant };
    },
    async ensureSessionEntry(sessionID) {
      let session = sessions.find((candidate) => candidate.id === sessionID);
      if (!session) {
        let error = new Error(`Unknown session: ${sessionID}`);
        error.status = 404;
        throw error;
      }

      return {
        session,
        frameEngine: sessionEngines.get(sessionID) || createRecordingFrameEngine(),
      };
    },
    async listFrames(sessionID, options = {}) {
      assert.equal(sessionID, 'ses_2');
      assert.deepEqual(options, { limit: 2, offset: 0 });
      return [
        {
          id: 'frm_1',
          type: 'UserMessage',
          sessionID,
          authorType: 'user',
          authorID: 'user_1',
          content: { text: 'hello' },
        },
      ];
    },
  };
  let context = {
    agent: { id: 'agent_1', name: 'Agent One' },
    session: { id: 'ses_1', title: 'Source' },
    frame: { id: 'source_frame', sessionID: 'ses_1', interactionID: 'int_1' },
    services: {
      frameRuntime: runtime,
      agentManager: {
        async listAgents({ limit, offset } = {}) {
          return agents.slice(offset || 0, (offset || 0) + (limit || agents.length));
        },
        async resolveAgent(reference) {
          let normalized = reference.toLowerCase();
          let agent = agents.find((candidate) => candidate.id === reference || candidate.name.toLowerCase() === normalized);
          if (!agent) {
            let error = new Error(`Agent not found: ${reference}`);
            error.status = 404;
            throw error;
          }

          return agent;
        },
      },
    },
  };

  let listedAgents = await new AgentListTool(context).execute({ limit: 10 });
  assert.deepEqual(listedAgents.agents.map((agent) => agent.id), [ 'agent_1', 'agent_2', 'agent_3' ]);

  let listed = await new SessionListTool(context).execute({ limit: 1 });
  assert.deepEqual(listed.sessions.map((session) => session.id), [ 'ses_1' ]);

  let created = await new SessionCreateTool(context).execute({
    title: 'Branch',
    includeSelf: true,
    participantAgents: [ 'Agent Two' ],
    initialMessage: [
      'Project: Kikx',
      'CWD: /home/wyatt/Projects/kikx-workspace/kikx',
      'Goal: review session count handling.',
      'Current status: code is patched; verify tests.',
      'First assignment: inspect the current diff and report risks.',
    ].join('\n'),
  });
  assert.equal(created.session.title, 'Branch');
  assert.deepEqual(created.session.participantAgentIDs, [ 'agent_2', 'agent_1' ]);
  assert.equal(created.session.createdByAgentID, 'agent_1');
  assert.equal(created.session.parentSessionID, 'ses_1');
  assert.equal(created.session.generation, 1);
  assert.equal(created.initialFrame.type, 'AgentMessage');
  assert.equal(created.initialFrame.sessionID, created.session.id);
  assert.equal(created.initialFrame.authorDisplayName, 'Agent One');
  assert.match(created.initialFrame.content.text, /Project: Kikx/);
  assert.match(created.initialFrame.content.text, /CWD: \/home\/wyatt\/Projects\/kikx-workspace\/kikx/);
  assert.match(created.initialFrame.content.text, /First assignment:/);
  assert.equal(sessionEngines.get(created.session.id).frames.length, 1);
  assert.equal(sessionEngines.get(created.session.id).frames[0].content.sourceSessionID, 'ses_1');

  let reused = await new SessionCreateTool(context).execute({
    title: 'Branch',
    includeSelf: true,
    participantAgents: [ 'Agent Two' ],
    initialMessage: 'Duplicate handoff should not be posted.',
  });
  assert.equal(reused.session.id, created.session.id);
  assert.equal(reused.created, false);
  assert.equal(reused.reusedExisting, true);
  assert.equal(reused.initialFrame, null);
  assert.equal(sessionEngines.get(created.session.id).frames.length, 1);

  let invited = await new SessionInviteAgentsTool(context).execute({
    session_id: created.session.id,
    agents: [ 'Agent Three', 'agent_2' ],
  });
  assert.equal(invited.sessionID, created.session.id);
  assert.deepEqual(invited.invitedAgentIDs, [ 'agent_3', 'agent_2' ]);
  assert.deepEqual(invited.session.participantAgentIDs, [ 'agent_2', 'agent_1', 'agent_3' ]);

  let got = await new SessionGetTool(context).execute({ session_id: 'ses_2' });
  assert.equal(got.session.title, 'Target');

  let frames = await new SessionFramesTool(context).execute({ session_id: 'ses_2', limit: 2 });
  assert.equal(frames.sessionID, 'ses_2');
  assert.deepEqual(frames.frames.map((frame) => frame.id), [ 'frm_1' ]);

  let posted = await new SessionMessageTool(context).execute({ session_id: 'ses_2', text: 'Cross-session hello.' });
  assert.equal(posted.sessionID, 'ses_2');
  assert.equal(targetEngine.frames.length, 1);
  assert.equal(targetEngine.frames[0].type, 'AgentMessage');
  assert.equal(targetEngine.frames[0].sessionID, 'ses_2');
  assert.equal(targetEngine.frames[0].authorDisplayName, 'Agent One');
  assert.equal(targetEngine.frames[0].content.text, 'Cross-session hello.');
  assert.equal(targetEngine.frames[0].content.sourceSessionID, 'ses_1');
  assert.equal(runtime.frameStore.flushCount, 2);
});

test('Session delegation tools allow only first-generation source sessions', async () => {
  let calls = [];
  let runtime = {
    async createSession() {
      calls.push({ method: 'createSession' });
      return { id: 'ses_new', title: 'New', participantAgentIDs: [], generation: 1 };
    },
    async inviteAgentToSession(sessionID, agent) {
      calls.push({ method: 'inviteAgentToSession', sessionID, agentID: agent.id });
      return {
        session: {
          id: sessionID,
          title: 'Child',
          participantAgentIDs: [ agent.id ],
          generation: 1,
        },
        alreadyParticipant: false,
      };
    },
    async ensureSessionEntry(sessionID) {
      return {
        session: { id: sessionID, title: 'Child', participantAgentIDs: [ 'agent_2' ], generation: 1 },
      };
    },
  };
  let agentManager = {
    async resolveAgent(reference) {
      return { id: reference, name: reference, pluginID: 'openai:codex', enabled: true };
    },
  };
  let allowed = {
    agent: { id: 'agent_1', name: 'Agent One' },
    sourceSession: { id: 'ses_root', title: 'Root', generation: 0 },
    session: { id: 'ses_child', title: 'Child', generation: 1 },
    services: { frameRuntime: runtime, agentManager },
  };

  let invited = await new SessionInviteAgentsTool(allowed).execute({
    session_id: 'ses_child',
    agents: [ 'agent_2' ],
  });
  assert.equal(invited.sessionID, 'ses_child');
  assert.deepEqual(calls, [{ method: 'inviteAgentToSession', sessionID: 'ses_child', agentID: 'agent_2' }]);

  let blocked = {
    ...allowed,
    sourceSession: { id: 'ses_child', title: 'Child', generation: 1 },
  };
  await assert.rejects(
    () => new SessionCreateTool(blocked).execute({ title: 'Grandchild' }),
    /session-create is only available to first-generation agents/,
  );
  await assert.rejects(
    () => new SessionInviteAgentsTool(blocked).execute({ session_id: 'ses_grandchild', agents: [ 'agent_2' ] }),
    /session-invite-agents is only available to first-generation agents/,
  );
});

test('ToolExecutionService returns a pointer envelope for outputs above inline limit', async () => {
  let aeordb = createFakeToolOutputDB();
  let store = new ToolOutputStore({
    aeordb,
    inlineLimitBytes: 180,
    defaultReadBytes: 32,
    idGenerator: () => 'BIG1',
  });

  class BigTool {
    async execute() {
      return { content: 'x'.repeat(512) };
    }
  }

  let result = await new ToolExecutionService({ toolOutputStore: store }).executeTool({
    toolName: 'big-tool',
    ToolClass: BigTool,
    input: {},
    context: {},
  });

  assert.equal(result.type, 'ToolOutputPointer');
  assert.equal(result.toolOutputID, 'BIG1');
  assert.equal(result.inline, false);
  assert.equal(result.sizeBytes > 512, true);
  assert.equal(result.retrieval.getRange.tool, 'output-read');
  assert.deepEqual(result.retrieval.getRange.arguments, {
    id: 'BIG1',
    start: 0,
    end: 32,
  });
  assert.match(result.message, /output-read/);
  assert.match(result.message, /"full":true/);
  assert.equal('result' in result, false);
  assert.match(aeordb.files.get('/kikx/tool-outputs/BIG1/result.txt'), /"content"/);
});

function createRecordingFrameEngine() {
  let nextID = 1;
  return {
    frames: [],
    idGenerator() {
      return `tool_frame_${nextID++}`;
    },
    merge(frames) {
      this.frames.push(...frames);
      return frames;
    },
    get(id) {
      return this.frames.find((frame) => frame.id === id) || null;
    },
  };
}

test('OutputReadTool retrieves stored output ranges', async () => {
  let aeordb = createFakeToolOutputDB();
  let store = new ToolOutputStore({
    aeordb,
    idGenerator: () => 'RANGE1',
  });
  await store.storeToolOutput({
    toolName: 'plain-text',
    result: 'abcdef',
  });

  let tool = new OutputReadTool({
    services: { toolOutputStore: store },
  });
  let result = await tool.execute({
    id: 'RANGE1',
    start: 2,
    end: 5,
  });

  assert.equal(result.id, 'RANGE1');
  assert.equal(result.content, 'cde');
  assert.equal(result.start, 2);
  assert.equal(result.end, 5);
  assert.equal(result.returnedBytes, 3);
  assert.equal(result.truncated, true);
  assert.ok(aeordb.calls.some((call) => call.method === 'getFile' && call.options?.headers?.Range === 'bytes=2-4'));
});

test('OutputReadTool retrieves JSON tool output as serialized text', async () => {
  let aeordb = createFakeToolOutputDB();
  let store = new ToolOutputStore({
    aeordb,
    idGenerator: () => 'JSON1',
  });
  await store.storeToolOutput({
    toolName: 'json-result',
    result: {
      processID: 'proc_1',
      stdout: 'persisted json output',
    },
  });

  let tool = new OutputReadTool({
    services: { toolOutputStore: store },
  });
  let result = await tool.execute({
    id: 'JSON1',
    full: true,
  });

  assert.match(result.content, /"processID": "proc_1"/);
  assert.match(result.content, /"stdout": "persisted json output"/);
  assert.doesNotMatch(result.content, /\[object Object\]/);
});

test('OutputGrepTool searches stored tool output with a regular expression', async () => {
  let aeordb = createFakeToolOutputDB();
  let store = new ToolOutputStore({
    aeordb,
    idGenerator: () => 'GREP1',
  });
  await store.storeToolOutput({
    toolName: 'plain-text',
    result: 'alpha\nbeta\ngamma\n',
  });

  let tool = new OutputGrepTool({
    services: { toolOutputStore: store },
  });
  let result = await tool.execute({
    id: 'GREP1',
    pattern: '^b',
    flags: 'm',
  });

  assert.equal(result.id, 'GREP1');
  assert.equal(result.matchCount, 1);
  assert.equal(result.matches[0].lineNumber, 2);
  assert.equal(result.matches[0].line, 'beta');
});

test('OutputSearchTool asks AeorDB for hit locators on stored output search', async () => {
  let aeordb = createFakeToolOutputDB();
  let store = new ToolOutputStore({
    aeordb,
    idGenerator: () => 'OUT1',
  });
  await store.storeToolOutput({
    toolName: 'plain-text',
    result: 'alpha\nbeta\ngamma\n',
  });

  let tool = new OutputSearchTool({
    services: { toolOutputStore: store },
  });
  let result = await tool.execute({
    query: 'beta',
    maxMatchesPerResult: 3,
  });

  let searchCall = aeordb.calls.find((call) => call.method === 'searchFiles');
  assert.equal(searchCall.search.path, '/kikx/tool-outputs');
  assert.equal(searchCall.search.query, 'beta');
  assert.equal(searchCall.search.include_matches, true);
  assert.equal(searchCall.search.max_matches_per_result, 3);
  assert.equal(searchCall.search.snippet_chars, 240);
  assert.equal(result.fetchTool, 'database-fetch');
  assert.equal(result.results[0].toolOutputID, 'OUT1');
  assert.equal(result.results[0].matches[0].fetch.preferred, 'line_range');
});

test('DatabaseSearchTool returns AeorDB hit locators with fetch instructions', async () => {
  let aeordb = createFakeToolOutputDB();
  let tool = new DatabaseSearchTool({
    services: { aeordb },
  });

  let result = await tool.execute({
    path: '/kikx/sessions',
    query: 'coordinator',
    snippetChars: 80,
  });

  let searchCall = aeordb.calls.find((call) => call.method === 'searchFiles');
  assert.equal(searchCall.search.path, '/kikx/sessions');
  assert.equal(searchCall.search.query, 'coordinator');
  assert.equal(searchCall.search.include_matches, true);
  assert.equal(searchCall.search.snippet_chars, 80);
  assert.equal(result.fetchTool, 'database-fetch');
  assert.equal(result.results[0].locatorFetchTool, 'database-fetch');
  assert.equal(result.results[0].content_hash, 'hash1');
});

test('DatabaseFetchTool fetches locator ranges with stale guards', async () => {
  let aeordb = createFakeToolOutputDB();
  aeordb.files.set('/kikx/tool-outputs/OUT1/result.txt', 'alpha\nbeta\n');
  let tool = new DatabaseFetchTool({
    services: { aeordb },
  });

  let result = await tool.execute({
    items: [
      {
        id: 'm_1',
        path: '/kikx/tool-outputs/OUT1/result.txt',
        content_hash: 'hash1',
        fetch: {
          preferred: 'line_range',
          line_range: { start: 2, end: 2 },
        },
      },
    ],
    continueOnError: true,
  });

  let fetchCall = aeordb.calls.find((call) => call.method === 'fetchFileRanges');
  assert.deepEqual(fetchCall.items, [
    {
      id: 'm_1',
      path: '/kikx/tool-outputs/OUT1/result.txt',
      range: { mode: 'lines', start: 2, end: 2 },
      if_content_hash: 'hash1',
    },
  ]);
  assert.equal(fetchCall.options.continueOnError, true);
  assert.equal(result.items[0].range.mode, 'lines');
  assert.equal(result.rangeSemantics.lines, 'start/end are 1-based inclusive line numbers.');
});

test('SessionSearchTool scopes locator search to a session frame index', async () => {
  let aeordb = createFakeToolOutputDB();
  let ensuredSessionID = null;
  let tool = new SessionSearchTool({
    services: {
      frameRuntime: {
        frameStore: {
          aeordb,
          rootPath: '/kikx',
          async ensureSessionIndexConfigs(sessionID) {
            ensuredSessionID = sessionID;
          },
        },
      },
    },
    session: { id: 'ses_1' },
  });

  let result = await tool.execute({
    query: 'hello',
  });

  let searchCall = aeordb.calls.find((call) => call.method === 'searchFiles');
  assert.equal(ensuredSessionID, 'ses_1');
  assert.equal(searchCall.search.path, '/kikx/sessions/ses_1/interactions');
  assert.equal(searchCall.search.include_matches, true);
  assert.equal(result.sessionID, 'ses_1');
  assert.equal(result.fetchTool, 'database-fetch');
});

test('ReadFileTool requires consolidated file access service', async () => {
  let tool = new ReadFileTool();

  await assert.rejects(
    () => tool.execute({ path: '/tmp/example.txt' }),
    /read-file requires a fileAccess service/,
  );
});

test('WebSearchTool queries DuckDuckGo instant answers and normalizes results', async () => {
  let requestedURL = null;
  let tool = new WebSearchTool({
    fetchImpl: async (url, options = {}) => {
      requestedURL = new URL(url);
      assert.equal(options.headers.Accept, 'application/json');
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            Heading: 'Kikx',
            AbstractText: 'A modular agent runner.',
            AbstractURL: 'https://example.test/kikx',
            AbstractSource: 'Example',
            Answer: '42',
            Results: [
              {
                Text: 'Kikx result',
                FirstURL: 'https://example.test/result',
              },
            ],
            RelatedTopics: [
              {
                Name: 'Related',
                Topics: [
                  {
                    Text: 'Nested related result',
                    FirstURL: 'https://example.test/related',
                  },
                ],
              },
            ],
          });
        },
      };
    },
  });

  let result = await tool.execute({
    query: 'kikx agent runner',
    maxResults: 3,
  });

  assert.equal(requestedURL.origin, 'https://api.duckduckgo.com');
  assert.equal(requestedURL.searchParams.get('q'), 'kikx agent runner');
  assert.equal(requestedURL.searchParams.get('format'), 'json');
  assert.equal(result.source, 'duckduckgo-instant-answer');
  assert.equal(result.heading, 'Kikx');
  assert.equal(result.results.length, 3);
  assert.deepEqual(result.results.map((item) => item.type), [ 'abstract', 'answer', 'result' ]);
  assert.equal(result.results[0].url, 'https://example.test/kikx');
});

test('WebSearchTool falls back to DuckDuckGo HTML results when instant answers are empty', async () => {
  let requests = [];
  let tool = new WebSearchTool({
    fetchImpl: async (url, options = {}) => {
      let requestedURL = new URL(url);
      requests.push({
        url: requestedURL,
        accept: options.headers.Accept,
      });

      if (requestedURL.origin === 'https://api.duckduckgo.com') {
        return {
          ok: true,
          async text() {
            return JSON.stringify({
              Heading: '',
              Results: [],
              RelatedTopics: [],
            });
          },
        };
      }

      return {
        ok: true,
        async text() {
          return `
            <div class="result results_links results_links_deep web-result">
              <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fforecast.weather.gov%2Fzipcity.php%3Finputstring%3DPhoenix%2CAZ&amp;rut=abc">
                7-Day Forecast 33.45N 112.07W - National Weather Service
              </a>
              <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fforecast.weather.gov%2Fzipcity.php%3Finputstring%3DPhoenix%2CAZ&amp;rut=abc">
                Your local <b>forecast</b> office is <b>Phoenix</b>, <b>AZ</b>.
              </a>
            </div>
            <div class="result results_links results_links_deep web-result">
              <a rel="nofollow" class="result__a" href="https://www.weather.gov/psr/">NWS Forecast Office Phoenix, AZ</a>
              <a class="result__snippet" href="https://www.weather.gov/psr/">Weather forecast office page.</a>
            </div>
          `;
        },
      };
    },
  });

  let result = await tool.execute({
    query: 'Phoenix AZ weather forecast National Weather Service',
    maxResults: 2,
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.origin, 'https://api.duckduckgo.com');
  assert.equal(requests[1].url.origin, 'https://html.duckduckgo.com');
  assert.equal(requests[1].accept, 'text/html,application/xhtml+xml');
  assert.equal(result.source, 'duckduckgo-html');
  assert.equal(result.resultCount, 2);
  assert.equal(result.results[0].url, 'https://forecast.weather.gov/zipcity.php?inputstring=Phoenix,AZ');
  assert.equal(result.results[0].text, 'Your local forecast office is Phoenix, AZ.');
  assert.equal(result.results[0].source, 'forecast.weather.gov');
  assert.equal(result.results[1].url, 'https://www.weather.gov/psr/');
});

test('WebSearchTool reports empty DuckDuckGo responses with query context', async () => {
  let tool = new WebSearchTool({
    fetchImpl: async () => ({
      ok: true,
      async text() {
        return '';
      },
    }),
  });

  await assert.rejects(
    () => tool.execute({ query: 'Phoenix weather' }),
    /DuckDuckGo returned an empty response for query: Phoenix weather/,
  );
});

test('WebFetchTool extracts rendered page details through injected browser service', async () => {
  let visitedURL = null;
  let browserService = {
    async withPage(callback) {
      let page = {
        setDefaultNavigationTimeout(timeout) {
          assert.equal(timeout, 5000);
        },
        setDefaultTimeout(timeout) {
          assert.equal(timeout, 5000);
        },
        async setUserAgent(userAgent) {
          assert.match(userAgent, /Kikx/);
        },
        async goto(url, options = {}) {
          visitedURL = url;
          assert.equal(options.waitUntil, 'domcontentloaded');
          return {
            status() {
              return 200;
            },
          };
        },
        async waitForSelector(selector) {
          assert.equal(selector, 'main');
        },
        async evaluate(_fn, args) {
          assert.deepEqual(args, {
            selector: 'main',
            maxTextLength: 2000,
            maxLinks: 2,
          });
          let evaluated = vm.runInNewContext(`(${_fn.toString()})(args)`, {
            args,
            document: {
              title: 'Example Page',
              body: {
                innerText: 'Rendered   text\n\n\nMore text',
              },
              documentElement: {
                innerText: 'Fallback text',
              },
              querySelector(selector) {
                assert.equal(selector, 'main');
                return {
                  innerText: 'Rendered   text\n\n\nMore text',
                };
              },
              querySelectorAll(selector) {
                assert.equal(selector, 'a[href]');
                return [
                  {
                    innerText: 'Docs\nLink',
                    href: 'https://example.test/docs',
                  },
                  {
                    textContent: 'Other Link',
                    href: 'https://example.test/other',
                  },
                  {
                    innerText: 'Hidden',
                    href: '',
                  },
                ];
              },
            },
            location: {
              href: 'https://example.test/final',
            },
          });
          return JSON.parse(JSON.stringify(evaluated));
        },
      };

      return await callback(page, { mode: 'cdp' });
    },
  };

  let tool = new WebFetchTool({
    services: { webBrowser: browserService },
  });
  let result = await tool.execute({
    url: 'https://example.test/start',
    selector: 'main',
    timeoutMs: 5000,
    maxTextLength: 2000,
    maxLinks: 2,
  });

  assert.equal(visitedURL, 'https://example.test/start');
  assert.deepEqual(result, {
    requestedURL: 'https://example.test/start',
    finalURL: 'https://example.test/final',
    title: 'Example Page',
    status: 200,
    browserMode: 'cdp',
    selector: 'main',
    text: 'Rendered text\n\nMore text',
    textTruncated: false,
    links: [
      { text: 'Docs\nLink', url: 'https://example.test/docs' },
      { text: 'Other Link', url: 'https://example.test/other' },
    ],
  });
});

test('WebFetchTool rejects non-http URLs', async () => {
  let tool = new WebFetchTool({
    services: {
      webBrowser: {
        async withPage() {
          throw new Error('should not open browser');
        },
      },
    },
  });

  await assert.rejects(
    () => tool.execute({ url: 'file:///etc/passwd' }),
    /url must use http or https/,
  );
});

test('PuppeteerBrowserService falls back to headless stealth launch with a Chrome channel', async () => {
  let launchOptions = null;
  let closed = false;
  let service = new PuppeteerBrowserService({
    puppeteerCore: {
      async connect() {
        throw new Error('cdp offline');
      },
    },
    stealthPuppeteer: {
      async launch(options) {
        launchOptions = options;
        return {
          on() {},
          async close() {
            closed = true;
          },
        };
      },
    },
  });

  await service.browser();
  await service.close();

  assert.equal(launchOptions.headless, true);
  assert.equal(launchOptions.channel, 'chrome');
  assert.deepEqual(launchOptions.args.slice(0, 2), [ '--no-sandbox', '--disable-setuid-sandbox' ]);
  assert.equal(closed, true);
});

function createFakeToolOutputDB() {
  let files = new Map();
  let calls = [];

  return {
    files,
    calls,
    async putFile(path, body, options = {}) {
      calls.push({ method: 'putFile', path, body, options });
      files.set(path, body);
      return { path };
    },
    async getFile(path, options = {}) {
      calls.push({ method: 'getFile', path, options });
      if (!files.has(path)) {
        let error = new Error(`missing file: ${path}`);
        error.status = 404;
        throw error;
      }

      let value = files.get(path);
      if (options.expectJSON === false)
        return String(value ?? '');

      return value;
    },
    async fetchFileRanges(items, options = {}) {
      calls.push({ method: 'fetchFileRanges', items, options });
      return {
        items: items.map((item) => ({
          id: item.id || null,
          status: 'ok',
          path: item.path,
          range: item.range,
          content: String(files.get(item.path) ?? ''),
          truncated: false,
        })),
        has_errors: false,
      };
    },
    async searchFiles(search) {
      calls.push({ method: 'searchFiles', search });
      return {
        results: [
          {
            path: `${search.path}/OUT1/result.txt`,
            score: 1,
            matched_by: [ 'resultText' ],
            content_hash: 'hash1',
            updated_at: 1781035260000,
            matches: [
              {
                id: 'm_1',
                matched_text: search.query || 'match',
                source: { type: 'stored-file', mime_type: 'text/plain' },
                range: {
                  line: { start: 1, end: 1 },
                  byte: { start: 0, end: 5 },
                },
                fetch: {
                  line_range: { start: 1, end: 1 },
                  byte_range: { start: 0, end: 5 },
                  preferred: 'line_range',
                },
              },
            ],
            matches_truncated: false,
            locator_status: 'complete',
          },
        ],
        has_more: false,
        total_count: 1,
      };
    },
  };
}

async function createProcessHarness({ graceMs = 0, inlineLimitBytes, exitStdioGraceMs } = {}) {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-process-harness-'));
  let tempRoot = path.join(dir, 'processes');
  let home = path.join(dir, 'home');
  await fs.mkdir(home);
  let aeordb = createFakeToolOutputDB();
  let outputID = 0;
  let store = new ToolOutputStore({
    aeordb,
    ...(inlineLimitBytes ? { inlineLimitBytes } : {}),
    idGenerator: () => `OUT${++outputID}`,
    clock: () => '2026-06-10T00:00:00.000Z',
  });
  let commandExecutor = new LocalCommandExecutionService({
    cwd: dir,
    shell: fsSyncExists('/bin/bash') ? '/bin/bash' : process.env.SHELL,
    env: {
      HOME: home,
      PATH: process.env.PATH,
    },
  });
  let processID = 0;
  let processManager = new ProcessManager({
    commandExecutor,
    toolOutputStore: store,
    tempRoot,
    defaultExecGraceMs: graceMs,
    ...(exitStdioGraceMs == null ? {} : { exitStdioGraceMs }),
    idGenerator: () => `PROC${++processID}`,
    clock: () => '2026-06-10T00:00:00.000Z',
    logger: { error() {} },
  });

  return {
    dir,
    aeordb,
    store,
    commandExecutor,
    processManager,
  };
}

async function waitFor(predicate, options = {}) {
  let deadline = Date.now() + (options.timeoutMs || 3000);
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      if (await predicate())
        return;
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, options.intervalMs || 20));
  }

  if (lastError)
    throw lastError;

  throw new Error('waitFor timed out');
}

function fsSyncExists(filePath) {
  return Boolean(filePath && fsSync.existsSync(filePath));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, '\'\\\'\'')}'`;
}

async function killPIDFromFile(pidPath) {
  let text;
  try {
    text = await fs.readFile(pidPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT')
      return;

    throw error;
  }

  let pid = Number(text.trim());
  if (!Number.isInteger(pid) || pid <= 1)
    return;

  try {
    process.kill(pid, 'SIGTERM');
  } catch (_error) {
    return;
  }

  try {
    await waitFor(async () => !isProcessAlive(pid), { timeoutMs: 500, intervalMs: 25 });
  } catch (_error) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (_killError) {}
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}
