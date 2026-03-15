# TODO: ValueStore Signed Values

## Status Key
- [ ] Not started
- [~] In progress
- [x] Complete

---

## Step 1: Model Migration
- [x] `signature` TEXT column already exists on ValueStore model
- [x] Add `signingKeyFingerprint` STRING(64) column to ValueStore model

## Step 2: Signing Utilities
- [x] Create `src/core/crypto/value-signing.mjs` with:
  - `computeKeyFingerprint(publicKeyPEM)` → first 32 hex chars of SHA-256
  - `buildSigningPayload(ownerType, ownerID, namespace, scopeID, key, jsonValue)` → deterministic string
  - `signValue(keystore, privateKeyPEM, publicKeyPEM, ...)` → `{ signature, fingerprint }`
  - `verifyValue(keystore, publicKeyPEM, ...)` → boolean

## Step 3: ValueStoreService Updates
- [x] `setSigned()` — uses new signing payload, stores `signingKeyFingerprint`
- [x] `getVerified()` — returns `{ value, signed, verified }` instead of value-or-null
- [x] `search()` — includes `signed` boolean per result
- [x] `set()` — clears both `signature` and `signingKeyFingerprint` on overwrite

## Step 4: Tool Updates
- [x] `memory:setValue` — accepts `sign` boolean, decrypts agent private key, signs value
- [x] `memory:getValue` — returns `signed`/`verified` flags when signature exists
- [x] `memory:searchValues` — returns `signed`/`verified` per result

## Step 5: Tests
- [x] Unit tests for signing/verification helpers (`spec/core/crypto/value-signing-spec.mjs` — 37 tests)
- [x] Unit tests for ValueStoreService signed values (`spec/core/lib/value-store-service-spec.mjs` — updated, 45 tests)
- [x] Integration tests: sign → retrieve → verify (`spec/core/internal-plugins/memory-signing-spec.mjs` — 21 tests)
- [x] Tamper detection: modify value in DB → verified: false (`spec/core/integration/tamper-detection-spec.mjs` — updated, 39 tests)
- [x] Key fingerprint mismatch detection (covered in value-signing-spec + tamper-detection-spec)
- [x] Adversarial: missing signature, corrupted signature, wrong key (covered across all test files)

## ✓ COMPLETE — All 2999 tests pass
