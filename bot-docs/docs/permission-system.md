# Permission System — Architecture & Data Flow

Comprehensive reference for the Kikx permission system. Covers the
permission engine, rule model, tool risk levels, session ancestry
walk-up, cross-session routing, and the full approval lifecycle.

Updated: 2026-03-13

---

## 1. Key Components

| Component | File | Purpose |
|-----------|------|---------|
| PermissionEngine | `src/core/permissions/permission-engine.mjs` | Core decision logic |
| PermissionService | `src/core/permissions/permission-service.mjs` | High-level wrapper + HMAC signing |
| PermissionRule | `src/core/models/permission-rule-model.mjs` | Database model for rules |
| PermissionHandler | `src/core/interaction/permission-handler.mjs` | Hard-break lifecycle in interactions |
| PermissionDeniedError | `src/core/permissions/permission-denied-error.mjs` | Hard-deny error type |
| Permissions (base) | `src/core/permissions/permissions-base.mjs` | Extension point for custom matching |
| ShellPermissions | `src/core/internal-plugins/shell/shell-permissions.mjs` | Per-command matching |
| CrossSessionPermissions | `src/core/internal-plugins/cross-session/cross-session-permissions.mjs` | createSession always needs approval |
| StructuralACLValidator | `src/core/permissions/structural-acl-validator.mjs` | Frame type restrictions per actor |

---

## 2. PermissionEngine.checkPermission()

**Signature:** `async checkPermission(featureName, args, options = {})`

**Options:**
- `organizationID` (required) — scopes rules to org
- `scope` ('global', 'session', 'frame') — current scope context
- `scopeID` — session/frame ID for scoped rules
- `toolClass` — tool class reference for risk level
- `agent` — agent object for config.riskLevel (NOT currently passed from controller — gap)
- `verifyFingerprint` / `userKey` — optional HMAC verification

**Returns:**
- `false` — allowed (no approval needed)
- `true` — needs approval
- Throws `PermissionDeniedError` — hard deny (no approval can override)

**Decision Flow:**

```
1. Tool riskLevel === 'none'      → return false (auto-allow)
2. Tool riskLevel === 'critical'  → return true  (always needs approval)
3. Agent config.riskLevel check   → currently only 'medium' supported
4. Query PermissionRule by org + featureName
5. Filter expired rules
6. Build ancestry chain via sessionManager.getAncestryChain()
7. Filter by scope hierarchy (walk-up for session-scoped rules)
8. Optional fingerprint verification
9. Sort: ancestry distance (closer first), then priority (higher first)
10. Custom Permissions subclass checkPermission() — can short-circuit
11. First-match-wins rule loop:
    - effect: 'deny'  → throw PermissionDeniedError
    - effect: 'allow' → return false
12. No match → return true (default deny)
```

---

## 3. PermissionRule Schema

| Field | Type | Notes |
|-------|------|-------|
| `id` | XID (`prm_`) | Primary key |
| `organizationID` | FK → Organization | Required, CASCADE |
| `featureName` | STRING(256) | `pluginID:toolName` format |
| `effect` | STRING(16) | `'allow'` or `'deny'` |
| `scope` | STRING(32) | `'global'`, `'session'`, `'frame'` (default: global) |
| `scopeID` | STRING(128) | Session/frame ID when scoped |
| `metadata` | TEXT(long) | JSON blob for plugin-specific data |
| `priority` | INTEGER | Higher = evaluated first (default: 0) |
| `createdBy` | STRING(128) | User ID |
| `fingerprint` | STRING(128) | Optional HMAC-SHA256 |
| `expiresAt` | DATETIME | Optional expiration |

---

## 4. Tool Risk Levels

| Level | Behavior |
|-------|----------|
| `none` | Auto-allowed, no approval needed |
| `low` | Low-risk capabilities auto-allowed (checked in controller) |
| `high` | Standard, needs approval unless allow rule exists |
| `critical` | Always needs approval, ignores allow rules (safety net) |

Declared as static property on tool classes: `static riskLevel = 'high'`

---

## 5. Agent Config & riskLevel

**Agent model** (`src/core/models/agent-model.mjs`) stores config in a `TEXT(long)` JSON field.

**Default config:**
```js
const AGENT_DEFAULTS = { riskLevel: 'medium' };
```

**Methods:** `getConfig()`, `setConfig(value)`, `updateConfig(partial)`, `getSafeConfig()`

**Current limitation:** `PermissionEngine.checkPermission()` throws if
`config.riskLevel !== 'medium'`. Only one level is currently supported.

**Gap:** The controller does NOT pass the `agent` object to
`permissionEngine.checkPermission()` — it only passes `organizationID`.
The engine falls back to `{ riskLevel: 'medium' }` default.

---

## 6. Session Ancestry Walk-Up

**SessionManager.getAncestryChain(sessionID):**
- Returns `[sessionID, parentID, grandparentID, ...]` (self-to-root)
- Cached (ancestry is immutable)
- Max depth: 100, with circular reference guard

**Used in permission engine:** Session-scoped rules from ancestor sessions
apply to child sessions. Closer ancestors take priority (by distance in
the ancestry chain).

**getNearestUserAncestor(sessionID):**
- Returns closest ancestor (including self) with a user-authored frame
- Used by PermissionHandler to route requests to the nearest human

---

## 7. Permission Hard-Break Lifecycle

When a tool call needs approval:

```
1. InteractionLoop detects needsPermission === true
2. PermissionHandler.hardBreak()
   a. Create pending-action frame (in current session)
   b. Find nearest user ancestor via getNearestUserAncestor()
   c. If no user anywhere → deny immediately
   d. Create permission-request frame (in target user session)
   e. Destroy generator (pause interaction)
   f. Store _permissionWaiting state
3. User approves/denies via HTTP endpoint
4. PermissionHandler.approve() or .deny()
   a. Execute or skip the tool
   b. Create tool-result frame
   c. Mark pending-action + permission-request as processed
   d. Clear _permissionWaiting state
   e. Start NEW interaction with replayFromPermission: true
```

---

## 8. Custom Permissions Subclasses

Tools can provide a `Permissions` subclass for custom logic:

**Extension Points:**

| Method | Returns | Purpose |
|--------|---------|---------|
| `checkPermission()` | `true`/`false`/`null` | Pre-rule short-circuit |
| `matchesRule(rule, args, metadata)` | `{ matches: boolean }` | Per-rule custom matching |

**Existing subclasses:**

- **ShellPermissions**: Exact command+arguments matching against stored metadata
- **CrossSessionPermissions**: `createSession` always returns `true` (needs approval);
  `postToSession` auto-approves if agent is a participant

---

## 9. Controller Integration

**InteractionController.sendMessage()** builds a `checkPermission` callback:

```
1. Translate system:command → command:${name}
2. User-issued commands → always allowed
3. Shell commands → per-command evaluation with parseShellCommands()
4. Low-risk capabilities → auto-allowed
5. Everything else → permissionEngine.checkPermission()
```

**Options passed:** `{ organizationID, scope: 'session', scopeID, toolClass }`

**Missing:** `agent` object is NOT passed (engine falls back to default).

---

## 10. Approval Endpoint

**POST /api/v2/sessions/:sessionID/interact/approve/:frameID**

Accepts optional `decisions` array for per-command choices:
- `allow-once` / `deny-once` — one-time, no persistent rule
- `allow-forever` / `deny-forever` — creates session-scoped PermissionRule

Any `deny-once` or `deny-forever` in decisions → entire request denied.
