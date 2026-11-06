'use strict';

import '../support/test-env.mjs';

// unloadPlugin() must run a plugin's onShutdown hook. It did not.
//
// THE DEFECT, measured on the live 3003 instance 2026-11-01:
// the Discord plugin opens a gateway websocket in onInit and closes it in onShutdown.
// A reload is implemented as: loadPlugins() sees the path is already registered and
// calls unloadPlugin(), then imports the module again and calls setup() + onInit().
// unloadPlugin() only ever called `record.teardown` - it never called
// `record.onShutdown`, which only shutdownPlugins() (the process-exit path) invoked.
//
// So every reload started a new gateway and left the old one running. The evidence was
// in /tmp/miri-3003.log: four independent exponential-backoff sequences interleaved
// (attempt 12,13,14 alongside 1,1,2, then 15,16,3,4 ...), each counting from its own
// attempt 1, against a single bot token. Discord answers duplicate sessions with close
// code 4000, which is the reconnect storm the log shows.
//
// The same defect duplicated messages: two live gateways both handled one MESSAGE_CREATE,
// both read seenMessage() as false, and both appended a frame. discord_message_frame's
// ON CONFLICT DO NOTHING collapsed the *table* row while both *frames* survived - six
// frames for four distinct Discord message ids on 3003.
//
// Nothing caught this because `grep -rn onShutdown spec/` returned ZERO hits before this
// file: the hook was declared, invoked in one of its two paths, and never tested.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadPlugins, unloadPlugin } from '../../src/core/plugins/plugin-loader.mjs';
import { PluginRegistry } from '../../src/core/plugins/index.mjs';

const silent = { warn() {}, info() {}, error() {} };

// A plugin whose only observable behaviour is a lifecycle trace on globalThis, so a
// test can see which hooks ran and in what order without a database or a socket.
async function writeProbePlugin(root, name) {
  let dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
  await fs.writeFile(path.join(dir, 'index.mjs'), `
    export const pluginName = ${JSON.stringify(name)};
    export function setup(provide) {
      provide(() => {});
      return {
        onInit() { (globalThis.__hookTrace ||= []).push('onInit'); },
        onShutdown() { (globalThis.__hookTrace ||= []).push('onShutdown'); },
        teardown() { (globalThis.__hookTrace ||= []).push('teardown'); },
      };
    }
  `);
  return dir;
}

function trace() {
  return globalThis.__hookTrace || [];
}

function resetTrace() {
  globalThis.__hookTrace = [];
}

test('unloadPlugin runs onShutdown, not just teardown', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-shutdown-'));
  try {
    await writeProbePlugin(root, 'probe-shutdown');
    let registry = new PluginRegistry();
    resetTrace();

    await loadPlugins({ pluginPaths: root, registry, logger: silent });
    assert.deepEqual(trace(), ['onInit'], 'loading should run onInit only');

    resetTrace();
    let removed = await unloadPlugin(registry, 'probe-shutdown', { logger: silent });
    assert.equal(removed, true, 'the plugin should have been registered');
    assert.ok(
      trace().includes('onShutdown'),
      'unloadPlugin must call onShutdown: a plugin that acquired a resource in onInit '
        + '(the Discord gateway opens a websocket there) is otherwise never told to '
        + 'release it, so every reload leaks one more live connection. Trace was: '
        + JSON.stringify(trace()),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('onShutdown runs before teardown', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-shutdown-'));
  try {
    await writeProbePlugin(root, 'probe-order');
    let registry = new PluginRegistry();
    resetTrace();

    await loadPlugins({ pluginPaths: root, registry, logger: silent });
    resetTrace();
    await unloadPlugin(registry, 'probe-order', { logger: silent });

    let t = trace();
    assert.ok(t.indexOf('onShutdown') !== -1 && t.indexOf('teardown') !== -1, 'both hooks should run: ' + JSON.stringify(t));
    assert.ok(
      t.indexOf('onShutdown') < t.indexOf('teardown'),
      'onShutdown must run first: it stops live work (timers, sockets) that teardown then '
        + 'dismantles. Trace was: ' + JSON.stringify(t),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a reload retires the previous instance instead of leaking it', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-shutdown-'));
  try {
    await writeProbePlugin(root, 'probe-reload');
    let registry = new PluginRegistry();
    resetTrace();

    await loadPlugins({ pluginPaths: root, registry, logger: silent });
    // A reload is the same call again against the same path - this is exactly what
    // POST /api/v1/plugins/reload does.
    resetTrace();
    await loadPlugins({ pluginPaths: root, registry, logger: silent });

    let t = trace();
    assert.ok(
      t.includes('onShutdown'),
      'the second load must shut the first instance down; otherwise its gateway, timers '
        + 'and subscriptions survive the reload. Trace was: ' + JSON.stringify(t),
    );
    assert.ok(
      t.lastIndexOf('onInit') > t.indexOf('onShutdown'),
      'the reload must end with a live instance: onInit after onShutdown. Trace was: ' + JSON.stringify(t),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a failing onShutdown still lets the unload finish', async () => {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-shutdown-'));
  try {
    let dir = path.join(root, 'probe-throwing');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
    await fs.writeFile(path.join(dir, 'index.mjs'), `
      export const pluginName = 'probe-throwing';
      export function setup(provide) {
        provide(() => {});
        return {
          onInit() { (globalThis.__hookTrace ||= []).push('onInit'); },
          onShutdown() { (globalThis.__hookTrace ||= []).push('onShutdown'); throw new Error('boom'); },
          teardown() { (globalThis.__hookTrace ||= []).push('teardown'); },
        };
      }
    `);

    let registry = new PluginRegistry();
    resetTrace();
    await loadPlugins({ pluginPaths: root, registry, logger: silent });
    resetTrace();

    let removed = await unloadPlugin(registry, 'probe-throwing', { logger: silent });
    assert.equal(removed, true, 'unload should still report success');
    assert.ok(
      trace().includes('teardown'),
      'a throwing onShutdown must not prevent teardown: the plugin is already detached '
        + 'from the registry, so skipping teardown would strand its resources. Trace was: '
        + JSON.stringify(trace()),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
