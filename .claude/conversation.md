# Merged Plan: Ed25519 Identity + ValueStore + Danger Level Permissions

## Why These Plans Must Merge

Three separate plans share the same cryptographic foundation:

| Plan | What It Needs |
|------|---------------|
| **Signatures & Federation** | Per-user Ed25519 key pairs, per-frame authorship signatures |
| **Value Store** | Tamper-proof signed storage entries |
| **Danger Level Permissions** | Verified riskLevel values (signed, verifiable anytime) |

Building ValueStore signing with HMAC failed (symmetric key only available during
authenticated requests). Ed25519 (asymmetric) solves this — public key verifies
anytime. But if we're introducing Ed25519, we should also upgrade the existing
permission approval signatures that currently use HMAC/REK. Otherwise we'd have
two parallel signing systems for the same class of operation.

## Current State of Signing

Everything uses HMAC-SHA256 today:

| Component | Signs With | Verifies With | Purpose |
|-----------|-----------|---------------|---------|
| `PermissionService.signApproval()` | REK | REK | Tool call approval envelopes |
| `PermissionService.createStandingApproval()` | REK | REK | Standing approval metadata |
| `PermissionEngine.createRule()` | User key (HMAC) | User key (HMAC) | Rule integrity fingerprints |
| `PermissionPlugin` | — | REK | Verifies `frame.content._signature` on tool-call frames |
| JWT (auth) | REK-derived | REK-derived | Authentication tokens (STAYS AS-IS) |

### Problems with the current approach:
1. **REK is ephemeral** — dies on server restart, all signatures invalidated
2. **REK proves "server approved"** — not "user approved" (weaker guarantee)
3. **HMAC requires same key for verify** — can't verify outside authenticated context
4. **No per-frame authorship** — frames have `authorType`/`authorID` set by server
   (trust-the-server model), no cryptographic proof
5. **Signature is embedded in content** — `frame.content._signature` is a hack,
   not a proper field on the frame schema

## After Migration: Ed25519 Everywhere

| Component | Signs With | Verifies With | Purpose |
|-----------|-----------|---------------|---------|
| `PermissionService.signApproval()` | User's **private key** | User's **public key** | Tool call approval envelopes |
| `PermissionService.createStandingApproval()` | User's private key | User's public key | Standing approval metadata |
| `PermissionEngine.createRule()` | User's private key | User's public key | Rule integrity |
| `PermissionPlugin` | — | User's public key | Verify frame signatures |
| `ValueStoreService.setSigned()` | User's private key | User's public key | Tamper-proof config values |
| Frame authorship | Author's private key | Author's public key | Cryptographic proof of authorship |
| JWT (auth) | REK-derived (unchanged) | REK-derived (unchanged) | Authentication tokens |

### What this gives us:
1. **Signatures survive restarts** — keys are persisted, not ephemeral
2. **Proves "user approved"** — cryptographic proof of human action
3. **Verify anytime** — public key always available, no UMK needed
4. **Frame authorship** — proper `signature` field on frames
5. **ValueStore tamper detection** — the exact thing we need for riskLevel

## Where Does the Private Key Come From at Signing Time?

<!-- 
From the user's "vault". The users vault is encrypted with a master key, which itself is encrypted by a magic token inside the JWT authentication token. We always have what we need to decrypt the vault what the user's JWT token is present.
 -->

This is the critical question. Let me trace every signing call site:

### PermissionService.signApproval() — called from:

1. **PermissionService.check()** (line 61) — called from `checkPermission` callback
   in InteractionController. This callback is a closure that captures `this.request`.
   **UMK available:** Yes — `this.request.getUMK()` from the authenticated request
   that started the interaction.

2. **PermissionHandler.approve()** — called when user approves a pending tool call
   via `POST /api/v2/sessions/:id/interact/approve/:frameID`.
   **UMK available:** Yes — this IS an authenticated HTTP request.

### PermissionService.createStandingApproval() — called from:

1. **Approval endpoint** (allow-forever decision) — authenticated HTTP request.
   **UMK available:** Yes.

### PermissionEngine.createRule() (with fingerprint) — called from:

1. **PermissionService.createStandingApproval()** — authenticated context (above).
   **UMK available:** Yes.

### ValueStoreService.setSigned() — called from:

1. **Auth controller** (user updates settings) — authenticated HTTP request.
   **UMK available:** Yes.

2. **Agent controller** (user updates agent config) — authenticated HTTP request.
   **UMK available:** Yes.

### Frame authorship signing — would be called from:

1. **FrameManager.commit()** — creates frames during interactions.
   For user-authored frames: the interaction was started by an authenticated request.
   **UMK available:** Yes (via closure).
   For agent-authored frames: need the agent's private key (see below).
   For system frames: sign with REK (system identity, no user key needed).

**Conclusion:** Every current signing operation happens within an authenticated
request context (or a closure that captured one). The private key is always
derivable when we need to SIGN.

## The Agent Key Pair Question

Users have key pairs (generated at registration). But agents also author frames.
If we want per-frame authorship signatures, agents need key pairs too.

<!--
Yes, every "actor" will need key-pairs. Actors can come from plugins too.  
 -->

**How agent key pairs differ from user key pairs:**
- Agent key pairs are generated by the SERVER (when the agent is created)
- The private key could be encrypted with the creating user's key (UMK-derived)
- OR encrypted with the REK (simpler, but dies on restart)
- OR stored plaintext (the agent is a server-side entity, not a human with secrets)

<!--
This is a very good point. They need to be agents that can act independant of the user. The best we are likely to be able to do, given our constraints, is to use the server's vault to hold the secrets to decrypting agent vaults.
 -->

**My recommendation:** Encrypt agent private keys with the owning user's key.
Same pattern as API key encryption. The creating user's UMK → user key →
encrypts agent private key. Decrypted on-demand during interactions (the
`checkPermission` closure has the user's UMK).

This means: agent key pair generation happens during `POST /api/v2/agents`
(authenticated request), and agent frame signing happens during interactions
(closure has UMK from the initiating user's request).

<!--
This won't work. The agent can and will work independently of the user. We will not be able to decrypt the user's key if the user is not present. We instead need to find another (likely derivitive) way to encrypt the agent/actors key that is pupetteered by the server. The encryption won't actually be decent for a same-host scenario, but at least we got that "fixed" for the user.

Don't forget, that ANOTHER one of our plans is key rotation. We will likely plug this in after all our other work, such that REKs and other server signing keys can be sudo-ephemeral. This will help a bit in keeping things a little safer, as the server's vault will constantly be encrypted with new keys.
 -->

## Frame Schema Change

Currently, frames have NO `signature` field. Approval signatures are stuffed into
`frame.content._signature` — functional but unprincipled.

**Add to Frame model:**

| Field | Type | Notes |
|-------|------|-------|
| `signature` | STRING(256) | Ed25519 signature (128 hex chars), nullable |

**Add to in-memory Frame class** (`src/shared/frame-manager/frame.mjs`):
```
this.signature = (data.signature !== undefined) ? data.signature : null;
```

**Migration:** Move `frame.content._signature` → `frame.signature`. The
PermissionPlugin reads from the new field. The content field no longer carries
signature data.

<!--
Agreed. 
 -->

## Merged Implementation Steps

### Phase A: Cryptographic Infrastructure

**A1: Ed25519 methods on Keystore**
`src/core/crypto/keystore.mjs`
- `generateSigningKeyPair()` → `{ publicKey, privateKey }` (PEM)
- `signWithPrivateKey(data, privateKeyPEM)` → hex signature
- `verifyWithPublicKey(data, publicKeyPEM, signatureHex)` → boolean
- Keep existing `sign()`/`verify()` for JWT and system-level operations

**A2: User key pairs**
`src/core/models/user-model.mjs`
- Add `publicKey` TEXT and `encryptedPrivateKey` TEXT(long) columns
- Generate at registration in auth service
- Encrypt private key with user key (derived from UMK)

**A3: Agent key pairs**
`src/core/models/agent-model.mjs`
- Add `publicKey` TEXT and `encryptedPrivateKey` TEXT(long) columns
- Generate at agent creation in agent controller
- Encrypt private key with creating user's key

### Phase B: ValueStore

**B1: ValueStore model**
`src/core/models/value-store-model.mjs`
- Schema as designed in Round 6 (ownerType, ownerID, namespace, scopeID, key, value, signature)

**B2: ValueStoreService**
`src/core/lib/value-store-service.mjs`
- CRUD + Ed25519 signed operations + search
- `setSigned()` uses private key, `getVerified()` uses public key

**B3: Migrate Agent config → ValueStore**
- Async wrappers on Agent model, drop `config` column

**B4: Migrate Session context → ValueStore**
- Async wrappers on Session model, drop `context` column

**B5: Add User settings via ValueStore**
- `getSettings()`, `updateSettings()`, `getVerifiedSettings()`

**B6: New memory tools**
- `memory:getValue`, `memory:setValue`, `memory:searchValues`

### Phase C: Permission Signing Migration

**C1: Frame signature field**
- Add `signature` column to Frame model and in-memory Frame class
- Update FrameManager.commit() to accept signature option

**C2: PermissionService Ed25519 migration**
- `signApproval()` → sign with user's private key instead of REK
- `verifyApproval()` → verify with user's public key instead of REK
- API surface stays the same — internals change

**C3: PermissionEngine fingerprint migration**
- `createRule()` fingerprint → Ed25519 signature instead of HMAC
- `_filterByFingerprint()` → Ed25519 verification

**C4: PermissionPlugin update**
- Read `frame.signature` instead of `frame.content._signature`
- Verify with author's public key

**C5: Frame authorship signatures**
- FrameManager.commit() signs every frame with author's private key
- User frames → user's private key
- Agent frames → agent's private key
- System frames → REK-based system signature (or a system key pair)

### Phase D: Danger Level Permissions

**D1: Permission engine 3-way branch**
- Resolution chain: agent config → verified user settings → 'strict'
- strict/normal/permissive behavior

**D2: API endpoints**
- Agent controller: accept riskLevel, sign with user's private key via ValueStore
- Auth controller: accept riskLevel, sign with user's private key via ValueStore

**D3: UI**
- Agent form dropdown (4 options)
- Settings page permissions tab (3 options)

### Phase E: Tests

Full test plan from Round 7, plus:
- Ed25519 key pair generation/encryption/decryption
- Ed25519 sign/verify round-trips
- Permission approval Ed25519 signatures (migration from HMAC)
- Frame authorship signatures
- Agent key pair generation + frame signing
- ValueStore Ed25519 signing (replaces HMAC tests)
- Cross-signing: verify user's frame with user's public key, agent's frame with agent's public key

## What Stays Deferred

| Feature | Why Deferred |
|---------|-------------|
| Federation protocol | Multi-server concern, not needed for single-server |
| Key rotation | Can be added later; current keys are stable |
| Two-layer envelope (user + system signature) | Only needed for federation trust model |

## Open Questions

1. **System-authored frames:** Should the system get its own Ed25519 key pair,
   or continue using REK for system signatures? Recommendation: system key pair
   (consistent model, survives restarts). But this means storing a system key pair
   somewhere persistent (config file? DB? environment variable?).

   <!--
   The system should get its own key pair. Storage in the DB please. 
    -->

2. **Agent private key encryption:** Use creating user's key (UMK-derived) or
   REK? User's key means the agent's private key survives server restarts.
   REK means simpler code but keys die on restart. Recommendation: user's key
   (same pattern as API key encryption).

   <!--
   We don't want REK, because we can't have all our agents and their memories permently die when the server shuts down. We need to use a derivitave, likely something involving the server keys. I understand that agents and other server operated actors will honestly not be very safe from same-host attacks. I am not sure that can be helped. At least we have provided protection for users, since they can have a password locked away in their brain (or hopefully their password vault!). 
    -->

3. **Backward compatibility:** Existing permission rules have HMAC fingerprints
   and REK-based signatures. These will fail Ed25519 verification. Options:
   (a) Clear all rules on migration (pre-release, no production data).
   (b) Keep HMAC verification as fallback for old rules.
   Recommendation: clean break (a).

   <!--
   Let's drop data at will. I have all our API keys backed up. Everything in the database is just test data. 
    -->

4. **Performance concern:** Ed25519 is fast, but frame signing on EVERY commit
   adds overhead. Ed25519 sign is ~50μs, verify is ~100μs — negligible for
   interactive use. But worth noting.

   <!--
   Thank you for noting. This is a "chat app". We don't care about a wee bit of overhead. We could probably live with a full second of overhead per frame if we really had to (we don't want to, I am just showing that we have a crap ton of head-room). 
    -->

## Complexity Assessment

This is now a **large** implementation. We're merging three plans:

| Component | Estimated Lines |
|-----------|----------------|
| Keystore Ed25519 methods | ~40 |
| User/Agent key pairs (model + registration) | ~80 |
| ValueStore model + service | ~200 |
| Agent/Session/User model migration | ~100 |
| Memory tools (3 new) | ~120 |
| Frame signature field + authorship signing | ~60 |
| PermissionService Ed25519 migration | ~40 |
| PermissionEngine migration | ~30 |
| Permission engine riskLevel 3-way branch | ~80 |
| API controllers (agent + auth + riskLevel) | ~50 |
| UI (agent dropdown + settings tab) | ~50 |
| Tests | ~1200-1500 |

Total: ~850-900 lines implementation + ~1200-1500 lines tests.

But the payoff is enormous: unified cryptographic identity, tamper-proof storage,
agent memory, and risk level permissions — all built on a single, coherent
Ed25519 foundation rather than a patchwork of HMAC hacks.

<!--
Yes, I know this is large, and we aren't even doing key rotation in this pass! Whew! You have a lot of good work here. I only called out a few things. Append the next round below.
 -->

---

## Round 2: Server Vault + Actor Key Encryption

Your feedback surfaced three design corrections:

1. **Every actor needs key pairs** — not just users and agents, but plugin actors too.
   Any entity that authors frames needs an Ed25519 key pair.

2. **Agent/actor key encryption can't use user's UMK** — agents act independently.
   The current API key pattern (encrypt with user key, decrypt at interaction start)
   doesn't work because agents may operate without a user present.

3. **Can't use REK either** — ephemeral, dies on restart. Agent keys must survive
   restarts or they lose their identity permanently.

### The Missing Piece: Server Master Key (SMK)

Today, the keystore has NO persistent key material. REK is random bytes generated
fresh each boot. UMK is per-user, locked in their vault. There's nothing in between.

We need a **Server Master Key (SMK)**: a persistent symmetric key that lives outside
the database. This is the standard pattern for server-side secrets management —
similar to how AWS KMS has a root key, or how HashiCorp Vault has unseal keys.

**SMK lifecycle:**

| Event | What Happens |
|-------|-------------|
| First boot | Generate 32 random bytes, write to `~/.config/kikx/server.key` |
| Subsequent boots | Load SMK from file |
| Key rotation (future) | Generate new SMK, re-encrypt all actor keys, archive old SMK |

**Why a file, not an env var?**
- Env vars leak into process listings, crash dumps, child processes
- A file with restricted permissions (0600) is more controlled
- Can be backed up separately from the database
- `KIKX_SERVER_KEY_FILE` env var can override the path (but not the key itself)

**Why not in the database?**
- Separation of concerns: DB has encrypted data, file system has the key
- If someone gets the DB, they don't get the key (and vice versa)
- Same-host attacker gets both — user acknowledged this is unavoidable

<!--
I agree with all of this. 
 -->

### Key Hierarchy (After This Change)

```
SMK (Server Master Key)
├── config file: ~/.config/kikx/server.key
├── loaded by Keystore at init
└── encrypts:
    ├── System Ed25519 private key (stored in DB)
    ├── Agent Ed25519 private keys (stored on Agent model)
    └── Plugin actor Ed25519 private keys (stored on actor record)

REK (Runtime Encryption Key)
├── in-memory only, dies on restart
├── generated fresh each boot
└── used for:
    ├── JWT vault claims (wrapping UMK)
    ├── JWT secret derivation
    └── System-level HMAC sign/verify (existing, may deprecate)

UMK (User Master Key)
├── per-user, locked in password slot
├── unwrapped during authenticated requests
└── encrypts:
    └── User Ed25519 private key (stored on User model)
```

### Actor Key Encryption Pattern

For each server-operated actor (agent, plugin actor, system):

```
actorEncryptionKey = HMAC-SHA256(SMK, actorID)  →  32-byte AES key
encryptedPrivateKey = AES-256-GCM(actorEncryptionKey, ed25519PrivateKey)
```

Per-actor key derivation means:
- Compromising one actor's key doesn't directly expose others
- Each actor's encrypted private key is useless without the SMK
- Key rotation re-derives all actor keys from the new SMK

### Keystore Changes

New methods on `src/core/crypto/keystore.mjs`:

```
// SMK management
loadServerMasterKey(configPath)    // Load from file, generate if missing
getServerMasterKey()               // Accessor (internal use)

// Ed25519
generateSigningKeyPair()           // { publicKey, privateKey } (PEM or DER)
signWithPrivateKey(data, privKey)   // Ed25519 sign → hex
verifyWithPublicKey(data, pubKey, sig) // Ed25519 verify → boolean

// Actor key encryption (server-operated actors)
encryptActorPrivateKey(privateKey, actorID)   // SMK-derived encryption
decryptActorPrivateKey(encrypted, actorID)    // SMK-derived decryption

// User key encryption (human actors)
encryptUserPrivateKey(privateKey, umk, userID)  // UMK-derived encryption
decryptUserPrivateKey(encrypted, umk, userID)   // UMK-derived decryption
```

### Updated Phase A: Cryptographic Infrastructure

**A1: Server Master Key**
- `Keystore.loadServerMasterKey(configPath)` — load or generate `~/.config/kikx/server.key`
- Called during Application startup, before anything else
- `KIKX_SERVER_KEY_FILE` env var overrides default path

**A2: Ed25519 methods on Keystore**
- `generateSigningKeyPair()` → `{ publicKey, privateKey }`
- `signWithPrivateKey(data, privateKeyPEM)` → hex signature
- `verifyWithPublicKey(data, publicKeyPEM, signatureHex)` → boolean
- Actor key encryption/decryption helpers (SMK-derived and UMK-derived)

**A3: System key pair**
- Generate on first boot (or migration)
- Store in DB: `publicKey` plaintext, `encryptedPrivateKey` encrypted with SMK
- Where in DB? Could be a ValueStore row: `ownerType='system', ownerID='system', namespace='config', key='signingKeyPair'`
- Or a dedicated SystemConfig table/row — simpler, less entangled with ValueStore

**A4: User key pairs**
- Add `publicKey` TEXT and `encryptedPrivateKey` TEXT(long) to User model
- Generate at registration (AuthService.register)
- Private key encrypted with `deriveUserKey(UMK, userID)` → existing pattern
- Decrypted on-demand via `request.getUMK()`

**A5: Agent/actor key pairs**
- Add `publicKey` TEXT and `encryptedPrivateKey` TEXT(long) to Agent model
- Generate at agent creation (`POST /api/v2/agents`)
- Private key encrypted with `HMAC(SMK, agentID)` — no user dependency
- Decrypted by keystore using SMK — available anytime, no user needed

**Plugin actors:** Same pattern as agents. When a plugin registers an actor,
the server generates a key pair and encrypts the private key with
`HMAC(SMK, actorID)`. This can happen at plugin installation time.

### System Key Pair Storage

You said "storage in the DB please" for the system key pair. Two options:

**Option A: ValueStore row**
```
ownerType: 'system', ownerID: 'system', namespace: 'config'
key: 'publicKey',           value: '<PEM>'
key: 'encryptedPrivateKey', value: '<encrypted PEM>'
```
Pro: Uses existing infrastructure. Con: Circular dependency — ValueStore
may not exist yet during first boot / migration.

**Option B: Dedicated column(s) on a SystemConfig model or Keystore table**
Pro: No circular dependency. Con: Another model/table.

**Option C: Store directly on the Keystore model/initialization**
The keystore already initializes at boot. It could have a `system_keys` table
with just one row: `{ publicKey, encryptedPrivateKey }`. Or even simpler —
store alongside the SMK file (but you said DB, so not this).

My recommendation: **Option A (ValueStore)** but with a boot-order guard. The
system key pair is generated during a one-time migration step AFTER ValueStore
table exists. On subsequent boots, Keystore loads the system key pair from
ValueStore as part of its initialization.

<!--
Actually, you swayed my opinion. Let's go with a file. 
 -->

### Revised Implementation Phases

The phases stay mostly the same, with these adjustments:

**Phase A** (Crypto Infrastructure) now includes SMK and is ordered:
1. A1: SMK file management
2. A2: Ed25519 + actor/user encryption helpers on Keystore
3. A3: System key pair (stored in ValueStore after B1)
4. A4: User key pairs (on User model, UMK-encrypted)
5. A5: Agent/actor key pairs (on Agent model, SMK-encrypted)

Note: A3 depends on B1 (ValueStore model) if we use Option A. This means
B1 (ValueStore model) should actually come BEFORE A3. Reordering:

```
A1: SMK → A2: Ed25519 methods → B1: ValueStore model → A3: System key pair
→ B2: ValueStoreService → A4: User key pairs → A5: Agent key pairs
→ B3-B6: Migrations + tools → C1-C5: Permission migration → D1-D3: Danger levels
```

### Open Questions (Updated)

1. ~~System key pair storage~~ → **Resolved: DB via ValueStore (Option A)**
2. ~~Agent key encryption~~ → **Resolved: SMK-derived, per-actor**
3. ~~Backward compat~~ → **Resolved: clean break**
4. ~~Performance~~ → **Resolved: non-concern**

**New question:**

5. **SMK file location default:** `~/.config/kikx/server.key` seems natural
   (alongside `kikx.db`). The DB path is already configurable via `KIKX_DB`
   env var. Should the SMK path follow the same pattern?
   Proposed: `KIKX_SERVER_KEY_FILE` env var, defaulting to same directory as DB.

    <!--
    I like this recommendation. 
     -->

6. **Plugin actor key pairs:** When/where are plugin actors registered? I need
   to understand the plugin lifecycle to know when to generate their key pairs.
   This may be a "cross that bridge when we get there" item since plugins are
   still a future concern.

   <!--
   We haven't defined this yet. I know it is something I will want to get into in the future though, which is why I am thinking about it now. We can worry about this later if we just design the system well.
    -->

---

## Round 3: Final Design — All Questions Resolved

Your Round 2 feedback resolved everything. Here's the consolidated final design.

### Resolved Decisions

| Question | Resolution |
|----------|-----------|
| SMK rationale (file, not DB) | Agreed |
| System key pair storage | **File** (you were swayed — eliminates circular dependency with ValueStore) |
| SMK file path | `KIKX_SERVER_KEY_FILE` env var, default same directory as DB |
| Plugin actor key pairs | Defer — design the system well, worry about plugins later |
| Agent key encryption | SMK-derived, per-actor |
| Backward compat | Clean break, drop old data |
| Performance | Non-concern for a chat app |

### Config Directory Layout (After Implementation)

```
~/.config/kikx/
├── kikx.db                    # SQLite database (existing)
├── server.key                 # SMK — 32 random bytes, hex-encoded
├── system-signing.pub         # System Ed25519 public key (PEM)
├── system-signing.key.enc     # System Ed25519 private key (encrypted with SMK)
└── plugins/                   # Plugin directory (existing)
```

All three files are generated on first boot if missing. The `.key.enc` extension
signals "this is encrypted, don't try to use it raw."

### Keystore Boot Sequence

```
1. loadServerMasterKey()
   ├── Read ~/.config/kikx/server.key (or KIKX_SERVER_KEY_FILE)
   ├── If missing → generate 32 random bytes, write file (mode 0600)
   └── Store in this._smk

2. initialize()
   ├── Generate REK (existing behavior, unchanged)
   └── Load system key pair from files
       ├── Read system-signing.pub → this._systemPublicKey
       ├── Read system-signing.key.enc → decrypt with SMK → this._systemPrivateKey
       └── If files missing → generate Ed25519 pair, encrypt private, write both
```

### Final Key Hierarchy

```
SMK (Server Master Key)
├── file: ~/.config/kikx/server.key
├── loaded by Keystore.loadServerMasterKey()
├── persists across restarts
└── encrypts:
    ├── System Ed25519 private key (file: system-signing.key.enc)
    ├── Agent Ed25519 private keys (DB: Agent.encryptedPrivateKey)
    └── Future: plugin actor private keys (same pattern)

REK (Runtime Encryption Key)
├── in-memory only, ephemeral
└── used for:
    ├── JWT vault claims (wrapping UMK) — unchanged
    ├── JWT secret derivation — unchanged
    └── Existing HMAC sign/verify — will be replaced by Ed25519 for permissions

UMK (User Master Key)
├── per-user, locked in password slot
├── unwrapped during authenticated requests via JWT vault claim
└── encrypts:
    └── User Ed25519 private key (DB: User.encryptedPrivateKey)
```

### Final Keystore API

```javascript
// --- SMK (new) ---
loadServerMasterKey(configDir)        // Load/generate ~/.config/kikx/server.key
loadSystemKeyPair(configDir)          // Load/generate system Ed25519 pair

// --- Ed25519 (new) ---
generateSigningKeyPair()              // → { publicKey, privateKey } (PEM strings)
signWithPrivateKey(data, privateKey)   // Ed25519 sign → hex string
verifyWithPublicKey(data, publicKey, signatureHex) // → boolean

// --- Private key encryption (new) ---
encryptActorPrivateKey(privateKey, actorID)    // HMAC(SMK, actorID) → AES key → encrypt
decryptActorPrivateKey(encrypted, actorID)     // HMAC(SMK, actorID) → AES key → decrypt
encryptUserPrivateKey(privateKey, umk, userID) // deriveUserKey(umk, userID) → encrypt
decryptUserPrivateKey(encrypted, umk, userID)  // deriveUserKey(umk, userID) → decrypt

// --- System signing shortcuts (new) ---
systemSign(data)                      // Sign with system private key
systemVerify(data, signatureHex)      // Verify with system public key
getSystemPublicKey()                  // Accessor

// --- Existing (unchanged) ---
sign(data)           // HMAC-SHA256 with REK (kept for JWT, deprecate for permissions)
verify(data, sig)    // HMAC-SHA256 with REK (kept for JWT, deprecate for permissions)
encrypt(data, key)   // AES-256-GCM
decrypt(data, key)   // AES-256-GCM
fingerprint(data, userKey) // HMAC-SHA256 with user key (will be replaced by Ed25519)
deriveUserKey(umk, userID) // HMAC-SHA256(umk, userID) → 32-byte key (kept, used for user private key encryption)
wrapUMK(umk)         // AES with REK
unwrapUMK(wrapped)   // AES with REK
```

### Final Implementation Order

With system key pair in a file instead of DB, there's no circular dependency.
Everything flows linearly:

```
Phase A: Cryptographic Infrastructure
  A1: SMK file management (loadServerMasterKey)
  A2: Ed25519 methods + key encryption helpers
  A3: System key pair (file-based, loaded at boot)
  A4: User key pairs (User model columns, generated at registration)
  A5: Agent key pairs (Agent model columns, generated at creation)

Phase B: ValueStore
  B1: ValueStore model (new table)
  B2: ValueStoreService (CRUD + signed ops + search)
  B3: Agent config → ValueStore migration (async wrappers, drop config column)
  B4: Session context → ValueStore migration (async wrappers, drop context column)
  B5: User settings via ValueStore (new methods)
  B6: New memory tools (getValue, setValue, searchValues)

Phase C: Permission Signing Migration
  C1: Frame signature field (new column + in-memory class)
  C2: PermissionService → Ed25519 (sign with user private key, verify with public)
  C3: PermissionEngine fingerprint → Ed25519
  C4: PermissionPlugin → read frame.signature, verify with public key
  C5: Frame authorship signing (user/agent/system keys per authorType)

Phase D: Danger Level Permissions
  D1: Permission engine 3-way branch (strict/normal/permissive)
  D2: API endpoints (agent + auth controllers, signed writes)
  D3: UI (agent form dropdown, settings page dropdown)

Phase E: Tests (throughout, TDD where possible)
```

### What's Deferred (Explicitly)

| Feature | Why | When |
|---------|-----|------|
| Plugin actor key pairs | Plugin lifecycle undefined | When plugins are designed |
| Key rotation | Separate concern | After this implementation |
| Federation protocol | Multi-server | Way later |
| Two-layer envelope | Federation concern | Way later |

### Remaining Concern: Existing API Key Encryption

Today, agent API keys are encrypted with the user's key (`deriveUserKey(UMK, userID)`).
This means the API key can only be decrypted when the user is present. Should we
migrate API key encryption to use SMK-derived keys (same as Ed25519 private keys)?

Arguments for:
- Agents could decrypt their own API keys independently (no user needed)
- Consistent pattern: all agent secrets encrypted with SMK

Arguments against:
- Currently works fine — interactions always start from authenticated requests
- User's key is stronger security (UMK never touches the server's file system)
- Changing this is scope creep

My recommendation: **leave API key encryption as-is for now**. It works, it's more
secure, and agent interactions will always have a user context (even if agent
*signing* doesn't need one). We can revisit if/when agents truly need to act
without any user context.

---

## Phase E: Comprehensive Test Plan

Tests are organized per implementation phase. Every section includes happy paths,
failure paths, edge cases, and adversarial scenarios.

### E-A1: SMK File Management

**File:** `spec/core/crypto/smk-spec.mjs`

Happy path:
- First boot with no server.key → generates file, 32 bytes, mode 0600
- Subsequent boot → loads existing file, same key material
- KIKX_SERVER_KEY_FILE env var → reads from custom path
- Generated SMK is 32 bytes (64 hex chars)

Failure path:
- server.key file is empty → regenerate (or throw?)
- server.key file contains non-hex garbage → throw with clear error
- server.key file is wrong length (16 bytes, 64 bytes) → throw
- Config directory doesn't exist → create it (mkdir -p equivalent)
- Config directory not writable → throw with path in error message
- File permissions are too open (0644) → log warning? (don't break, just warn)

Edge cases:
- Path contains spaces or unicode
- server.key is a symlink → follow it (normal fs behavior)

### E-A2: Ed25519 Methods

**File:** `spec/core/crypto/ed25519-spec.mjs`

Happy path:
- generateSigningKeyPair() returns { publicKey, privateKey } as PEM strings
- signWithPrivateKey(data, key) → hex string (128 chars for Ed25519)
- verifyWithPublicKey(data, key, sig) → true for matching data/key/sig
- Sign → verify round trip with string data
- Sign → verify round trip with object data (canonicalized)
- Different data → different signatures
- Same data + same key → same signature (Ed25519 is deterministic)
- Two different key pairs → different signatures for same data

Failure path:
- verifyWithPublicKey with wrong public key → false
- verifyWithPublicKey with tampered data → false
- verifyWithPublicKey with tampered signature → false
- verifyWithPublicKey with truncated signature → false
- verifyWithPublicKey with empty string signature → false
- signWithPrivateKey with null data → throw
- signWithPrivateKey with null key → throw
- signWithPrivateKey with invalid PEM → throw
- verifyWithPublicKey with invalid PEM → false (not throw — verify is a question, not a command)
- signWithPrivateKey with a public key (wrong key type) → throw
- verifyWithPublicKey with a private key (wrong key type) → false

Edge cases:
- Sign empty string → valid signature (empty string is valid data)
- Sign very large string (1MB) → works, reasonable performance
- Canonicalize with nested objects, arrays, null values, undefined keys
- Canonicalize with keys in different order → same canonical form
- Non-ASCII data (unicode, emoji, binary-as-string)

### E-A2b: Actor/User Key Encryption Helpers

**File:** `spec/core/crypto/key-encryption-spec.mjs`

Happy path:
- encryptActorPrivateKey → decryptActorPrivateKey round trip
- encryptUserPrivateKey → decryptUserPrivateKey round trip
- Different actorIDs → different encryption (can't cross-decrypt)
- Different userIDs → different encryption
- Different UMKs → different encryption
- Encrypted output is JSON-parseable (AES-256-GCM envelope: { ciphertext, iv, authTag })

Failure path:
- decryptActorPrivateKey with wrong actorID → throw (AES-GCM auth tag failure)
- decryptUserPrivateKey with wrong UMK → throw
- decryptUserPrivateKey with wrong userID → throw
- decryptActorPrivateKey with corrupted ciphertext → throw
- decryptActorPrivateKey with corrupted authTag → throw
- decryptActorPrivateKey with null encrypted data → throw
- encryptActorPrivateKey with null privateKey → throw
- encryptActorPrivateKey with null actorID → throw

Edge cases:
- actorID with special characters (colons, slashes, unicode)
- Very long actorID

### E-A3: System Key Pair

**File:** `spec/core/crypto/system-keypair-spec.mjs`

Happy path:
- First boot → generates system-signing.pub and system-signing.key.enc
- Subsequent boot → loads existing files
- systemSign(data) → hex signature
- systemVerify(data, sig) → true
- systemSign → systemVerify round trip
- getSystemPublicKey() returns PEM string

Failure path:
- system-signing.pub exists but system-signing.key.enc missing → regenerate both
- system-signing.key.enc exists but system-signing.pub missing → regenerate both
- system-signing.key.enc encrypted with different SMK → throw (can't decrypt)
- system-signing.pub corrupted (not valid PEM) → throw
- system-signing.key.enc corrupted → throw

Edge cases:
- SMK changed since last boot (simulates key rotation without re-encryption) → clear error message

### E-A4: User Key Pairs

**File:** `spec/core/crypto/user-keypair-spec.mjs`

Happy path:
- Registration generates key pair on User record
- User.publicKey is PEM string
- User.encryptedPrivateKey is JSON string (AES-GCM envelope)
- Decrypt private key with correct UMK + userID → valid Ed25519 private key
- Sign with decrypted private key, verify with User.publicKey → true
- Different users get different key pairs

Failure path:
- Decrypt with wrong UMK → throw
- Decrypt with wrong userID → throw
- User created before Ed25519 migration (no publicKey) → null (handled gracefully)
- Corrupted encryptedPrivateKey → throw on decrypt attempt

### E-A5: Agent Key Pairs

**File:** `spec/core/crypto/agent-keypair-spec.mjs`

Happy path:
- Agent creation generates key pair on Agent record
- Agent.publicKey is PEM string
- Agent.encryptedPrivateKey is JSON string
- Decrypt private key with correct actorID → valid Ed25519 private key
- Sign with decrypted private key, verify with Agent.publicKey → true
- Different agents get different key pairs
- Agent key decryption does NOT require user's UMK

Failure path:
- Decrypt with wrong actorID → throw
- Agent created before Ed25519 migration (no publicKey) → null
- Corrupted encryptedPrivateKey → throw on decrypt attempt
- SMK changed → all agent keys fail to decrypt → clear error

### E-B1: ValueStore Model

**File:** `spec/core/models/value-store-model-spec.mjs`

Happy path:
- Create with all fields → persisted, readable
- Unique constraint on (ownerType, ownerID, namespace, scopeID, key)
- Different scopeIDs → different entries for same owner+namespace+key
- scopeID defaults to '' (empty string)
- Indexes exist and queries use them

Failure path:
- Duplicate (ownerType, ownerID, namespace, scopeID, key) → constraint violation
- Missing required fields (ownerType, ownerID, namespace, key) → validation error
- ownerType not in ['agent', 'user', 'session'] → validation error (if we validate)
- namespace not in ['config', 'context', 'memory'] → validation error (if we validate)

Edge cases:
- Very long key (256 chars, boundary)
- Very long value (TEXT(long) — MB range)
- Key with special characters (dots, colons, slashes)
- Empty string value vs null value
- scopeID = '' is treated differently than scopeID = null in UNIQUE index

### E-B2: ValueStoreService

**File:** `spec/core/lib/value-store-service-spec.mjs`

Happy path — CRUD:
- get() returns parsed value
- get() for missing key → null
- set() creates new entry
- set() updates existing entry (upsert)
- set(null) deletes the entry
- set(undefined) deletes the entry
- getAll() returns { key: value } object
- getAll() for owner with no entries → {}
- setAll() bulk upserts multiple keys
- delete() removes entry
- delete() for missing key → no error (idempotent)

Happy path — signed operations:
- setSigned() stores value + HMAC signature
- getVerified() with valid signature → returns value
- setSigned → getVerified round trip
- Different keys for different users → can't cross-verify

Happy path — search:
- search with query → matches on key names
- search with query → matches on value content
- search with empty query → lists all entries in scope
- search with limit → respects limit
- search with offset → skips entries
- search with limit + offset → pagination works
- search returns { results: [...], count }

Failure path — CRUD:
- get() with corrupted JSON value → null + log warning
- setAll() with empty object → no-op (no error)

Failure path — signed operations:
- getVerified() with tampered value (changed after signing) → null
- getVerified() with tampered signature → null
- getVerified() with missing signature → null
- getVerified() with wrong userKey → null
- getVerified() for missing entry → null
- setSigned() with null userKey → throw
- Copy signature from user A's entry to user B's entry → verification fails

Failure path — search:
- search with SQL injection attempt in query → safe (parameterized)
- search with negative limit → treat as default
- search with negative offset → treat as 0

Edge cases:
- Value is a number (0, -1, NaN) → stored as JSON, retrieved correctly
- Value is a boolean (false) → not confused with null/missing
- Value is an empty object {} → stored, not confused with missing
- Value is an empty array [] → stored correctly
- Value is a deeply nested object → JSON round-trips correctly
- Concurrent set() on same key → last write wins (no corruption)

### E-B3: Agent Config Migration

**File:** `spec/core/models/agent-config-migration-spec.mjs`

Happy path:
- getConfig() returns AGENT_DEFAULTS merged with stored values
- updateConfig() stores individual keys via ValueStore
- getSafeConfig() strips PROTECTED_KEYS
- getAbilities() returns abilities text or null
- setAbilities(text) stores abilities
- setAbilities('') clears abilities (deletes entry)
- setAbilities(null) clears abilities
- All methods are async

Failure path:
- getConfig() when ValueStore has no entries → AGENT_DEFAULTS
- updateConfig() with protected key (apiKey) → key stored but stripped by getSafeConfig()
- riskLevel in PROTECTED_KEYS → agents can't self-set via tool

Edge cases:
- Config with keys not in AGENT_DEFAULTS → included in getConfig() result
- updateConfig() doesn't clobber unrelated keys

### E-B4: Session Context Migration

**File:** `spec/core/models/session-context-migration-spec.mjs`

Happy path:
- getContext() returns stored context entries
- setContext() replaces all entries
- updateContext() merges with existing
- getEffectiveContext() walks parent chain, merges root-down
- All methods are async

Failure path:
- getContext() with no entries → {}
- getEffectiveContext() with no parent → own context only
- getEffectiveContext() with orphaned parent (deleted) → graceful fallback

Edge cases:
- Deep parent chain (5+ levels) → all contexts merged correctly
- Child key overrides parent key → child wins
- Parent has key, child doesn't → parent's value inherited

### E-B5: User Settings

**File:** `spec/core/models/user-settings-spec.mjs`

Happy path:
- getSettings() returns USER_DEFAULTS merged with stored
- updateSettings() with non-sensitive key → stored unsigned
- updateSettings() with riskLevel → stored with Ed25519 signature
- getVerifiedSettings() with valid signature → returns settings
- getVerifiedSettings() riskLevel verified, other keys returned as-is
- USER_DEFAULTS = { riskLevel: 'normal' }

Failure path:
- getVerifiedSettings() with tampered riskLevel → riskLevel excluded/null
- getVerifiedSettings() with missing signature on riskLevel → riskLevel excluded/null
- getVerifiedSettings() with different user's key → riskLevel excluded/null
- updateSettings() without userKey when setting riskLevel → throw
- updateSettings({ riskLevel: 'invalid' }) → validation error
- updateSettings({ riskLevel: '' }) → validation error
- getVerifiedSettings() when no settings exist → USER_DEFAULTS (safe)

Edge cases:
- updateSettings() with mix of sensitive and non-sensitive keys
- User with no settings at all → defaults work

### E-B6: Memory Tools

**File:** `spec/core/internal-plugins/memory-tools-spec.mjs`

Happy path:
- memory:getValue returns stored value
- memory:setValue stores value, returns confirmation
- memory:searchValues returns matching entries
- memory:setValue to 'memory' namespace → allowed
- memory:setValue to 'context' namespace → allowed

Failure path:
- memory:setValue to 'config' namespace → blocked with clear error
- memory:getValue for missing key → null (not error)
- memory:searchValues with no results → empty array
- memory:setValue with missing key param → validation error
- memory:setValue with missing value param → validation error

Edge cases:
- memory:searchValues with empty query → lists all
- Very long value stored and retrieved

### E-C1: Frame Signature Field

**File:** `spec/core/models/frame-signature-spec.mjs`

Happy path:
- Frame created with signature field → stored and retrieved
- Frame.signature is nullable → null by default
- In-memory Frame class has signature property
- FrameManager.commit() accepts signature option

Failure path:
- Frame with signature longer than 256 chars → truncated or rejected

Edge cases:
- Existing frames (pre-migration) have no signature → null, no errors
- Frame serialization includes signature field

### E-C2: PermissionService Ed25519

**File:** `spec/core/permissions/permission-service-ed25519-spec.mjs`

Happy path:
- signApproval() signs with user's Ed25519 private key
- verifyApproval() verifies with user's Ed25519 public key
- signApproval → verifyApproval round trip → true
- createStandingApproval() signs metadata with Ed25519
- Deterministic: same input + same key → same signature

Failure path:
- verifyApproval() with wrong user's public key → false
- verifyApproval() with tampered featureName → false
- verifyApproval() with tampered args → false
- verifyApproval() with tampered sessionID → false
- verifyApproval() with garbage signature → false
- verifyApproval() with empty signature → false
- signApproval() without private key → throw

Edge cases:
- Approval blob with empty args ({}) → deterministic canonical form
- Approval blob with null sessionID → included in canonical form
- Approval blob with complex nested args → canonicalized consistently

### E-C3: PermissionEngine Fingerprint Ed25519

**File:** `spec/core/permissions/fingerprint-ed25519-spec.mjs`

Happy path:
- createRule() with privateKey generates Ed25519 fingerprint
- _filterByFingerprint() with matching publicKey → rule included
- Fingerprint data format: `${orgID}:${featureName}:${effect}:${scope}`

Failure path:
- _filterByFingerprint() with wrong publicKey → rule excluded
- _filterByFingerprint() with tampered rule data → rule excluded
- createRule() without privateKey → no fingerprint (null)

### E-C4: PermissionPlugin Update

**File:** `spec/core/internal-plugins/permission-plugin-ed25519-spec.mjs`

Happy path:
- Reads frame.signature (not frame.content._signature)
- Verifies with author's public key → passes
- frame.content._signature ignored (backward compat — old field unused)

Failure path:
- Invalid frame.signature → warning logged, frame not blocked (warn-only?)
- frame.signature present but author has no public key → warning logged

Edge cases:
- Frame with no signature → passes through (not all frames are signed approvals)
- Frame with both frame.signature and frame.content._signature → uses frame.signature

### E-C5: Frame Authorship Signing

**File:** `spec/core/signing/frame-authorship-spec.mjs`

Happy path:
- User-authored frame signed with user's private key
- User-authored frame verified with user's public key → true
- Agent-authored frame signed with agent's private key
- Agent-authored frame verified with agent's public key → true
- System-authored frame signed with system private key
- System-authored frame verified with system public key → true

Failure path:
- Verify user's frame with agent's public key → false
- Verify agent's frame with user's public key → false
- Verify agent's frame with system's public key → false
- Author has no key pair (legacy) → frame created without signature (null)

Cross-signing:
- Frame signed by user A, verified with user A's public key → true
- Frame signed by user A, verified with user B's public key → false
- Frame signed by agent X, verified with agent X's public key → true
- Frame signed by agent X, verified with agent Y's public key → false

### E-D1: Permission Engine Risk Levels

**File:** `spec/core/permissions/permission-engine-risklevel-spec.mjs`

Happy path — resolution chain:
- Agent has riskLevel → uses it
- Agent has no riskLevel, user has riskLevel → uses user's
- Neither has riskLevel → falls back to 'strict'
- Agent 'permissive' overrides user 'strict'
- User 'permissive' applies when agent has no value

Happy path — strict mode:
- Parent session allow rule does NOT apply to child session
- Own session allow rule applies normally
- Global allow rule applies normally
- Deny rules still work

Happy path — normal mode:
- Existing walk-up behavior (regression test)
- Parent session rules apply to child sessions
- All current permission tests still pass

Happy path — permissive mode:
- No matching rules → auto-approved (returns false)
- Permissions.checkPermission() returns true → respected (still needs approval)
- Permissions.checkPermission() returns false → respected (explicitly allowed)
- Permissions.checkPermission() returns null → auto-approved

Failure path — permissive mode:
- Deny rule → still denied (throws PermissionDeniedError)
- Critical tool risk level → still needs approval (returns true)
- CrossSessionPermissions.createSession → still needs approval

Failure path — resolution chain:
- agent is null/undefined → no agent riskLevel, fall through to user
- agent.getConfig() throws → catch and fallback to 'strict'
- userRiskLevel is null → fallback to 'strict'
- userRiskLevel is unrecognized string → fallback to 'strict'
- riskLevel is a number instead of string → type check, fallback to 'strict'
- riskLevel is empty string → fallback to 'strict'

Backward compatibility:
- 'medium' in agent config → treated as 'normal'
- 'medium' in user settings → treated as 'normal'

### E-D2: API Endpoints

**File:** `spec/server/controllers/risklevel-api-spec.mjs`

Happy path:
- Agent update with valid riskLevel → stored + signed in ValueStore
- Agent update with riskLevel = null → clears (falls back to user default)
- User settings update with riskLevel → stored + signed
- User settings GET → returns current riskLevel

Failure path:
- Agent update with invalid riskLevel → 400
- Agent update without auth → 401
- Agent riskLevel for agent in different org → 403/404
- User settings update without auth → 401
- User settings with invalid riskLevel → 400

### E-Tamper: Tamper Detection Integration

**File:** `spec/core/permissions/tamper-detection-spec.mjs`

Scenarios:
- Write riskLevel via API → read back verified → matches
- Tamper value in DB directly, leave signature → verification fails → 'strict'
- Tamper signature in DB directly, leave value → verification fails → 'strict'
- Tamper both value and signature → verification fails → 'strict'
- Delete ValueStore row → getVerified returns null → 'strict'
- Copy signature from another user's entry → fails (different key)
- Agent writes riskLevel='permissive' directly to DB → signature mismatch → 'strict'
- Agent modifies both value and signature → can't forge without user's private key → 'strict'

---

### Test Summary

| Phase | File | Estimated Tests |
|-------|------|----------------|
| A1: SMK | smk-spec.mjs | ~12 |
| A2: Ed25519 | ed25519-spec.mjs | ~25 |
| A2b: Key encryption | key-encryption-spec.mjs | ~18 |
| A3: System key pair | system-keypair-spec.mjs | ~10 |
| A4: User key pairs | user-keypair-spec.mjs | ~8 |
| A5: Agent key pairs | agent-keypair-spec.mjs | ~10 |
| B1: ValueStore model | value-store-model-spec.mjs | ~12 |
| B2: ValueStoreService | value-store-service-spec.mjs | ~40 |
| B3: Agent config | agent-config-migration-spec.mjs | ~12 |
| B4: Session context | session-context-migration-spec.mjs | ~10 |
| B5: User settings | user-settings-spec.mjs | ~14 |
| B6: Memory tools | memory-tools-spec.mjs | ~10 |
| C1: Frame signature | frame-signature-spec.mjs | ~6 |
| C2: PermissionService | permission-service-ed25519-spec.mjs | ~14 |
| C3: Fingerprint | fingerprint-ed25519-spec.mjs | ~6 |
| C4: PermissionPlugin | permission-plugin-ed25519-spec.mjs | ~6 |
| C5: Frame authorship | frame-authorship-spec.mjs | ~14 |
| D1: Risk levels | permission-engine-risklevel-spec.mjs | ~25 |
| D2: API endpoints | risklevel-api-spec.mjs | ~10 |
| Tamper detection | tamper-detection-spec.mjs | ~8 |
| **Total** | **20 spec files** | **~270 tests** |

Note: This count doesn't include modifications to existing test files that will
need updating (e.g., existing permission-service-spec.mjs, fingerprint-spec.mjs,
permission-plugin-spec.mjs will need Ed25519 equivalents or migration).

---

I believe the design is now complete. All questions resolved, all phases ordered,
no circular dependencies, comprehensive test plan with failure paths. Ready to
write plan files and start execution whenever you give the word.