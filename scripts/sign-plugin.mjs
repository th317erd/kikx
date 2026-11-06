#!/usr/bin/env node
'use strict';

// =============================================================================
// sign-plugin — create the Ed25519 material and .kikx-sig files (campaign S4)
// =============================================================================
//   node scripts/sign-plugin.mjs --generate [--out <dir>]
//       New keypair. Private key written 0600 to --out (default
//       ~/.local/share/kikx/plugin-signing), public raw key printed for
//       KIKX_PLUGIN_SIGNING_PUBLIC_KEYS. THE PRIVATE KEY NEVER ENTERS THE REPO.
//
//   node scripts/sign-plugin.mjs [--key <pem>] <pluginDir...>
//       Sign each directory's manifest.json into <dir>/.kikx-sig.
//       --key defaults to $KIKX_PLUGIN_SIGNING_PRIVATE_KEY_FILE.
//
//   node scripts/sign-plugin.mjs --all-bundled [--key <pem>]
//       Every directory under the bundled plugin root (src/plugins/). An empty
//       root is a no-op, not an error — Kikx currently ships no bundled
//       plugins; operator-installed plugins are signed by the operator.
//
// The envelope and verification rules live in src/core/plugins/plugin-signature.mjs.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MANIFEST_FILE_NAME,
  SIGNATURE_FILE_NAME,
  signPluginSignature,
} from '../src/core/plugins/plugin-signature.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUNDLED_ROOT = path.join(REPO_ROOT, 'src', 'plugins');
const DEFAULT_KEY_DIR = path.join(os.homedir(), '.local', 'share', 'kikx', 'plugin-signing');

function usage() {
  console.log([
    'Usage:',
    '  node scripts/sign-plugin.mjs --generate [--out <dir>]',
    '  node scripts/sign-plugin.mjs [--key <pem-file>] <pluginDir...>',
    '  node scripts/sign-plugin.mjs --all-bundled [--key <pem-file>]',
    '',
    `Private key env fallback: KIKX_PLUGIN_SIGNING_PRIVATE_KEY_FILE (default ${path.join(DEFAULT_KEY_DIR, 'plugin-signing.key')})`,
  ].join('\n'));
}

function rawPublicKeyBase64(keyPair) {
  return keyPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
}

async function generate(outDir) {
  const dir = outDir || DEFAULT_KEY_DIR;
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const keyPair = crypto.generateKeyPairSync('ed25519');
  const keyPath = path.join(dir, 'plugin-signing.key');
  const pubPath = path.join(dir, 'plugin-signing.pub');
  const privatePem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  await fs.writeFile(keyPath, privatePem, { mode: 0o600 });
  const publicRaw = rawPublicKeyBase64(keyPair);
  await fs.writeFile(pubPath, `${publicRaw}\n`, { mode: 0o644 });
  console.log(`private key: ${keyPath} (mode 600 — NEVER commit this file)`);
  console.log(`public key:  ${pubPath}`);
  console.log(`KIKX_PLUGIN_SIGNING_PUBLIC_KEYS=${publicRaw}`);
}

async function loadPrivateKey(keyPath) {
  const resolved = keyPath || process.env.KIKX_PLUGIN_SIGNING_PRIVATE_KEY_FILE
    || path.join(DEFAULT_KEY_DIR, 'plugin-signing.key');
  const pem = await fs.readFile(resolved, 'utf8');
  return crypto.createPrivateKey(pem);
}

async function signDirectory(dir, privateKey, keyID) {
  const manifestPath = path.join(dir, MANIFEST_FILE_NAME);
  const manifestBytes = await fs.readFile(manifestPath);
  const doc = signPluginSignature(manifestBytes, privateKey, keyID);
  await fs.writeFile(path.join(dir, SIGNATURE_FILE_NAME), `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`signed: ${path.join(dir, SIGNATURE_FILE_NAME)} (keyID=${doc.keyID || 'none'})`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    usage();
    return args.length === 0 ? 1 : 0;
  }

  let keyPath = null;
  const dirs = [];
  let allBundled = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--generate') {
      await generate(args[index + 1] === '--out' ? args[index + 2] : null);
      return 0;
    }
    if (args[index] === '--key') {
      keyPath = args[index + 1];
      index++;
      continue;
    }
    if (args[index] === '--all-bundled') {
      allBundled = true;
      continue;
    }
    dirs.push(args[index]);
  }

  const targets = allBundled
    ? (await fs.readdir(BUNDLED_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(BUNDLED_ROOT, entry.name)))
    : dirs;

  if (targets.length === 0) {
    console.log(allBundled
      ? `no bundled plugins under ${BUNDLED_ROOT} — nothing to sign (operator plugins are signed by the operator)`
      : 'no plugin directories given');
    usage();
    return allBundled ? 0 : 1;
  }

  const privateKey = await loadPrivateKey(keyPath);
  const keyID = path.basename(
    process.env.KIKX_PLUGIN_SIGNING_PRIVATE_KEY_FILE || path.join(DEFAULT_KEY_DIR, 'plugin-signing.key'),
    '.key',
  ).replace(/[^A-Za-z0-9_-]/g, '_');

  for (const dir of targets)
    await signDirectory(dir, privateKey, keyID);
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`sign-plugin failed: ${error.message}`);
    process.exitCode = 1;
  });
