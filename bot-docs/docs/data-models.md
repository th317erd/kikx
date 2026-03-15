# Kikx — Data Models

Kikx uses Mythix ORM with SQLite as the default database. All models extend `ModelBase` which provides automatic `createdAt`/`updatedAt` timestamps. The system is multi-tenant with `Organization` as the top-level container.

Model source files are in `src/core/models/`.

---

## Entity Relationship Overview

```
Organization (root container)
  |-- User (members)
  |     \-- Role (org-level roles)
  |-- Agent (configured AI agents)
  |     \-- Participant (agent-session binding)
  |-- Session (chat sessions)
  |     |-- Participant (agents in session)
  |     |-- Frame (messages/events in session)
  |     |-- Child Sessions (nested sessions)
  |     \-- ValueStore (context entries)
  |-- PermissionRule (access controls)
  \-- ValueStore (flexible key-value storage)
        |-- User settings (namespace='config')
        |-- Agent config (namespace='config')
        \-- Session context (namespace='context')
```

---

## Organization

**Table**: `organizations` | **ID prefix**: `org_`

| Field | Type | Nullable | Purpose |
|-------|------|----------|---------|
| `id` | XID | No | Primary key |
| `name` | STRING(128) | No | Organization name (indexed) |
| `createdAt` | DATETIME | No | Auto-managed |
| `updatedAt` | DATETIME | No | Auto-managed |

Top-level tenant container. All entities belong to an organization. Equivalent to a Discord server.

---

## User

**Table**: `users` | **ID prefix**: `usr_` | **Version**: 2

| Field | Type | Nullable | Purpose |
|-------|------|----------|---------|
| `id` | XID | No | Primary key |
| `organizationID` | FK(Organization) | No | Tenant scope |
| `email` | STRING(128) | No | Login email (unique per org, lowercased) |
| `firstName` | STRING(64) | Yes | Display name |
| `lastName` | STRING(64) | Yes | Display name |
| `avatar` | TEXT | Yes | Base64-encoded avatar (128x128 max) |
| `passwordSlot` | TEXT | Yes | Encrypted UMK wrapped by password (zero-knowledge vault) |
| `publicKey` | TEXT | Yes | Ed25519 public key (PEM) |
| `encryptedPrivateKey` | TEXT | Yes | Ed25519 private key (encrypted with UMK-derived key) |

**Key methods**: `getDisplayName()`, `getSettings()`, `updateSettings()`, `getVerifiedSettings()`

**Settings** are stored in ValueStore (namespace `config`). Signed keys: `riskLevel` (requires private key). Valid risk levels: `'strict'`, `'normal'`, `'permissive'`.

---

## Role

**Table**: `roles` | **ID prefix**: `rol_`

| Field | Type | Nullable | Purpose |
|-------|------|----------|---------|
| `id` | XID | No | Primary key |
| `organizationID` | FK(Organization) | No | Tenant scope |
| `userID` | FK(User) | No | User this role belongs to |
| `name` | STRING(64) | No | Role name (e.g., 'admin', 'member') |

Org-level role assignment. Tracks who has what role in which organization.

---

## Agent

**Table**: `agents` | **ID prefix**: `agt_` | **Version**: 3

| Field | Type | Nullable | Purpose |
|-------|------|----------|---------|
| `id` | XID | No | Primary key |
| `organizationID` | FK(Organization) | No | Tenant scope |
| `name` | STRING(128) | No | Agent display name |
| `pluginID` | STRING(128) | No | Agent plugin type (e.g., `claude`, `openai`) |
| `encryptedAPIKey` | TEXT | Yes | AES-256-GCM encrypted API key (JSON: ciphertext, iv, authTag) |
| `instructions` | TEXT | Yes | Custom system prompt additions |
| `dmSummary` | TEXT | Yes | Auto-generated summary from DM sessions |
| `publicKey` | TEXT | Yes | Ed25519 public key (PEM) |
| `encryptedPrivateKey` | TEXT | Yes | Ed25519 private key (encrypted with SMK-derived key) |

**Config** is stored in ValueStore (namespace `config`, scopeID `''`). Methods: `getConfig()`, `setConfig()`, `updateConfig()`.

**Abilities** are stored as `config.abilities`. Methods: `getAbilities()`, `setAbilities()`, `hasAbilities()`.

**Protected keys** (excluded from `getSafeConfig()`): `apiKey`, `encryptedAPIKey`, `riskLevel`.

---

## Session

**Table**: `sessions` | **ID prefix**: `ses_` | **Version**: 4

| Field | Type | Nullable | Purpose |
|-------|------|----------|---------|
| `id` | XID | No | Primary key |
| `organizationID` | FK(Organization) | No | Tenant scope |
| `name` | STRING(256) | No | Session name (default: 'New Session') |
| `type` | STRING(32) | No | `'chat'` (normal) or `'dm'` (agent configuration) |
| `dmAgentID` | STRING(128) | Yes | For DM sessions: the agent this DM configures |
| `archived` | BOOLEAN | No | Soft archive flag (default: false) |
| `parentSessionID` | FK(Session) | Yes | Parent session for nesting (sub-sessions) |
| `linkedFrameID` | STRING(128) | Yes | Frame ID in parent representing this sub-session |
| `maxInteractions` | INTEGER | Yes | Max agent-authored commits (null = unconstrained) |
| `endsAt` | DATETIME | Yes | Deadline after which session is constrained |

**Session hierarchy**: Sessions can be nested via `parentSessionID`. `getEffectiveContext()` merges context from root to leaf (child wins).

**Context** is stored in ValueStore (namespace `context`). Methods: `getContext()`, `setContext()`, `updateContext()`, `getEffectiveContext()`.

---

## Participant

**Table**: `participants` | **ID prefix**: `prt_` | **Version**: 2

| Field | Type | Nullable | Purpose |
|-------|------|----------|---------|
| `id` | XID | No | Primary key |
| `sessionID` | FK(Session) | No | Which session |
| `agentID` | FK(Agent) | No | Which agent |
| `role` | STRING(32) | No | Role in session (default: 'member') |

Join table binding agents to sessions. An agent can be in multiple sessions; a session can have multiple agents.

---

## Frame

**Table**: `frames` | **ID prefix**: `frm_` | **Version**: 2

| Field | Type | Nullable | Purpose |
|-------|------|----------|---------|
| `id` | XID | No | Primary key |
| `sessionID` | FK(Session) | No | Which session |
| `interactionID` | STRING(128) | No | Root ancestor interaction ID (denormalized) |
| `parentID` | STRING(128) | Yes | Immediate parent frame |
| `order` | INTEGER | No | Monotonic counter per session |
| `groupID` | STRING(128) | Yes | Phantom frame grouping ID |
| `groupType` | STRING(64) | Yes | Phantom group type |
| `type` | STRING(64) | No | Frame type (see below) |
| `content` | TEXT | Yes | JSON payload |
| `targets` | TEXT | Yes | JSON array of targeted frame IDs |
| `authorType` | STRING(32) | Yes | 'User', 'Agent', or 'System' |
| `authorID` | STRING(128) | Yes | Who created this frame |
| `hidden` | BOOLEAN | No | Visible in UI but excluded from agent context |
| `deleted` | BOOLEAN | No | Soft delete flag |
| `processed` | BOOLEAN | No | Processing state for interaction replay |
| `processedAt` | DATETIME | Yes | When frame was processed |
| `signature` | STRING(256) | Yes | Ed25519 signature (hex) |
| `timestamp` | BIGINT | No | Milliseconds since epoch |

**Frame types**: `user-message`, `message` (agent), `tool-call`, `tool-result`, `permission-request`, `permission-denied`, `hook-blocked`, `tool-error`, `error`, `reflection`, `command-result`, `stop`

**Phantom frames**: Fire-and-forget frames (not persisted individually). When they share a `groupID`, they collapse into a single persistent group frame via deep-merge. Used for streaming token outputs.

---

## ValueStore

**Table**: `value_stores` | **ID prefix**: `vs_`

| Field | Type | Nullable | Purpose |
|-------|------|----------|---------|
| `id` | XID | No | Primary key |
| `organizationID` | FK(Organization) | No | Tenant scope |
| `ownerType` | STRING(32) | No | Type of owner ('User', 'Agent', 'Session') |
| `ownerID` | STRING(128) | No | ID of owner |
| `namespace` | STRING(64) | No | Namespace ('config', 'context', 'memory') |
| `scopeID` | STRING(128) | No | Sub-scope (default: '') |
| `key` | STRING(256) | No | Key name |
| `value` | TEXT | Yes | JSON-encoded value |
| `signature` | STRING(256) | Yes | Ed25519 signature (hex) for signed entries |
| `signingKeyFingerprint` | STRING(64) | Yes | SHA-256 fingerprint of signing key |

**Composite index**: `[ownerType, ownerID, namespace, scopeID, key]` for lookups.

Unified key-value store replacing inline JSON blob columns. Supports Ed25519 signing for verified entries. Used by:
- **Agents**: config (abilities, plugin settings)
- **Sessions**: context (conversation metadata)
- **Users**: settings (preferences like riskLevel)

---

## PermissionRule

**Table**: `permission_rules` | **ID prefix**: `prm_`

| Field | Type | Nullable | Purpose |
|-------|------|----------|---------|
| `id` | XID | No | Primary key |
| `organizationID` | FK(Organization) | No | Tenant scope |
| `featureName` | STRING(256) | No | Format: `pluginID:toolName` (e.g., `shell:execute`) |
| `effect` | STRING(16) | No | `'allow'` or `'deny'` |
| `scope` | STRING(32) | No | `'global'`, `'session'`, or `'frame'` |
| `scopeID` | STRING(128) | Yes | Session or frame ID for scoped rules |
| `metadata` | TEXT | Yes | JSON: plugin-specific matching data |
| `priority` | INTEGER | No | Higher = evaluated first (default: 0) |
| `createdBy` | STRING(128) | No | User ID of rule creator |
| `fingerprint` | STRING(128) | Yes | HMAC-SHA256 for rule integrity |
| `expiresAt` | DATETIME | Yes | Optional expiration |

**Evaluation**: Rules are loaded by feature name + organization, filtered by expiration and scope ancestry, then evaluated in priority order. First match wins. `deny` throws a hard error; `allow` bypasses approval; no match requires human approval.

---

## Schema Migrations

SQLite schema migrations run on startup in `KikxCore._runSchemaMigrations()`. They are idempotent (safe to run repeatedly):

1. **Frame v2**: Add `signature` column
2. **User v2**: Add `publicKey`, `encryptedPrivateKey` columns
3. **Agent v3**: Add `publicKey`, `encryptedPrivateKey` columns

All use `ALTER TABLE ADD COLUMN` with try/catch to handle "duplicate column name" errors gracefully.

---

## Cryptographic Patterns

### Key Hierarchy

```
SMK (Server Master Key)
  \-- Per-user derived keys (PBKDF2)
        |-- Agent API key encryption (AES-256-GCM)
        \-- Agent private key encryption (AES-256-GCM)

UMK (User Master Key)
  \-- Per-user encryption
        |-- Password slot (vault pattern)
        \-- User private key encryption

System Key Pair (Ed25519)
  |-- Frame signing
  \-- JWT issuance
```

### Value Signing

ValueStore entries can be signed with Ed25519. The signing payload includes the composite key (`ownerType:ownerID:namespace:scopeID:key`) plus the canonical JSON value, preventing cross-scope and cross-owner replay attacks.
