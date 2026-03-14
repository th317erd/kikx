# Signing Surface Area — Complete Inventory

Reference for all signing/verification operations in the Kikx codebase.
Updated: 2026-03-13

---

## Keystore (`src/core/crypto/keystore.mjs`)

| Method | Key | Purpose |
|--------|-----|---------|
| `sign(data)` | REK (system) | HMAC-SHA256, returns hex string |
| `verify(data, signature)` | REK (system) | Timing-safe HMAC verification |
| `fingerprint(data, userKey)` | Per-user key | HMAC-SHA256 with derived user key |
| `deriveUserKey(umk, userID)` | UMK | HMAC-SHA256(UMK, userID) → 32-byte key |
| `canonicalize(data)` | — | Deterministic JSON (sorted keys, recursive) |

---

## PermissionService (`src/core/permissions/permission-service.mjs`)

| Method | Uses | Called From |
|--------|------|-------------|
| `signApproval(featureName, args, sessionID)` | `keystore.sign()` | Public API, delegates to `_signApproval` |
| `verifyApproval(featureName, args, signature, sessionID)` | `keystore.verify()` | PermissionPlugin |
| `check(featureName, args, options)` | Calls `signApproval` on allow | BasePluginClass, InteractionController |
| `createStandingApproval(options)` | Signs metadata with `_signApproval` | Approval endpoint (allow-forever) |

**Approval blob structure:**
```js
{ action: 'approve', featureName, args: args || {}, sessionID: sessionID || null }
```

---

## PermissionEngine (`src/core/permissions/permission-engine.mjs`)

| Method | Uses | Purpose |
|--------|------|---------|
| `createRule(ruleData)` | `keystore.fingerprint()` | Generates rule fingerprint if `userKey` provided |
| `_filterByFingerprint(rules, userKey)` | `keystore.fingerprint()` | Recomputes and compares rule fingerprints |

**Fingerprint data:** `${organizationID}:${featureName}:${effect}:${scope}`

---

## Routing Layer

**BasePluginClass** (`src/core/routing/base-plugin-class.mjs`):
- `checkPermission(toolName, params)` → calls `permissionService.check()`, returns `{ approved: true, signature }`

**PermissionPlugin** (`src/core/internal-plugins/permissions/index.mjs`):
- Reads `frame.content._signature` from tool-call frames
- Calls `permissionService.verifyApproval()` to validate

---

## Auth / JWT (`src/server/auth/index.mjs`)

| Method | Uses | Purpose |
|--------|------|---------|
| `hmacSHA256(data, secret)` | Raw HMAC | JWT signing |
| `createJWT(payload, secret)` | `hmacSHA256` | Token creation |
| `verifyJWT(token, secret)` | `hmacSHA256` + timing-safe | Token verification |
| `_deriveJWTSecret()` | REK | `HMAC(REK, 'kikx-jwt-secret')` |

**Note:** JWT signing is a SEPARATE concern from permission/value signing.
It stays HMAC/REK-based. Not part of the Ed25519 migration.

---

## Signature Storage Locations

| Location | Type | Format | Purpose |
|----------|------|--------|---------|
| `frame.content._signature` | Embedded in JSON | 64-char hex | Tool call approval |
| `PermissionRule.fingerprint` | DB column STRING(128) | 64-char hex | Rule integrity |
| `PermissionRule.metadata.signature` | JSON metadata field | 64-char hex | Standing approval |
| JWT | Token string | Base64url | Authentication |

---

## Test Files

| File | Tests |
|------|-------|
| `spec/core/crypto/envelope-signing-spec.mjs` | canonicalize, sign, verify |
| `spec/core/keystore-spec.mjs` | REK, AES, fingerprinting, signing |
| `spec/core/permissions/permission-service-spec.mjs` | signApproval, verifyApproval, standing approvals |
| `spec/core/permissions/fingerprint-spec.mjs` | Fingerprint generation/verification |
| `spec/core/internal-plugins/permission-plugin-spec.mjs` | Frame signature verification |
| `spec/core/routing/base-plugin-permission-spec.mjs` | checkPermission returns signature |
