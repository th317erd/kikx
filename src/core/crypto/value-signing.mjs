'use strict';

import crypto from 'node:crypto';

// =============================================================================
// Value Signing Utilities
// =============================================================================
// Helpers for signing and verifying ValueStore entries using Ed25519.
// The signing payload includes the full composite key to prevent replay
// attacks across keys, scopes, and owners.
// =============================================================================

// Compute a fingerprint of an Ed25519 public key PEM.
// Returns first 32 hex characters of SHA-256 hash (128 bits).
export function computeKeyFingerprint(publicKeyPEM) {
  if (!publicKeyPEM)
    return null;

  let hash = crypto.createHash('sha256').update(publicKeyPEM).digest('hex');

  return hash.substring(0, 32);
}

// Build a deterministic signing payload from the composite key + value.
// The payload is a pipe-delimited string of all components to prevent
// cross-key, cross-scope, and cross-owner replay attacks.
export function buildSigningPayload(ownerType, ownerID, namespace, scopeID, key, jsonValue) {
  return `${ownerType}|${ownerID}|${namespace}|${scopeID}|${key}|${jsonValue}`;
}

// Sign a ValueStore entry.
//
// Returns { signature, fingerprint } on success, or null if signing fails.
// Never throws — callers should treat null as "unsigned".
export function signValue(keystore, privateKeyPEM, publicKeyPEM, ownerType, ownerID, namespace, scopeID, key, jsonValue) {
  if (!keystore || !privateKeyPEM || !publicKeyPEM)
    return null;

  try {
    let payload     = buildSigningPayload(ownerType, ownerID, namespace, scopeID, key, jsonValue);
    let signature   = keystore.signWithPrivateKey(payload, privateKeyPEM);
    let fingerprint = computeKeyFingerprint(publicKeyPEM);

    return { signature, fingerprint };
  } catch (_error) {
    return null;
  }
}

// Verify a ValueStore entry's signature.
//
// Returns true if the signature is valid, false otherwise.
// Never throws — callers should treat exceptions as verification failure.
export function verifyValue(keystore, publicKeyPEM, ownerType, ownerID, namespace, scopeID, key, jsonValue, signatureHex) {
  if (!keystore || !publicKeyPEM || !signatureHex)
    return false;

  try {
    let payload = buildSigningPayload(ownerType, ownerID, namespace, scopeID, key, jsonValue);

    return keystore.verifyWithPublicKey(payload, publicKeyPEM, signatureHex);
  } catch (_error) {
    return false;
  }
}
