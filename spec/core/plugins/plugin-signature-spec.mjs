'use strict';

// =============================================================================
// Plugin signatures (campaign S4, plan §5-S4 rev 3 + §10 enterprise posture)
// =============================================================================
// Envelope (`.kikx-sig` beside manifest.json), mirroring Xenocept's shape with
// the `keyID` field §10 reserves for multi-publisher trust anchors:
//
//   { keyID, payload: base64(manifest.json bytes), signature: base64(Ed25519) }
//
// Verification, fail-closed in this order:
//   no configured keys      -> 'signature:no-configured-key'
//   .kikx-sig absent        -> 'signature:missing'
//   envelope unparseable    -> 'signature:malformed'
//   payload != disk bytes   -> 'signature:manifest-mismatch'  (tampered after signing)
//   Ed25519 verify fails    -> 'signature:invalid'            (wrong key or forged)
//
// `keyID` is RECORDED on every signature and tried first during verification;
// with bare comma-separated keys configured today, a non-matching keyID falls
// back to trying every configured key — the id pairing becomes authoritative
// when trust anchors gain names (reserved, §10).

import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  parseSigningPublicKeys,
  verifyPluginSignature,
  signPluginSignature,
  admitPluginDirectory,
} from '../../../src/core/plugins/plugin-signature.mjs';

function keypair() {
  return crypto.generateKeyPairSync('ed25519');
}

function base64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

test('parseSigningPublicKeys: comma-separated raw keys, empty means EMPTY (fail closed)', () => {
  const { publicKey } = keypair();
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);

  const [ parsed ] = parseSigningPublicKeys(base64(raw));
  assert.equal(parsed.type, 'public', 'a raw 32-byte base64 key imports as a public KeyObject');

  assert.deepEqual(parseSigningPublicKeys(''), [], 'no configured keys parses to an empty list');
  assert.deepEqual(parseSigningPublicKeys(null), [], 'and so does a missing value');
  assert.deepEqual(parseSigningPublicKeys('not-a-key!!'), [],
    'garbage is dropped, never trusted by accident');
});

test('sign then verify round-trips; the envelope carries keyID + base64 payload', async () => {
  const { privateKey, publicKey } = keypair();
  const manifest = Buffer.from(JSON.stringify({ name: 'alpha', version: '1.0.0' }, null, 2));
  const doc = signPluginSignature(manifest, privateKey, 'test-key-1');

  assert.equal(doc.keyID, 'test-key-1', 'the keyID travels for future trust anchors');
  assert.deepEqual(JSON.parse(Buffer.from(doc.payload, 'base64').toString()), JSON.parse(manifest.toString()),
    'payload decodes to the exact manifest bytes');
  assert.equal(typeof doc.signature, 'string');

  const result = verifyPluginSignature({
    manifestBytes: manifest,
    signatureDoc: doc,
    publicKeys: [ publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') ]
      .flatMap((raw) => parseSigningPublicKeys(raw)),
  });
  assert.equal(result.ok, true, `expected ok, got ${result.reason}`);
  assert.equal(result.reason, null);
});

test('verification refuses, by reason: no keys, missing, malformed, mismatch, invalid', () => {
  const { privateKey, publicKey } = keypair();
  const other = keypair();
  const manifest = Buffer.from('{"name":"alpha"}');

  const doc = signPluginSignature(manifest, privateKey, 'k1');
  const keys = [ publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') ]
    .flatMap((raw) => parseSigningPublicKeys(raw));
  const otherKeys = [ other.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') ]
    .flatMap((raw) => parseSigningPublicKeys(raw));

  assert.equal(verifyPluginSignature({ manifestBytes: manifest, signatureDoc: doc, publicKeys: [] }).reason,
    'signature:no-configured-key', 'zero keys must never mean zero checks');
  assert.equal(verifyPluginSignature({ manifestBytes: manifest, signatureDoc: null, publicKeys: keys }).reason,
    'signature:missing');
  assert.equal(verifyPluginSignature({
    manifestBytes: manifest,
    signatureDoc: { keyID: 'k1', payload: '!!!notbase64!!!', signature: 'x' },
    publicKeys: keys,
  }).reason, 'signature:malformed');

  const tampered = Buffer.from('{"name":"EVIL"}');
  assert.equal(verifyPluginSignature({ manifestBytes: tampered, signatureDoc: doc, publicKeys: keys }).reason,
    'signature:manifest-mismatch', 'a manifest edited after signing is caught before crypto runs');

  assert.equal(verifyPluginSignature({ manifestBytes: manifest, signatureDoc: doc, publicKeys: otherKeys }).reason,
    'signature:invalid', 'a signature from a key nobody configured is invalid');
});

test('admitPluginDirectory: unsafe bypasses; required fails closed at every gap', async () => {
  const { privateKey, publicKey } = keypair();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-sig-'));
  const manifest = Buffer.from(JSON.stringify({ name: 'fixture', version: '0.0.1' }));
  const keys = [ publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') ]
    .flatMap((raw) => parseSigningPublicKeys(raw));

  // unsafe mode admits anything, unverified (the loud warning lives in the loader).
  assert.equal(await admitPluginDirectory(dir, { mode: 'unsafe', publicKeys: [] }), null);

  // required + no keys: refused BEFORE even reading the directory.
  assert.equal(await admitPluginDirectory(dir, { mode: 'required', publicKeys: [] }),
    'signature:no-configured-key');

  // required + keys + no signature yet: missing.
  await fs.writeFile(path.join(dir, 'manifest.json'), manifest);
  assert.equal(await admitPluginDirectory(dir, { mode: 'required', publicKeys: keys }),
    'signature:missing');

  // signed: admitted.
  const doc = signPluginSignature(manifest, privateKey, 'fixture-key');
  await fs.writeFile(path.join(dir, '.kikx-sig'), JSON.stringify(doc));
  assert.equal(await admitPluginDirectory(dir, { mode: 'required', publicKeys: keys }), null);

  // manifest edited after signing: refused.
  await fs.writeFile(path.join(dir, 'manifest.json'), Buffer.from('{"name":"patched"}'));
  assert.equal(await admitPluginDirectory(dir, { mode: 'required', publicKeys: keys }),
    'signature:manifest-mismatch');

  await fs.rm(dir, { recursive: true, force: true });
});
