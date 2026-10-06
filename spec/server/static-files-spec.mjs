'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveWithin } from '../../src/server/static-files.mjs';
import { createServer } from '../../src/server/create-server.mjs';
import { AppContext } from '../../src/core/app/app-context.mjs';
import { PluginRegistry } from '../../src/core/plugins/index.mjs';
// Isolate from ambient plugin discovery (e.g. KIKX_PLUGIN_PATHS injected by a
// container/CI environment) so these fixture registries are not polluted by
// real plugins, which makes the assertions below env-dependent.
delete process.env.KIKX_PLUGIN_PATHS;

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      let address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function createPluginAssetFixture() {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-plugin-asset-'));
  await fs.mkdir(path.join(root, 'client'), { recursive: true });
  await fs.writeFile(path.join(root, 'client', 'agent-config-form.mjs'), 'export class KogAgentConfigForm {}');
  await fs.writeFile(path.join(root, 'package.json'), '{"main":"index.mjs"}');
  return root;
}

async function createPluginServer(pluginRegistry) {
  return await createServer({
    context: new AppContext({ aeordb: {}, pluginRegistry, builtInToolsRegistered: true }),
  });
}

test('resolveWithin resolves paths inside the root', () => {
  let root = '/srv/plugin/client';
  assert.equal(resolveWithin(root, 'agent-config-form.mjs'), path.join(root, 'agent-config-form.mjs'));
  assert.equal(resolveWithin(root, 'nested/thing.mjs'), path.join(root, 'nested', 'thing.mjs'));
});

test('resolveWithin rejects traversal, absolute escapes and null bytes', () => {
  let root = '/srv/plugin/client';
  assert.equal(resolveWithin(root, '../package.json'), null);
  assert.equal(resolveWithin(root, 'nested/../../package.json'), null);
  assert.equal(resolveWithin(root, '/etc/passwd'), null);
  assert.equal(resolveWithin(root, 'bad\0name'), null);
  assert.equal(resolveWithin(root, 42), null);
});

test('resolveWithin permits a path that resolves back to the root itself', () => {
  let root = '/srv/plugin/client';
  assert.equal(resolveWithin(root, '.'), root);
});

test('GET /api/v1/client-components includes plugin agent-config-form descriptors', async () => {
  let pluginRegistry = new PluginRegistry({ logger: { warn() {} } });
  pluginRegistry.registerAgentConfigForm('codex-agent', {
    tagName: 'kog-agent-config-form',
    moduleURL: '/api/v1/plugin-assets/kikx-plugin-codex/agent-config-form.mjs',
  });
  let server = await createPluginServer(pluginRegistry);
  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/client-components`);
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.data.components, [
      {
        kind: 'agent-config-form',
        pluginID: 'codex-agent',
        tagName: 'kog-agent-config-form',
        moduleURL: '/api/v1/plugin-assets/kikx-plugin-codex/agent-config-form.mjs',
      },
    ]);
  } finally {
    await close(server);
  }
});

test('GET /api/v1/plugin-assets serves a plugin client asset with JS MIME type', async () => {
  let pluginRoot = await createPluginAssetFixture();
  let pluginRegistry = new PluginRegistry({ logger: { warn() {} } });
  pluginRegistry.registerPluginPath('kikx-plugin-codex', pluginRoot, [ 'codex-agent' ]);
  let server = await createPluginServer(pluginRegistry);
  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/plugin-assets/kikx-plugin-codex/agent-config-form.mjs`);
    let body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(body, 'export class KogAgentConfigForm {}');

    // Resolvable by agent provider ID as well as plugin folder name.
    let byProvider = await fetch(`${baseURL}/api/v1/plugin-assets/codex-agent/agent-config-form.mjs`);
    assert.equal(byProvider.status, 200);
  } finally {
    await close(server);
    await fs.rm(pluginRoot, { recursive: true, force: true });
  }
});

test('GET /api/v1/plugin-assets rejects traversal and unknown plugins', async () => {
  let pluginRoot = await createPluginAssetFixture();
  let pluginRegistry = new PluginRegistry({ logger: { warn() {} } });
  pluginRegistry.registerPluginPath('kikx-plugin-codex', pluginRoot, []);
  let server = await createPluginServer(pluginRegistry);
  let baseURL = await listen(server);

  try {
    // %2f keeps the URL parser from collapsing the dot segments, so the
    // decoded relative path really does contain '..' when it reaches the route.
    let rawTraversal = await fetch(`${baseURL}/api/v1/plugin-assets/kikx-plugin-codex/%2e%2e%2fpackage.json`);
    assert.equal(rawTraversal.status, 403);
    assert.equal(await rawTraversal.text(), 'Forbidden');

    let nestedTraversal = await fetch(`${baseURL}/api/v1/plugin-assets/kikx-plugin-codex/client/%2e%2e%2f%2e%2e%2fpackage.json`);
    assert.equal(nestedTraversal.status, 403);

    let unknownPlugin = await fetch(`${baseURL}/api/v1/plugin-assets/does-not-exist/agent-config-form.mjs`);
    assert.equal(unknownPlugin.status, 404);

    let missingFile = await fetch(`${baseURL}/api/v1/plugin-assets/kikx-plugin-codex/missing.mjs`);
    assert.equal(missingFile.status, 404);
  } finally {
    await close(server);
    await fs.rm(pluginRoot, { recursive: true, force: true });
  }
});
