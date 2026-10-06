'use strict';

// Behavioral coverage for the session working directory contract:
//
//   * a cwd set with `cwd-set` STICKS for the rest of that agent session -- for
//     both the shell/exec path and the file tools, and across a server restart;
//   * it does not leak into other sessions;
//   * `cwd-clear` returns to the configured default;
//   * the default is the service base cwd (user home / KIKX_CWD), NEVER the
//     directory the Kikx process happened to be launched from.
//
// These are the properties the session cwd exists for, so they are asserted end
// to end against the real AgentCwdStore + LocalFileAccessService rather than
// against a stub.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AgentCwdStore } from '../../../src/core/agents/index.mjs';
import { resolveFileToolParams } from '../../../src/core/tools/file-tool-cwd.mjs';
import { LocalFileAccessService, ProcessManager } from '../../../src/core/tools/index.mjs';

// The cwd -> tool wiring lives in the tool layer (the file tools run their
// params through `resolveFileToolParams`), so every read below goes through it,
// exactly like `read-file-tool._execute` does.
async function readViaTools(service, params, store, sessionID = SESSION_ID) {
  let context = {
    agent: { id: AGENT_ID },
    session: { id: sessionID },
    services: { agentCwdStore: store },
  };
  return await service.readFile(await resolveFileToolParams(params, context));
}

const AGENT_ID = 'agent_1';
const SESSION_ID = 'ses_1';

test('a cwd set mid-session sticks for the file tools of that session', async () => {
  let { base, project } = await createLayout();
  let store = createStore(base);

  let before = createFileService(base);
  assert.equal((await readViaTools(before, { path: 'note.txt' }, store)).content, 'from base');

  await store.setCWD(AGENT_ID, SESSION_ID, project);

  // A *new* service instance, exactly as the tool registry is rebuilt per turn.
  let after = createFileService(base);
  let result = await readViaTools(after, { path: 'note.txt' }, store);
  assert.equal(result.content, 'from project');
  assert.equal(result.path, path.join(project, 'note.txt'));
});

test('the session cwd survives a restart, the default does not come back', async () => {
  let { base, project } = await createLayout();
  let database = createDatabase();

  let first = new AgentCwdStore({ db: database, baseCWD: base });
  await first.setCWD(AGENT_ID, SESSION_ID, project);

  // Restart: same persisted documents, brand new store and services.
  let restarted = new AgentCwdStore({ db: database, baseCWD: base });
  let state = await restarted.getCWD(AGENT_ID, SESSION_ID);
  assert.equal(state.cwd, project);
  assert.equal(state.configured, true, 'the stored choice must still read as configured');

  let service = createFileService(base);
  assert.equal((await readViaTools(service, { path: 'note.txt' }, restarted)).content, 'from project');
});

test('an explicit per-call cwd still beats the stored session cwd', async () => {
  let { base, project } = await createLayout();
  let store = createStore(base);
  await store.setCWD(AGENT_ID, SESSION_ID, project);

  let service = createFileService(base);
  let result = await readViaTools(service, { path: 'note.txt', cwd: base }, store);

  assert.equal(result.content, 'from base');
});

test('cwd-clear returns the session to the default, not to the launch directory', async () => {
  let { base, project } = await createLayout();
  let store = createStore(base);
  await store.setCWD(AGENT_ID, SESSION_ID, project);

  let cleared = await store.clearCWD(AGENT_ID, SESSION_ID);
  assert.equal(cleared.cwd, base);
  assert.equal(cleared.configured, false);

  let service = createFileService(base);
  assert.equal((await readViaTools(service, { path: 'note.txt' }, store)).content, 'from base');

  // The launch directory must play no part in the fallback: a relative path
  // resolves inside the configured base no matter where the process started.
  assert.equal(store.baseCWD, path.resolve(base));
  assert.notEqual(store.baseCWD, path.resolve(process.cwd()));
});

test('one session cannot inherit another session cwd', async () => {
  let { base, project } = await createLayout();
  let store = createStore(base);
  await store.setCWD(AGENT_ID, SESSION_ID, project);

  let other = createFileService(base);
  assert.equal((await readViaTools(other, { path: 'note.txt' }, store, 'ses_2')).content, 'from base');
});

test('the shell path uses the stored session cwd, and an explicit cwd still wins', async () => {
  let { base, project } = await createLayout();
  let store = createStore(base);

  // `this.context` is an AppContext (has/require), the same shape the server
  // registers the store into; the call context carries agent/session only.
  let manager = Object.create(ProcessManager.prototype);
  manager.context = createAppContext({ agentCwdStore: store });
  let context = { agent: { id: AGENT_ID }, session: { id: SESSION_ID } };

  // Default: the resolved session cwd.
  let resolved = await manager.resolveExecutionParams({ command: 'pwd' }, context);
  assert.equal(resolved.cwd, store.baseCWD, 'unset session falls back to the default');

  await store.setCWD(AGENT_ID, SESSION_ID, project);
  resolved = await manager.resolveExecutionParams({ command: 'pwd' }, context);
  assert.equal(resolved.cwd, project);

  // An explicit request is never overridden by the session default.
  let explicit = await manager.resolveExecutionParams({ command: 'pwd', cwd: base }, context);
  assert.equal(explicit.cwd, base);

  // Without an agent/session context the params pass through untouched, so the
  // command service applies its own base cwd.
  let anonymous = await manager.resolveExecutionParams({ command: 'pwd' }, {});
  assert.equal(anonymous.cwd, undefined);
});

function createStore(base) {
  return new AgentCwdStore({ db: createDatabase(), baseCWD: base });
}

function createAppContext(services) {
  return {
    has: (name) => name in services,
    require: (name) => {
      if (!(name in services))
        throw new Error(`missing service: ${name}`);

      return services[name];
    },
  };
}

function createFileService(base) {
  return new LocalFileAccessService({ cwd: base });
}

async function createLayout() {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-session-cwd-'));
  let base = path.join(root, 'base');
  let project = path.join(root, 'project');
  await fs.mkdir(base, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(base, 'note.txt'), 'from base');
  await fs.writeFile(path.join(project, 'note.txt'), 'from project');
  return { base, project, root };
}

function createDatabase() {
  return {
    files: new Map(),
    async getFile(filePath) {
      if (!this.files.has(filePath)) {
        let error = new Error('Not found');
        error.status = 404;
        throw error;
      }

      return JSON.parse(JSON.stringify(this.files.get(filePath)));
    },
    async putFile(filePath, body) {
      this.files.set(filePath, JSON.parse(JSON.stringify(body)));
      return { path: filePath };
    },
    async deleteFile(filePath) {
      if (!this.files.delete(filePath)) {
        let error = new Error('Not found');
        error.status = 404;
        throw error;
      }
    },
  };
}
