'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AgentCwdStore } from '../../../src/core/agents/index.mjs';

test('AgentCwdStore persists per-agent per-session cwd and resolves relative changes like cd', async () => {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-cwd-store-'));
  let project = path.join(dir, 'project');
  let nested = path.join(project, 'nested');
  await fs.mkdir(nested, { recursive: true });

  let aeordb = createClient();
  let store = new AgentCwdStore({
    aeordb,
    baseCWD: dir,
    clock: () => 1000,
  });

  let initial = await store.getCWD('agent_1', 'ses_1');
  assert.equal(initial.cwd, dir);
  assert.equal(initial.configured, false);

  let changed = await store.setCWD('agent_1', 'ses_1', 'project');
  assert.equal(changed.cwd, project);
  assert.equal(changed.configured, true);

  let nestedChange = await store.setCWD('agent_1', 'ses_1', 'nested');
  assert.equal(nestedChange.cwd, nested);
  assert.equal(aeordb.files.get('/kikx/sessions/ses_1/values/agents/agent_1/cwd.json').valueText, nested);

  let otherSession = await store.getCWD('agent_1', 'ses_2');
  assert.equal(otherSession.cwd, dir);
  assert.equal(otherSession.configured, false);

  let cleared = await store.clearCWD('agent_1', 'ses_1');
  assert.equal(cleared.cwd, dir);
  assert.equal(cleared.configured, false);
});

test('AgentCwdStore rejects missing cwd directories', async () => {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-cwd-missing-'));
  let store = new AgentCwdStore({
    aeordb: createClient(),
    baseCWD: dir,
  });

  await assert.rejects(
    () => store.setCWD('agent_1', 'ses_1', 'missing'),
    /cwd does not exist/,
  );
});

function createClient() {
  return {
    files: new Map(),
    async getFile(filePath) {
      if (!this.files.has(filePath)) {
        let error = new Error('Not found');
        error.status = 404;
        throw error;
      }

      return this.files.get(filePath);
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
