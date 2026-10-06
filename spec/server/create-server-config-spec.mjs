'use strict';

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  AEORDB_URL_PATH,
  ConfigStore,
  KIKX_CWD_PATH,
  createConfigStore,
} from '../../src/core/config/index.mjs';
import { AeorDBClient } from '../../src/core/aeordb/aeordb-client.mjs';
import { CompactionService } from '../../src/core/compaction/index.mjs';
import { createServer } from '../../src/server/create-server.mjs';

const ENV_KEYS = [
  'AEORDB_URL',
  'AEORDB_TOKEN',
  'KIKX_PLUGIN_PATHS',
  'AEOR_WEB_COMPONENTS_DIR',
  'KIKX_CONTEXT_WINDOW_TOKENS',
  'KIKX_COMPACTION_AGENT_ID',
];

// Capture the exact previous values (including "absent"), apply the fixture,
// and return a restorer. `t.after` runs it even when an assertion fails.
function applyEnvironment(values) {
  let previous = new Map();
  for (let key of ENV_KEYS)
    previous.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);

  for (let [ key, value ] of Object.entries(values)) {
    if (value === undefined)
      delete process.env[key];
    else
      process.env[key] = value;
  }

  return () => {
    for (let [ key, value ] of previous) {
      if (value === undefined)
        delete process.env[key];
      else
        process.env[key] = value;
    }
  };
}

// AeorDBClient reads `response.ok`/`response.status`/`response.text()`. Returning
// a bare `{ ok: true }` rejects background recovery promises with "response.text
// is not a function", so provide the minimal viable Response shape.
async function stubFetch() {
  return {
    ok: true,
    status: 200,
    async text() {
      return '';
    },
  };
}

test('createServer resolves ambient process env through the ConfigStore', async (t) => {
  let restore = applyEnvironment({
    AEORDB_URL: 'http://env.aeordb.test:9999',
    AEORDB_TOKEN: 'env-token-abc',
    KIKX_PLUGIN_PATHS: '',
    AEOR_WEB_COMPONENTS_DIR: '/tmp/kikx-env-components',
    KIKX_CONTEXT_WINDOW_TOKENS: '4096',
    KIKX_COMPACTION_AGENT_ID: 'agent-from-env',
  });
  t.after(restore);

  let server = await createServer({ fetchImpl: stubFetch });
  let context = server.kikxContext;

  let config = context.get('config');
  assert.ok(config instanceof ConfigStore, 'context.set("config") must store the resolved ConfigStore');
  assert.equal(await config.get(AEORDB_URL_PATH), 'http://env.aeordb.test:9999');

  let aeordb = context.require('aeordb');
  assert.equal(aeordb.baseURL, 'http://env.aeordb.test:9999');
  assert.equal(aeordb.token, 'env-token-abc');

  let compaction = context.require('compactionService');
  assert.equal(compaction.compactionAgentID, 'agent-from-env');
  assert.equal(compaction.contextWindowTokens, 4096);
});

test('options.config takes precedence over ambient process env', async (t) => {
  let restore = applyEnvironment({
    AEORDB_URL: 'http://env.aeordb.test:9999',
    AEORDB_TOKEN: 'env-token-abc',
    KIKX_PLUGIN_PATHS: '',
    AEOR_WEB_COMPONENTS_DIR: '/tmp/kikx-env-components',
    KIKX_CONTEXT_WINDOW_TOKENS: '4096',
    KIKX_COMPACTION_AGENT_ID: 'agent-from-env',
  });
  t.after(restore);

  let injected = await createConfigStore({
    env: {
      AEORDB_URL: 'http://injected.aeordb.test:1111',
      AEORDB_TOKEN: 'injected-token',
      KIKX_COMPACTION_AGENT_ID: 'agent-from-config',
      KIKX_CONTEXT_WINDOW_TOKENS: '2048',
    },
  });

  let server = await createServer({
    config: injected,
    fetchImpl: stubFetch,
  });
  let context = server.kikxContext;

  // Same store object, not a freshly built one, and its values win over env.
  assert.equal(context.get('config'), injected);
  assert.equal(context.require('aeordb').baseURL, 'http://injected.aeordb.test:1111');
  assert.equal(context.require('aeordb').token, 'injected-token');
  assert.equal(context.require('compactionService').compactionAgentID, 'agent-from-config');
  assert.equal(context.require('compactionService').contextWindowTokens, 2048);
});

// Parity requirement: direct construction (no `createServer`) must still honour
// the ambient environment, while explicit options always win.
test('direct construction falls back to ambient env but explicit options win', async (t) => {
  let restore = applyEnvironment({
    AEORDB_URL: 'http://direct.aeordb.test:2222',
    AEORDB_TOKEN: 'direct-token',
    KIKX_COMPACTION_AGENT_ID: 'agent-direct',
  });
  t.after(restore);

  let ambientClient = new AeorDBClient({ fetchImpl: stubFetch });
  assert.equal(ambientClient.baseURL, 'http://direct.aeordb.test:2222');
  assert.equal(ambientClient.token, 'direct-token');
  assert.equal(new CompactionService({}).compactionAgentID, 'agent-direct');

  let explicitClient = new AeorDBClient({
    baseURL: 'http://explicit.aeordb.test',
    token: 'explicit-token',
    fetchImpl: stubFetch,
  });
  assert.equal(explicitClient.baseURL, 'http://explicit.aeordb.test');
  assert.equal(explicitClient.token, 'explicit-token');
  assert.equal(new CompactionService({ compactionAgentID: 'agent-explicit' }).compactionAgentID, 'agent-explicit');
});

// Kikx runs as a global service, so its working directory must come from the
// KIKX_CWD config (falling back to the user's home), never the launcher's CWD.
// The same resolved value must feed every service that defaults a cwd.
test('createServer resolves baseCWD from KIKX_CWD for file, command, and agent cwd', async () => {
  let dir = path.resolve('/tmp/kikx-cwd-config');
  let injected = await createConfigStore({ env: { KIKX_CWD: dir } });

  assert.equal(await injected.get(KIKX_CWD_PATH), dir);

  let server = await createServer({
    config: injected,
    fetchImpl: stubFetch,
  });
  let context = server.kikxContext;

  assert.equal(context.require('fileAccess').cwd, dir);
  assert.equal(context.require('commandExecutor').cwd, dir);
  assert.equal(context.require('agentCwdStore').baseCWD, dir);
});

test('a relative KIKX_CWD is resolved once instead of leaking into the services', async () => {
  let injected = await createConfigStore({ env: { KIKX_CWD: 'kikx-relative-workspace' } });
  let server = await createServer({
    config: injected,
    fetchImpl: stubFetch,
  });
  let context = server.kikxContext;

  // The exact base is whatever the process cwd is; what matters is that it was
  // resolved here (once) so the services cannot resolve it against a *different*
  // cwd later.
  let expected = path.resolve('kikx-relative-workspace');
  assert.equal(path.isAbsolute(context.require('fileAccess').cwd), true);
  assert.equal(context.require('fileAccess').cwd, expected);
  assert.equal(context.require('commandExecutor').cwd, expected);
  assert.equal(context.require('agentCwdStore').baseCWD, expected);
});

test('options.cwd takes precedence over the KIKX_CWD config', async () => {
  let configuredDir = path.resolve('/tmp/kikx-cwd-configured');
  let explicitDir = path.resolve('/tmp/kikx-cwd-explicit');
  let injected = await createConfigStore({ env: { KIKX_CWD: configuredDir } });

  let server = await createServer({
    config: injected,
    cwd: explicitDir,
    fetchImpl: stubFetch,
  });
  let context = server.kikxContext;

  assert.equal(context.require('fileAccess').cwd, explicitDir);
  assert.equal(context.require('commandExecutor').cwd, explicitDir);
  assert.equal(context.require('agentCwdStore').baseCWD, explicitDir);
});
