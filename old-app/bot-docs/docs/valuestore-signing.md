# ValueStore Signed Values — Research & Architecture

## Overview

The ValueStore is Kikx's unified key-value storage system, used for agent config, session context, user settings, and agent memory. Values are stored as JSON strings with composite keys: `(ownerType, ownerID, namespace, scopeID, key)`.

**Problem:** Stored values are currently unsigned. A bad actor with DB access could tamper with values (e.g., swap an email address, modify agent instructions) without any detection mechanism.

**Solution:** Optional Ed25519 signing on stored values, with server-side verification. Agents can opt in to signing individual values, and the system returns `signed`/`verified` flags on retrieval.

---

## Key Files

| File | Role |
|------|------|
| `src/core/models/value-store-model.mjs` | Model with `signature` and `signingKeyFingerprint` columns |
| `src/core/lib/value-store-service.mjs` | CRUD + `setSigned()` / `getVerified()` methods |
| `src/core/internal-plugins/memory/index.mjs` | Agent-facing tools: `memory:getValue`, `memory:setValue`, `memory:searchValues` |
| `src/core/crypto/keystore.mjs` | Ed25519 primitives: `signWithPrivateKey()`, `verifyWithPublicKey()`, `canonicalize()` |
| `src/core/crypto/frame-signing.mjs` | Frame signing helpers, `decryptAgentPrivateKey()` |
| `src/core/crypto/value-signing.mjs` | Value-specific signing utilities (created for this feature) |
| `src/core/interaction/index.mjs` | InteractionLoop — `_buildSigningContext()` caches decrypted agent private key |
| `src/server/controllers/interaction-controller.mjs` | `executeTool()` — augments tool params with `_agent` (full model instance) |

---

## Architecture

### Signing Flow (setValue with `sign: true`)

1. Tool receives `sign: true` parameter from agent
2. Tool decrypts agent's private key: `decryptAgentPrivateKey(keystore, agent.encryptedPrivateKey, agent.id)`
3. Builds signing payload: `ownerType + ownerID + namespace + scopeID + key + jsonValue` (canonicalized)
4. Signs payload with Ed25519: `keystore.signWithPrivateKey(payload, privateKeyPEM)`
5. Computes key fingerprint: SHA-256 of agent's public key PEM (first 32 hex chars)
6. Stores `signature` + `signingKeyFingerprint` alongside the value

### Verification Flow (getValue / searchValues)

1. Tool retrieves entry from DB
2. If no `signature` column: `signed: false` (no `verified` field)
3. If `signature` present:
   - Compute fingerprint of requesting agent's public key
   - Compare to stored `signingKeyFingerprint`
   - Rebuild signing payload from stored composite key + value
   - Verify with `keystore.verifyWithPublicKey(payload, publicKeyPEM, signature)`
   - Return `signed: true, verified: true/false`

### Why Include Composite Key in Signing Payload

Including `ownerType + ownerID + namespace + scopeID + key` in the payload prevents:

- **Cross-key replay**: Can't copy a signed value from key `email` to key `admin_email`
- **Cross-scope replay**: Can't copy a signed value from session A to session B
- **Cross-owner replay**: Can't copy a signed value from agent A to agent B

### Key Fingerprint

The `signingKeyFingerprint` column enables distinguishing between:

- **Tampered value**: Same key fingerprint, signature verification fails → data was modified
- **Key rotation**: Different key fingerprint → can't verify with current key (expected after rotation)

---

## Existing Infrastructure (Pre-Feature)

### Already Existed
- `signature` column on ValueStore model (STRING 256, allowNull: true)
- `setSigned()` method on ValueStoreService (signs just the JSON value string)
- `getVerified()` method on ValueStoreService (returns value or null)
- Full Ed25519 key infrastructure: key generation, encryption, signing/verification
- Agent model has `publicKey` and `encryptedPrivateKey` fields

### Gaps Filled by This Feature
- No `signingKeyFingerprint` column → added
- Signing payload was just the raw value string → now includes full composite key
- `getVerified()` returned value-or-null → now returns `{ value, signed, verified }`
- Memory tools didn't expose signing → now accept `sign: true` and return `signed`/`verified`
- Tools couldn't access agent's private key → now decrypt via `_agent.encryptedPrivateKey` + keystore

---

## Tool Parameter Injection

Tools receive augmented parameters from `executeTool()` in the interaction controller:

```javascript
let augmentedArgs = {
  ...toolArgs,          // Agent-provided parameters
  _sessionID: ...,      // Current session ID
  _authorID:  ...,      // Current user ID
  _agent:     ...,      // Full agent model instance (has publicKey, encryptedPrivateKey)
  agentID:    ...,      // Agent ID shortcut
};
```

The `_agent` object contains `encryptedPrivateKey` and `publicKey`, and the tool has access to the keystore via `this._context.getProperty('keystore')`. This means tools can decrypt the agent's private key without any changes to the interaction loop or controller.

---

## Security Considerations

- **Server-side only**: Agents can't compute Ed25519 signatures themselves. All signing/verification happens server-side.
- **Best-effort**: If signing fails (no key, keystore unavailable), the value is stored unsigned. No crash.
- **Fingerprint mismatch**: After key rotation, old signatures can't be verified. This is correct security behavior.
- **No cross-agent verification**: Currently scoped to same-agent sign+verify. Cross-agent verification would require looking up the signer's public key by fingerprint.
