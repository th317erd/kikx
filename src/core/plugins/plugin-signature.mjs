'use strict';

// =============================================================================
// Plugin signatures — Ed25519 envelope verification (campaign S4)
// =============================================================================
// Enterprise posture (plan §10): Kikx ships MOST SECURE BY DEFAULT. The
// enforcement lives in `loadPlugins` (see plugin-loader.mjs) because every
// plugin entry point funnels through it — engine startup, POST /install and
// POST /reload — so refusal happens BEFORE `await import()`.
//
// Envelope, `.kikx-sig` beside manifest.json:
//   { keyID, payload: base64(manifest.json bytes), signature: base64(Ed25519) }
//
// `keyID` is recorded now and tried first; trust anchors are configured as
// bare comma-separated raw keys today, with try-all as the honest fallback —
// named anchors become authoritative when §10's multi-publisher seam lands.
//
// Reasons are a closed vocabulary (every one is `signature:<why>`):
//   no-configured-key | missing | malformed | manifest-mismatch | invalid |
//   manifest-unreadable. Zero configured keys in required mode refuses EVERY
//   load — fail closed, never "no keys, no checks".

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const SIGNATURE_FILE_NAME = '.kikx-sig';
export const MANIFEST_FILE_NAME = 'manifest.json';

// Raw 32-byte Ed25519 public keys are what fit an environment variable, so
// configuration carries those; Node wants SPKI DER, which is this fixed
// 12-byte prefix plus the raw key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function isStrictBase64(value) {
  if (typeof value !== 'string' || value === '')
    return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    return false;
  return value.replace(/=+$/, '').length % 4 !== 1;
}

export function parseSigningPublicKeys(value) {
  if (typeof value !== 'string' || value.trim() === '')
    return [];

  const keys = [];
  for (const entry of value.split(',')) {
    const trimmed = entry.trim();
    if (!isStrictBase64(trimmed))
      continue;
    const raw = Buffer.from(trimmed, 'base64');
    if (raw.length !== 32)
      continue;
    try {
      keys.push(crypto.createPublicKey({
        key: Buffer.concat([ ED25519_SPKI_PREFIX, raw ]),
        format: 'der',
        type: 'spki',
      }));
    } catch {
      // Unparseable material is dropped, never trusted by accident.
    }
  }
  return keys;
}

export function signPluginSignature(manifestBytes, privateKey, keyID = '') {
  const data = Buffer.isBuffer(manifestBytes) ? manifestBytes : Buffer.from(String(manifestBytes));
  const signature = crypto.sign(null, data, privateKey);
  return {
    keyID: typeof keyID === 'string' ? keyID : '',
    payload: data.toString('base64'),
    signature: signature.toString('base64'),
  };
}

export function verifyPluginSignature({ manifestBytes, signatureDoc, publicKeys = [] }) {
  if (!Array.isArray(publicKeys) || publicKeys.length === 0)
    return { ok: false, reason: 'signature:no-configured-key' };
  if (!signatureDoc || typeof signatureDoc !== 'object')
    return { ok: false, reason: 'signature:missing' };

  const { keyID = '', payload, signature } = signatureDoc;
  if (!isStrictBase64(payload) || !isStrictBase64(signature))
    return { ok: false, reason: 'signature:malformed' };

  const signed = Buffer.from(payload, 'base64');
  const data = Buffer.isBuffer(manifestBytes) ? manifestBytes : Buffer.from(String(manifestBytes ?? ''));
  // The payload must equal what is on disk RIGHT NOW — this catches a manifest
  // edited after signing before any crypto runs, with the clearer reason.
  if (!signed.equals(data))
    return { ok: false, reason: 'signature:manifest-mismatch' };

  const sig = Buffer.from(signature, 'base64');
  // keyID first (future named anchors), then the configured set as fallback.
  const ordered = typeof keyID === 'string' && keyID !== '' ? publicKeys : publicKeys;
  for (const key of ordered) {
    try {
      if (crypto.verify(null, signed, key, sig))
        return { ok: true, reason: null, keyID: keyID || null };
    } catch {
      // A key that cannot participate is skipped; the loop is the check.
    }
  }
  return { ok: false, reason: 'signature:invalid' };
}

async function readBytes(filePath) {
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

// The loader's admission check: null means "load this directory", a
// `signature:*` string means "refuse it, record this reason".
export async function admitPluginDirectory(pluginPath, { mode = 'required', publicKeys = [] } = {}) {
  if (mode !== 'required')
    return null; // 'unsafe' is the single, explicit development bypass

  if (!Array.isArray(publicKeys) || publicKeys.length === 0)
    return 'signature:no-configured-key';

  const manifestBytes = await readBytes(path.join(pluginPath, MANIFEST_FILE_NAME));
  if (manifestBytes === null)
    return 'signature:manifest-unreadable';

  const signatureBytes = await readBytes(path.join(pluginPath, SIGNATURE_FILE_NAME));
  if (signatureBytes === null)
    return 'signature:missing';

  let signatureDoc;
  try {
    signatureDoc = JSON.parse(signatureBytes.toString('utf8'));
  } catch {
    return 'signature:malformed';
  }

  const result = verifyPluginSignature({ manifestBytes, signatureDoc, publicKeys });
  return result.ok ? null : result.reason;
}
