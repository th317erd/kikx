'use strict';

import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PluginRegistry } from '../../../src/core/plugins/index.mjs';
import {
  ExecScriptTool,
  LocalCommandExecutionService,
  ProcessManager,
  registerBuiltInTools,
  ToolOutputStore,
} from '../../../src/core/tools/index.mjs';

test('registerBuiltInTools registers exec-script beside exec', () => {
  let registry = new PluginRegistry({ logger: { warn() {} } });
  registerBuiltInTools(registry);

  assert.equal(registry.getTool('exec-script'), ExecScriptTool);
  assert.equal(
    registry.getFrameComponents().get('ScriptToolFrame')?.tagName,
    'kikx-script-tool-use',
  );
});

test('ExecScriptTool runs a script through the managed process pipeline and cleans up', async () => {
  let harness = await createHarness({ graceMs: 2000 });
  let tool = new ExecScriptTool({
    ...harness.context,
    services: { processManager: harness.processManager },
  });

  try {
    let result = await tool.execute({
      script: 'console.log("hello from script")',
      packageJson: { type: 'module', name: 'cleanup-check' },
    });

    assert.equal(result.completedWithinGrace, true);
    assert.equal(result.status, 'completed');
    assert.equal(result.result.exitCode, 0);
    assert.equal(result.result.stdout, 'hello from script\n');
    assert.equal(result.result.stderr, '');
    await assert.rejects(() => fs.stat(result.cwd), /ENOENT/);
  } finally {
    await fs.rm(harness.dir, { recursive: true, force: true });
  }
});

test('ExecScriptTool supports multiple files, args, stdin, env, and a kept workspace', async () => {
  let harness = await createHarness({ graceMs: 2000 });
  let tool = new ExecScriptTool({
    ...harness.context,
    services: { processManager: harness.processManager },
  });
  let script = [
    'import { readFileSync } from "node:fs";',
    'import { message } from "./lib/helper.mjs";',
    'let stdin = readFileSync(0, "utf8").trim();',
    'console.log([ message, process.argv[2], process.env.KIKX_TEST_VALUE, stdin, process.cwd() ].join("|"));',
  ].join('\n');

  try {
    let result = await tool.execute({
      script,
      files: [
        { path: 'package.json', content: '{"type":"module","name":"multi-file-check"}' },
        { path: 'lib/helper.mjs', content: 'export const message = "helper";\n' },
      ],
      args: [ 'argument with spaces' ],
      stdin: 'from-stdin\n',
      env: { KIKX_TEST_VALUE: 'from-env' },
      keepTempDir: true,
    });

    assert.equal(result.result.exitCode, 0);
    assert.equal(
      result.result.stdout,
      `helper|argument with spaces|from-env|from-stdin|${path.resolve(result.cwd)}\n`,
    );
    assert.equal(
      await fs.readFile(path.join(result.cwd, 'lib', 'helper.mjs'), 'utf8'),
      'export const message = "helper";\n',
    );
    assert.match(await fs.readFile(path.join(result.cwd, 'package.json'), 'utf8'), /multi-file-check/);
    await fs.rm(result.cwd, { recursive: true, force: true });
  } finally {
    await fs.rm(harness.dir, { recursive: true, force: true });
  }
});

test('ExecScriptTool runs arbitrary files through an explicit start command', async () => {
  let harness = await createHarness({ graceMs: 2000 });
  let tool = new ExecScriptTool({
    ...harness.context,
    services: { processManager: harness.processManager },
  });

  try {
    let result = await tool.execute({
      files: [
        {
          path: 'run.sh',
          content: 'printf "bash:%s\\n" "$1"\ncat data.txt\n',
        },
        { path: 'data.txt', content: 'payload\n' },
      ],
      start: 'bash run.sh started',
      keepTempDir: true,
    });

    assert.equal(result.result.exitCode, 0);
    assert.equal(result.result.stdout, 'bash:started\npayload\n');
    assert.equal(await fs.readFile(path.join(result.cwd, 'data.txt'), 'utf8'), 'payload\n');
    await assert.rejects(() => fs.stat(path.join(result.cwd, 'index.mjs')), /ENOENT/);
    await fs.rm(result.cwd, { recursive: true, force: true });
  } finally {
    await fs.rm(harness.dir, { recursive: true, force: true });
  }
});

test('ExecScriptTool accepts packageJson as a JSON string', async () => {
  let harness = await createHarness({ graceMs: 2000 });
  let tool = new ExecScriptTool({
    ...harness.context,
    services: { processManager: harness.processManager },
  });

  try {
    let result = await tool.execute({
      script: 'console.log("string-package")',
      packageJson: '{"type":"module","name":"string-package-check"}',
    });

    assert.equal(result.result.exitCode, 0);
    assert.equal(result.result.stdout, 'string-package\n');
  } finally {
    await fs.rm(harness.dir, { recursive: true, force: true });
  }
});

test('ExecScriptTool uses packageJson.main or an explicit entry path', async () => {
  let harness = await createHarness({ graceMs: 2000 });
  let tool = new ExecScriptTool({
    ...harness.context,
    services: { processManager: harness.processManager },
  });

  try {
    let fromMain = await tool.execute({
      script: 'console.log("main-entry")',
      packageJson: { type: 'module', main: 'src/main.mjs' },
      keepTempDir: true,
    });
    assert.equal(fromMain.result.stdout, 'main-entry\n');
    assert.equal(await fs.readFile(path.join(fromMain.cwd, 'src', 'main.mjs'), 'utf8'), 'console.log("main-entry")');
    await fs.rm(fromMain.cwd, { recursive: true, force: true });

    let explicit = await tool.execute({
      script: 'console.log("explicit-entry")',
      packageJson: { type: 'module', main: 'ignored.mjs' },
      entry: 'bin/run.mjs',
      keepTempDir: true,
    });
    assert.equal(explicit.result.stdout, 'explicit-entry\n');
    assert.equal(await fs.readFile(path.join(explicit.cwd, 'bin', 'run.mjs'), 'utf8'), 'console.log("explicit-entry")');
    await fs.rm(explicit.cwd, { recursive: true, force: true });
  } finally {
    await fs.rm(harness.dir, { recursive: true, force: true });
  }
});

test('ExecScriptTool rejects unsafe or conflicting workspace paths', async () => {
  let harness = await createHarness({ graceMs: 10 });
  let tool = new ExecScriptTool({
    ...harness.context,
    services: { processManager: harness.processManager },
  });

  try {
    await assert.rejects(
      () => tool.execute({ script: 'console.log(1)', entry: '../escape.mjs' }),
      /entry must stay inside the temporary script workspace/,
    );
    await assert.rejects(
      () => tool.execute({
        script: 'console.log(1)',
        files: [ { path: '/tmp/escape.txt', content: 'x' } ],
      }),
      /files\[0\]\.path must be relative/,
    );
    await assert.rejects(
      () => tool.execute({
        script: 'console.log(1)',
        files: [ { path: '../escape.txt', content: 'x' } ],
      }),
      /files\[0\]\.path must stay inside/,
    );
    await assert.rejects(
      () => tool.execute({
        script: 'console.log(1)',
        packageJson: { type: 'module' },
        files: [ { path: 'package.json', content: '{"type":"module"}' } ],
      }),
      /files cannot contain package.json/,
    );
    await assert.rejects(
      () => tool.execute({ start: 'bash run.sh', script: 'console.log(1)' }),
      /either start or script/,
    );
    await assert.rejects(
      () => tool.execute({ files: [ { path: 'run.sh', content: 'echo hi' } ] }),
      /requires start .* or script/,
    );
    await assert.rejects(
      () => tool.execute({ start: 'bash run.sh', entry: 'run.sh' }),
      /entry is only valid with the legacy script shorthand/,
    );
    await assert.rejects(
      () => tool.execute({
        script: 'console.log(1)',
        files: [
          { path: 'same.txt', content: 'one' },
          { path: 'same.txt', content: 'two' },
        ],
      }),
      /files contains a duplicate path/,
    );
  } finally {
    await fs.rm(harness.dir, { recursive: true, force: true });
  }
});

test('ExecScriptTool installs only when dependencies or an npm lockfile require it', async () => {
  let captured = [];
  let fakeProcessManager = {
    async start(params) {
      captured.push(params);
      return { status: 'running', processID: `PROC_FAKE_${captured.length}` };
    },
  };
  let tool = new ExecScriptTool({
    agent: { id: 'agent_1' },
    session: { id: 'ses_1' },
    services: { processManager: fakeProcessManager },
  });

  try {
    await tool.execute({
      script: 'console.log(1)',
      packageJson: { type: 'module', name: 'no-deps' },
      keepTempDir: true,
    });
    assert.doesNotMatch(captured[0].command, /npm (?:ci|install)/);

    await tool.execute({
      script: 'console.log(1)',
      packageJson: { type: 'module', dependencies: { example: '1.0.0' } },
      keepTempDir: true,
    });
    assert.match(captured[1].command, /npm install --no-audit --no-fund --loglevel=error/);

    await tool.execute({
      script: 'console.log(1)',
      packageJson: { type: 'module' },
      files: [ { path: 'package-lock.json', content: '{}' } ],
      keepTempDir: true,
    });
    assert.match(captured[2].command, /npm ci --no-audit --no-fund --loglevel=error/);

    await tool.execute({
      script: 'console.log(1)',
      packageJson: { type: 'module', dependencies: { example: '1.0.0' } },
      install: false,
      keepTempDir: true,
    });
    assert.doesNotMatch(captured[3].command, /npm (?:ci|install)/);

    assert.equal(captured[0].env.KIKX_SCRIPT_ENTRY, 'index.mjs');
    assert.equal(captured[0].env.KIKX_SCRIPT_START, captured[0].command.split('\n').at(-1));
    assert.equal(captured[0].env.KIKX_SCRIPT_DIR, captured[0].cwd);
  } finally {
    for (let params of captured) {
      if (params?.cwd)
        await fs.rm(params.cwd, { recursive: true, force: true });
    }
  }
});

test('ExecScriptTool exposes the session cwd to scripts without changing the script cwd', async () => {
  let captured = null;
  let fakeProcessManager = {
    async start(params) {
      captured = params;
      return { status: 'running', processID: 'PROC_FAKE_CWD' };
    },
  };
  let workspace = '/home/wyatt/Projects/example';
  let tool = new ExecScriptTool({
    agent: { id: 'agent_1' },
    session: { id: 'ses_1' },
    services: {
      processManager: fakeProcessManager,
      agentCwdStore: {
        async getCWD() {
          return { cwd: workspace, configured: true };
        },
      },
    },
  });

  try {
    await tool.execute({
      script: 'console.log(process.env.KIKX_SESSION_CWD)',
      keepTempDir: true,
    });

    assert.equal(captured.env.KIKX_SESSION_CWD, workspace);
    assert.notEqual(captured.cwd, workspace);
  } finally {
    if (captured?.cwd)
      await fs.rm(captured.cwd, { recursive: true, force: true });
  }
});

test('ExecScriptTool requires a process manager service', async () => {
  let tool = new ExecScriptTool();

  await assert.rejects(
    () => tool.execute({ script: 'console.log(1)' }),
    /exec-script requires a processManager service/,
  );
});

async function createHarness({ graceMs = 0 } = {}) {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-script-harness-'));
  let home = path.join(dir, 'home');
  await fs.mkdir(home);
  let aeordb = createFakeToolOutputDB();
  let outputID = 0;
  let processID = 0;
  let store = new ToolOutputStore({
    aeordb,
    idGenerator: () => `OUT${++outputID}`,
    clock: () => '2026-06-10T00:00:00.000Z',
  });
  let commandExecutor = new LocalCommandExecutionService({
    cwd: dir,
    shell: fsSync.existsSync('/bin/bash') ? '/bin/bash' : process.env.SHELL,
    env: {
      HOME: home,
      PATH: process.env.PATH,
    },
  });
  let processManager = new ProcessManager({
    commandExecutor,
    toolOutputStore: store,
    tempRoot: path.join(dir, 'processes'),
    defaultExecGraceMs: graceMs,
    idGenerator: () => `PROC${++processID}`,
    clock: () => '2026-06-10T00:00:00.000Z',
    logger: { error() {} },
  });

  return {
    dir,
    processManager,
    context: {
      agent: { id: 'agent_1' },
      session: { id: 'ses_1' },
      frame: { id: 'frm_1' },
    },
  };
}

function createFakeToolOutputDB() {
  let files = new Map();
  return {
    files,
    async putFile(filePath, body) {
      files.set(filePath, body);
      return { path: filePath };
    },
    async getFile(filePath, options = {}) {
      if (!files.has(filePath)) {
        let error = new Error(`missing file: ${filePath}`);
        error.status = 404;
        throw error;
      }
      let value = files.get(filePath);
      return options.expectJSON === false ? String(value ?? '') : value;
    },
  };
}
