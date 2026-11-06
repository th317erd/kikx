'use strict';

// =============================================================================
// The signature gate sits INSIDE loadPlugins, before any import (plan §5-S4)
// =============================================================================
// The gate's placement is the whole security property: three call sites load
// plugins (engine startup create-server.mjs, POST /install, POST /reload) and
// all three funnel through `loadPlugins`, so verifying there means unsigned or
// untrusted code is refused BEFORE `await import()` — not after execution has
// already begun.
//
// The matrix (mode x keys x signature state) is pinned against the REAL
// PluginRegistry with real Ed25519 keypairs, per the test protocol: no fake
// crypto, no mocked loader.

import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadPlugins } from '../../../src/core/plugins/plugin-loader.mjs';
import { PluginRegistry } from '../../../src/core/plugins/plugin-registry.mjs';
import { signPluginSignature } from '../../../src/core/plugins/plugin-signature.mjs';
import {
  KIKX_PLUGIN_SIGNATURE_MODE_PATH,
  KIKX_PLUGIN_SIGNING_PUBLIC_KEYS_PATH,
} from '../../../src/core/config/config-paths.mjs';

function quietLogger() {
  let lines = [];
  let record = (level) => (...args) => lines.push({ level, text: args.join(' ') });
  return { lines, log: record('log'), info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') };
}

// The loader resolves enforcement through the injected config service first —
// the same seam routes and create-server use — so tests express the mode as a
// config context instead of mutating process.env.
function signingConfig({ mode, keys }) {
  const values = {
    [KIKX_PLUGIN_SIGNATURE_MODE_PATH]: mode,
    [KIKX_PLUGIN_SIGNING_PUBLIC_KEYS_PATH]: keys,
  };
  return {
    has: (name) => name === 'config',
    require: (name) => {
      if (name !== 'config') throw new Error(`unknown service ${name}`);
      return { get: async (propertyPath) => values[propertyPath] ?? null };
    },
  };
}

function rawPublicKeyBase64(keyPair) {
  return keyPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
}

async function makePluginDir(manifest = { name: 'sig-fixture', version: '1.0.0' }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-loader-sig-'));
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(dir, 'manifest.json'), manifestBytes);
  await fs.writeFile(path.join(dir, 'index.mjs'),
    'export const pluginName = "sig-fixture";\n'
    + 'export function setup() { return () => {}; }\n');
  return { dir, manifestBytes };
}

test('required + valid signature: the plugin loads through the gate', async () => {
  const keypair = crypto.generateKeyPairSync('ed25519');
  const { dir, manifestBytes } = await makePluginDir();
  await fs.writeFile(path.join(dir, '.kikx-sig'),
    JSON.stringify(signPluginSignature(manifestBytes, keypair.privateKey, 'k1')));

  const registry = new PluginRegistry();
  const logger = quietLogger();
  await loadPlugins({
    pluginPaths: dir,
    registry,
    logger,
    context: signingConfig({ mode: 'required', keys: rawPublicKeyBase64(keypair) }),
  });

  assert.ok(registry._pluginRegistrations?.has('sig-fixture'),
    'a correctly signed plugin must load');
  assert.equal((registry._pluginLoadErrors || []).length, 0,
    `no load errors expected, got: ${JSON.stringify(registry._pluginLoadErrors)}`);

  await fs.rm(dir, { recursive: true, force: true });
});

test('required + unsigned: refused BEFORE import — signature:missing, never loaded', async () => {
  const keypair = crypto.generateKeyPairSync('ed25519');
  const { dir } = await makePluginDir();

  const registry = new PluginRegistry();
  await loadPlugins({
    pluginPaths: dir,
    registry,
    logger: quietLogger(),
    context: signingConfig({ mode: 'required', keys: rawPublicKeyBase64(keypair) }),
  });

  assert.equal(Boolean(registry._pluginRegistrations?.has('sig-fixture')), false,
    'unsigned code must never reach import() in required mode');
  const failures = registry._pluginLoadErrors || [];
  assert.ok(failures.some((failure) => String(failure.message || '').includes('signature:missing')),
    `expected a signature:missing failure, got ${JSON.stringify(failures)}`);

  await fs.rm(dir, { recursive: true, force: true });
});

test('required + zero configured keys: fail closed with signature:no-configured-key', async () => {
  const keypair = crypto.generateKeyPairSync('ed25519');
  const { dir, manifestBytes } = await makePluginDir();
  await fs.writeFile(path.join(dir, '.kikx-sig'),
    JSON.stringify(signPluginSignature(manifestBytes, keypair.privateKey, 'k1')));

  const registry = new PluginRegistry();
  await loadPlugins({
    pluginPaths: dir,
    registry,
    logger: quietLogger(),
    context: signingConfig({ mode: 'required', keys: '' }),
  });

  assert.equal(Boolean(registry._pluginRegistrations?.has('sig-fixture')), false,
    'a signature nobody can verify must not open the door');
  const failures = registry._pluginLoadErrors || [];
  assert.ok(failures.some((failure) => String(failure.message || '').includes('signature:no-configured-key')),
    `expected signature:no-configured-key, got ${JSON.stringify(failures)}`);

  await fs.rm(dir, { recursive: true, force: true });
});

test('required + wrong-key signature: refused with signature:invalid', async () => {
  const signer = crypto.generateKeyPairSync('ed25519');
  const stranger = crypto.generateKeyPairSync('ed25519');
  const { dir, manifestBytes } = await makePluginDir();
  await fs.writeFile(path.join(dir, '.kikx-sig'),
    JSON.stringify(signPluginSignature(manifestBytes, signer.privateKey, 'k1')));

  const registry = new PluginRegistry();
  await loadPlugins({
    pluginPaths: dir,
    registry,
    logger: quietLogger(),
    context: signingConfig({ mode: 'required', keys: rawPublicKeyBase64(stranger) }),
  });

  assert.equal(Boolean(registry._pluginRegistrations?.has('sig-fixture')), false);
  const failures = registry._pluginLoadErrors || [];
  assert.ok(failures.some((failure) => String(failure.message || '').includes('signature:invalid')),
    `expected signature:invalid, got ${JSON.stringify(failures)}`);

  await fs.rm(dir, { recursive: true, force: true });
});

test('unsafe mode: unsigned plugin loads, and the loader warns LOUDLY once', async () => {
  const { dir } = await makePluginDir();

  const registry = new PluginRegistry();
  const logger = quietLogger();
  await loadPlugins({
    pluginPaths: dir,
    registry,
    logger,
    context: signingConfig({ mode: 'unsafe', keys: '' }),
  });

  assert.ok(registry._pluginRegistrations?.has('sig-fixture'),
    'unsafe is the development bypass — it must keep working');
  const warnings = logger.lines.filter((line) => line.level === 'warn'
    && /signature verification disabled|KIKX_PLUGIN_SIGNATURE_MODE=unsafe/i.test(line.text));
  assert.equal(warnings.length, 1,
    `exactly one startup warning expected, got ${warnings.length}: ${JSON.stringify(warnings)}`);

  await fs.rm(dir, { recursive: true, force: true });
});
