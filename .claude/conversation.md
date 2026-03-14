# Danger Level Permissions — Implementation Recommendation

## Context

The existing plan (`bot-docs/future-plans/danger-level-permissions.yaml`) defines three
agent-level risk tolerances: Low, Medium, Yolo. After deep analysis of the permission
engine, agent model, interaction controller, and UI components, here's my concrete
recommendation for implementation.

Full permission system reference: `bot-docs/docs/permission-system.md`

---

## What Exists Today

1. **Agent config already has `riskLevel: 'medium'` as a default** — stored in the
   `config` JSON column on the Agent model, returned by `agent.getConfig()`.

2. **PermissionEngine reads `config.riskLevel`** but currently **throws** if it's
   anything other than `'medium'`. This is the exact gate we need to unlock.

3. **Tool-level `riskLevel`** is a separate concept (none/low/high/critical) declared
   on tool classes. This is about how risky the *tool* is. The agent-level setting
   is about how much risk the *agent is allowed to take*.

4. **Session ancestry walk-up** already works — rules from parent sessions apply to
   children. This is the inheritance that "strict" mode would disable.

5. **CrossSessionPermissions.createSession** already returns `true` unconditionally —
   a pre-rule safety override that bypasses rule matching entirely.

6. **Gap found:** The `agent` object is NOT passed from InteractionController to
   `permissionEngine.checkPermission()`. Only `organizationID` is extracted. The
   engine falls back to `{ riskLevel: 'medium' }`. This must be fixed.

---

## Recommended Level Names

The plan uses "Low / Medium / Yolo" but I recommend clearer, more professional names:

| Plan Name | Recommended Name | Config Value | Description |
|-----------|-----------------|--------------|-------------|
| Low | **Strict** | `'strict'` | No inheritance. Every session needs its own approvals. |
| Medium | **Normal** | `'medium'` | Current behavior. Walk-up inheritance, tool-level approval. |
| Yolo | **Permissive** | `'permissive'` | Auto-approve most tools. Critical tools + safety overrides still respected. |

<!-- 
I like the fun! Let's go with both our ideas:
| Plan Name | Recommended Name | Config Value | Description |
|-----------|-----------------|--------------|-------------|
| Strict | **Strict** | `'strict'` | No inheritance. Every session needs its own approvals. |
| Normal | **Normal** | `'medium'` | Current behavior. Walk-up inheritance, tool-level approval. |
| Permissive (YOLO) | **Permissive** | `'permissive'` | Auto-approve most tools. Critical tools + safety overrides still respected. |
 -->
---

## Behavioral Specification

### `strict` Mode

- **No ancestry walk-up.** When filtering rules by scope, restrict `ancestorSessionIDs`
  to only `[currentSessionID]` — don't walk up to parent sessions.
- **Effect:** Approvals granted in a parent session do NOT carry to child sessions.
  Each session starts with a clean slate. Agents must earn approvals in every session.
- **Everything else unchanged** — tool risk levels, rule matching, deny rules all work normally.
<!-- 
Yes.
 -->

### `~~medium~~normal` Mode (default, current behavior)
<!-- 
Claude, let's go with "normal". That fits in a little better I think.
 -->

- **No changes needed.** This is what's already implemented.
- Walk-up inheritance, session-scoped rules from ancestors apply.

### `permissive` Mode

- **Auto-approve everything** after the safety checks, UNLESS:
  - Tool has `riskLevel === 'critical'` (existing safety net, step 2 in the engine)
  - A `Permissions` subclass explicitly returns `true` from `checkPermission()` (e.g.,
    CrossSessionPermissions.createSession)
- **Implementation:** After running the pre-rule check (step 10-11 in the engine),
  if the result is `null` (defer to rules), return `false` (auto-approve) instead
  of proceeding to rule matching. If the pre-rule check returns `true`, respect it.
  <!-- 
  Don't forget to _also_ respect it if it returns `false`!
   -->
- **Deny rules are still honored** — if a deny rule exists and the pre-rule check
  defers, we should skip rule matching entirely and auto-approve. Deny rules are
  an admin safety mechanism, but in `permissive` mode the agent owner has explicitly
  opted out of friction. (Debatable — open for discussion.)
  <!-- 
  No... let's not let it be THAT permissive. Let's say the user has a rule that says "NO NOT READ FILES FROM MY HOME FOLDER". We want the agent to respect that. If a "deny" rule is given, it should flow down the chain, and the end result should be "denied".

  It is with the APPROVALs that we are being permissive.
   -->
---

## Implementation Plan

### Step 1: Fix the `agent` passthrough gap

**File:** `src/server/controllers/interaction-controller.mjs`

The `checkPermission` callback currently passes:
```js
{ organizationID, scope: 'session', scopeID, toolClass }
```

Add `agent: resolvedAgent` to the options. This applies to both the general tool
check AND the shell per-command check (two call sites in the callback).

### Step 2: Unlock the permission engine gate

**File:** `src/core/permissions/permission-engine.mjs`

Replace the current hard throw:
```js
if (config.riskLevel !== 'medium')
  throw new Error(`Unsupported risk level: ${config.riskLevel}`);
```

With branching logic:
```js
let agentRiskLevel = config.riskLevel || 'medium';

// Validate the risk level
if (!['strict', 'medium', 'permissive'].includes(agentRiskLevel))
  throw new Error(`Unsupported risk level: ${agentRiskLevel}`);

// PERMISSIVE: auto-approve (critical tools already returned true above)
// Still run pre-rule checks from Permissions subclasses for safety overrides
if (agentRiskLevel === 'permissive') {
  // Run custom Permissions.checkPermission() if tool provides one
  if (permissionsInstance) {
    let preRuleResult = await permissionsInstance.checkPermission(...);
    if (preRuleResult === true)
      return true;  // Safety override says needs approval
  }
  return false;  // Auto-approve everything else
}

// STRICT: restrict ancestry to current session only (no walk-up)
if (agentRiskLevel === 'strict')
  ancestorSessionIDs = scopeID ? [scopeID] : [];
// Response from user: NO parenthesis on ternary!? Oh my quirkiness! 😱

// MEDIUM: existing behavior (walk-up, full rule matching)
// ... rest of existing code ...
```

Note: The `permissive` branch needs to be inserted AFTER the pre-rule
instance is created (step 10) but BEFORE rule matching (step 12). The
`strict` branch just narrows the ancestry chain before the existing
scope filtering.

### Step 3: Validate riskLevel on Agent model

**File:** `src/core/models/agent-model.mjs`

Add validation in `updateConfig()` or `setConfig()`:
```js
const VALID_RISK_LEVELS = new Set(['strict', 'medium', 'permissive']);

// In updateConfig or setConfig:
if (value.riskLevel && !VALID_RISK_LEVELS.has(value.riskLevel))
  throw new Error(`Invalid riskLevel: ${value.riskLevel}`);
```

### Step 4: Expose riskLevel in Agent API

**File:** `src/server/controllers/agent-controller.mjs`

The `update()` method currently handles `name`, `pluginID`, `instructions`, `apiKey`.
Add `riskLevel` as an accepted body parameter:

```js
let { name, pluginID, instructions, apiKey, riskLevel } = body || {};

// ... existing update logic ...

if (riskLevel) {
  agent.updateConfig({ riskLevel });
  await agent.save();
}
```

### Step 5: Add riskLevel dropdown to agent form modal

**File:** `src/client/components/kikx-agent-form-modal/kikx-agent-form-modal.mjs`

Add a `<select>` dropdown with three options:
- Strict — "Every tool needs explicit approval per session"
- Normal — "Inherited permissions, balanced security" (default)
- Permissive (YOLO) — "Auto-approve most tools (critical tools still prompt)"

Wire it to read/write from the agent API via the existing save flow.

### Step 6: Write tests

- **Permission engine tests:** All three levels with various tool risk levels
- **Strict mode:** Verify parent session rules don't apply to child sessions
- **Permissive mode:** Verify auto-approval, critical tools still prompt,
  createSession still prompts
- **Agent model:** Validate riskLevel values
- **API tests:** Update agent riskLevel via endpoint

---

## Affected Files

| File | Change |
|------|--------|
| `src/core/permissions/permission-engine.mjs` | Branch on riskLevel (strict/medium/permissive) |
| `src/server/controllers/interaction-controller.mjs` | Pass `agent` to checkPermission options |
| `src/core/models/agent-model.mjs` | Validate riskLevel values |
| `src/server/controllers/agent-controller.mjs` | Accept `riskLevel` in update endpoint |
| `src/client/components/kikx-agent-form-modal/kikx-agent-form-modal.mjs` | Add risk level dropdown |
| `src/client/lib/api.mjs` | Pass riskLevel in agent update call (if needed) |

---

## Open Questions

1. **Should `permissive` mode honor deny rules?** If an admin creates an explicit
   deny rule, should it still block in permissive mode? The safest answer is yes,
   but it adds complexity. My recommendation: skip rule matching entirely in
   permissive mode — if an admin wants to restrict an agent, they should set it
   to `medium` or `strict`, not fight against `permissive` with deny rules.

   <!-- 
   Yes, it should honor deny rules.
    -->

2. **Should agents be able to change their own riskLevel?** The memory tools
   (memory:updateAgentConfig) allow agents to self-update config. Should
   `riskLevel` be added to `PROTECTED_KEYS` to prevent agents from escalating
   themselves to `permissive`? **Recommendation: Yes, protect it.** Only humans
   should set the risk level.

   <!-- 
   No, they should not. Yes, please add to protected keys.
    -->

3. **Naming:** The plan calls this "Danger Level" but the existing config field
   is `riskLevel`. Should we rename the feature to "Risk Level" for consistency
   with existing code, or add a new `dangerLevel` field? **Recommendation: Keep
   `riskLevel`** — it's already in the codebase with a default, no migration needed.

   <!-- 
    Let's keep "riskLevel". Let's just make the label verbiage match the concept.
    -->

---

## Complexity Assessment

This is a **small-to-medium** implementation. The permission engine changes are
surgical — we're replacing a `throw` with a 3-way branch. The biggest pieces
of work are the tests and the UI dropdown. No new models, no migrations, no
new services.

Estimated: ~6 files changed, ~200-300 lines of implementation + ~200-400 lines of tests.

<!--
Great job! Append the next round of conversation here.
 -->

---

## Round 2 — Refined Plan (incorporating feedback)

All open questions are now resolved. Here's the final, concrete plan.

### Resolved Decisions

1. **Level names:** Strict / Normal / Permissive (YOLO)
   - Config values: `'strict'` / `'medium'` / `'permissive'`
   - Display name "Normal" maps to config value `'medium'` (existing default, no migration)
   <!-- 
   Let's migrate "medium" to "normal" even in the code. I don't like how "medium" could be confused with size or volume.
    -->

2. **Permissive mode honors deny rules.** We are permissive with *approvals*,
   not with *denials*. If a deny rule says "block file reads from /home", that
   still blocks. The change is only to the default when NO rule matches: instead
   of "needs approval" → "auto-approved".

3. **Permissive pre-rule check:** Respect ALL return values from
   `Permissions.checkPermission()` — `true` (needs approval), `false`
   (auto-allow), and `null` (defer → auto-approve in permissive mode).

4. **riskLevel is a protected key.** Agents cannot self-escalate. Only humans
   set the risk level via the UI/API.

5. **Keep `riskLevel` config key.** UI labels match the concept
   (Strict/Normal/Permissive), not the raw config value.

### Simplification Insight

After digesting the deny-rules feedback, I realized the implementation is even
simpler than proposed in Round 1. The entire permissive mode change boils down
to **one line**: flip the default at the end of `checkPermission()` from
`return true` to `return false`.

Here's why this works:
- Deny rules already throw `PermissionDeniedError` → unchanged, still blocks
- Allow rules already return `false` → same result as auto-approve, irrelevant
- Pre-rule checks (createSession, etc.) still return `true` → respected
- Critical tool safety net returns `true` early → respected
- The ONLY difference: when no rule matches, return `false` instead of `true`

For strict mode, we restrict `ancestorSessionIDs` before scope filtering.
Everything else runs unchanged.

### Final Implementation Steps

**Step 1: Fix the `agent` passthrough gap**
`src/server/controllers/interaction-controller.mjs`
- Add `agent: resolvedAgent` to both `permissionEngine.checkPermission()` call
  sites in the `checkPermission` callback (general tool check + shell per-command)

**Step 2: Unlock the permission engine**
`src/core/permissions/permission-engine.mjs`
- Replace the `throw` with validation of `['strict', 'medium', 'permissive']`
- For `strict`: narrow `ancestorSessionIDs` to `(scopeID) ? [scopeID] : []`
  before existing scope filtering
- For `permissive`:
  - Run pre-rule check (Permissions subclass) — respect all return values
  - Run rule matching — deny rules still throw, allow rules still return false
  - Change final `return true` to `return false` (auto-approve when no rule matches)
- For `medium`: no changes (existing behavior)

**Step 3: Protect riskLevel from agent self-modification**
`src/core/models/agent-model.mjs` (or wherever PROTECTED_KEYS is defined)
- Add `'riskLevel'` to the protected keys set
- Add validation: only accept `'strict'`, `'medium'`, `'permissive'`

**Step 4: Expose riskLevel in Agent API**
`src/server/controllers/agent-controller.mjs`
- Accept `riskLevel` in the update body
- Write via `agent.updateConfig({ riskLevel })`

**Step 5: UI dropdown**
`src/client/components/kikx-agent-form-modal/kikx-agent-form-modal.mjs`
- Add `<select>` with:
  - Strict — "Every tool needs explicit approval per session"
  - Normal — "Inherited permissions, balanced security" (default)
  - Permissive (YOLO) — "Auto-approve most tools (critical tools still prompt)"
- Read current value from agent config, write on save

**Step 6: Tests**
- Permission engine: all three levels × tool risk levels
- Strict: parent session allow rules DON'T apply to child
- Permissive: auto-approve, deny rules still block, critical still prompts,
  createSession still prompts
- Agent model: validate riskLevel, protected key enforcement
- API: update riskLevel via endpoint

### Affected Files (final)

| File | Change |
|------|--------|
| `src/core/permissions/permission-engine.mjs` | 3-way branch, strict ancestry restriction |
| `src/server/controllers/interaction-controller.mjs` | Pass `agent` to checkPermission options |
| `src/core/models/agent-model.mjs` | Validate riskLevel, add to PROTECTED_KEYS |
| `src/server/controllers/agent-controller.mjs` | Accept `riskLevel` in update |
| `src/client/components/kikx-agent-form-modal/kikx-agent-form-modal.mjs` | Risk level dropdown |
| `src/client/lib/api.mjs` | Pass riskLevel in agent update (if needed) |

<!--
I like this plan! Good work!

But I just realized that I forgot something! I want the same selectbox and config value ON THE USER'S ACCOUNT! Under the "Settings" on the "Permissions" tab we have.

The account level config will be the default, if a value wasn't set on the agent.

The makes the "riskLevel" of the agent optional, adds a "riskLevel" to the user's account (encrypted, so the agent can't modify it), and "strict" as a final fallback.

Let's go another round. Append here.
 -->

---

## Round 3 — Account-Level Default + `medium` → `normal` Migration

### New Requirements

1. **User account gets a `riskLevel` setting** — same dropdown, stored on the User model
2. **Agent `riskLevel` becomes optional** — if not set, falls back to user's account setting
3. **Resolution chain:** Agent config → User account → `'strict'` fallback
4. **Rename `'medium'` → `'normal'`** everywhere in code
5. **No encryption needed** — agents have no tools to access user records, so a plain
   `settings` JSON column on User is already safe from agent tampering

### What Exists on the User Model Today

The User model is intentionally minimal:

| Field | Type | Notes |
|-------|------|-------|
| `id` | XID (`usr_`) | Primary key |
| `organizationID` | FK → Organization | |
| `email` | STRING(128) | |
| `firstName` | STRING(64) | |
| `lastName` | STRING(64) | |
| `avatar` | TEXT(long) | Base64 |
| `passwordSlot` | TEXT(long) | Encrypted UMK |

**No settings/config field exists.** We need to add one.

### Settings Page Permissions Tab

Currently a stub:
```html
<div class="section-heading">Permission Grants</div>
<div class="empty-state">No permission grants to display.</div>
```

This is where the riskLevel dropdown will go.

### API Endpoint

`PUT /api/v2/auth/me` currently accepts `{ firstName, lastName, email, avatar }`.
Needs to also accept `settings` or `riskLevel`.

---

### Proposed Design

**User Model Changes:**
- Add `settings` TEXT(long) JSON column (like Agent's `config` — extensible for future settings)
- Add `getSettings()` — parse JSON, merge with defaults, return cloned object
- Add `updateSettings(partial)` — shallow merge into existing settings
- Default: `{ riskLevel: 'normal' }`

**Resolution Chain in Permission Engine:**
```
1. agent.getConfig().riskLevel   →  if set, use it
2. options.userRiskLevel         →  if set, use it (from User.getSettings())
3. 'strict'                      →  final fallback (most restrictive)
```

This means:
- A user sets their account to "Permissive (YOLO)" → all their agents auto-approve by default
- They can override a specific agent to "Strict" for sensitive work
- If neither is set (new user, new agent), behavior is "Strict" — safe default

**Agent Config Change:**
- Remove `riskLevel` from `AGENT_DEFAULTS` — it's now truly optional
- When `getConfig()` returns no `riskLevel`, the permission engine falls through to the user's account setting
- Agent form dropdown gets a 4th option: "Account Default" (empty/null value)

**`medium` → `normal` Migration:**
- Change default on User model to `'normal'`
- Accept `'medium'` as a backward-compat alias → treat as `'normal'` internally
- No DB migration needed: no existing data stores explicit riskLevel values
  (it was always applied via `getConfig()` default merge, never persisted)

---

### Updated Implementation Steps

**Step 1: Fix the `agent` passthrough gap** *(unchanged)*
`src/server/controllers/interaction-controller.mjs`
- Pass `agent: resolvedAgent` to `permissionEngine.checkPermission()` options

**Step 1b: Pass user riskLevel to permission engine**
`src/server/controllers/interaction-controller.mjs`
- Look up User record (already have `this.request.userID`)
- Read `user.getSettings().riskLevel`
- Pass `userRiskLevel` in the `checkPermission` callback options

**Step 2: Add `settings` column to User model**
`src/core/models/user-model.mjs`
- Add `settings` TEXT(long) field
- Add `getSettings()` / `updateSettings(partial)` methods
- Default: `{ riskLevel: 'normal' }`

**Step 3: Unlock the permission engine**
`src/core/permissions/permission-engine.mjs`
- Replace the `throw` with resolution chain:
  ```
  agent.getConfig().riskLevel → options.userRiskLevel → 'strict'
  ```
- Normalize `'medium'` → `'normal'` for backward compat
- Validate: `['strict', 'normal', 'permissive']`
- `strict`: restrict ancestry to current session only
- `normal`: existing walk-up behavior
- `permissive`: run full pipeline but flip no-match default to `false`

**Step 4: Update Agent model**
`src/core/models/agent-model.mjs`
- Remove `riskLevel` from `AGENT_DEFAULTS` (now optional)
- Add `'riskLevel'` to PROTECTED_KEYS
- Validate riskLevel values when explicitly set

**Step 5: Expose riskLevel in APIs**
- `src/server/controllers/agent-controller.mjs` — accept `riskLevel` in agent update
- `src/server/controllers/auth-controller.mjs` — accept `riskLevel` (or `settings`)
  in `PUT /api/v2/auth/me`

**Step 6: Agent form dropdown**
`src/client/components/kikx-agent-form-modal/kikx-agent-form-modal.mjs`
- Add `<select>` with 4 options:
  - **Account Default** — uses the user's account-level setting (value: empty/null)
  - **Strict** — "Every tool needs explicit approval per session"
  - **Normal** — "Inherited permissions, balanced security"
  - **Permissive (YOLO)** — "Auto-approve most tools (critical tools still prompt)"

**Step 7: Settings page permissions tab**
`src/client/components/kikx-settings-page/kikx-settings-page.mjs`
- Replace the "no grants" stub with the same dropdown (3 options, no "Account Default")
- Read from `user.settings.riskLevel`, write via `PUT /api/v2/auth/me`

**Step 8: Tests**
- Permission engine: all three levels, resolution chain (agent → user → fallback)
- Strict: no ancestry walk-up
- Permissive: auto-approve, deny rules still block, critical still prompts
- User model: getSettings/updateSettings, riskLevel default
- Agent model: optional riskLevel, protected key
- API: update user riskLevel, update agent riskLevel
- Backward compat: `'medium'` treated as `'normal'`

### Updated Affected Files

| File | Change |
|------|--------|
| `src/core/permissions/permission-engine.mjs` | Resolution chain, 3-way branch |
| `src/server/controllers/interaction-controller.mjs` | Pass `agent` + `userRiskLevel` |
| `src/core/models/user-model.mjs` | Add `settings` column + methods |
| `src/core/models/agent-model.mjs` | Remove riskLevel default, add to PROTECTED_KEYS |
| `src/server/controllers/agent-controller.mjs` | Accept `riskLevel` in update |
| `src/server/controllers/auth-controller.mjs` | Accept `riskLevel` in profile update |
| `src/client/components/kikx-agent-form-modal/kikx-agent-form-modal.mjs` | Dropdown (4 options) |
| `src/client/components/kikx-settings-page/kikx-settings-page.mjs` | Permissions tab dropdown |
| `src/client/lib/api.mjs` | Pass riskLevel in updates |

### Complexity Update

Still small-to-medium. The User model change is the biggest new piece (adding a
column + methods), but it follows the exact same pattern as Agent's `config` field.
The permissions tab UI is replacing a stub, not building from scratch.

---

## Round 4 — Tamper-Proof Settings via HMAC Signing

### The Problem

The agent runs on the **same host** as the database and webserver. Even with
`PROTECTED_KEYS` guarding the API, a malicious agent could write directly to
the database (e.g. via shell tool) and change `riskLevel` from `'strict'` to
`'permissive'` — self-escalating its own permissions.

### The Solution: Sign, Don't Encrypt

Store the settings value in **plaintext** (so the permission engine can read it),
but **HMAC-sign it** with the user's private key. On every read, verify the
signature. If it doesn't match → the value was tampered with → fall back to
`'strict'`.

This is **defense in depth** — not perfect against a truly malicious actor with
process memory access (nothing is on a shared host), but it catches the most
likely attack vectors: direct DB writes, tool-based mutation, API manipulation.

### Existing Infrastructure

The Keystore already has exactly the primitives we need:

| Method | Key Source | Purpose |
|--------|-----------|---------|
| `keystore.fingerprint(data, userKey)` | Per-user key | HMAC-SHA256 → 64-char hex |
| `keystore.deriveUserKey(umk, userID)` | UMK + userID | Deterministic key derivation |
| `request.getUMK()` | JWT vault claim | Lazy-unwrap UMK from authenticated request |

**Key stability:** The user key is derived from the UMK (created at registration,
stored in `passwordSlot`). It does NOT depend on the ephemeral REK, so signatures
**survive server restarts**. After re-authentication, the same UMK is recovered
from the password slot, producing the same user key.

### Signing Flow

**When user updates settings** (`PUT /api/v2/auth/me`):
```
1. Server receives { riskLevel: 'permissive' }
2. Derive user key:  keystore.deriveUserKey(request.getUMK(), request.userID)
3. Build settings JSON: JSON.stringify({ riskLevel: 'permissive' })
4. Sign:  keystore.fingerprint(settingsJSON, userKey)
5. Store both:  user.settings = settingsJSON,  user.settingsSignature = signature
```

**When permission engine reads settings** (during interaction):
```
1. Load user record (already needed for resolution chain)
2. Derive user key:  keystore.deriveUserKey(request.getUMK(), request.userID)
3. Verify:  keystore.fingerprint(user.settings, userKey) === user.settingsSignature
4. If valid   → use settings.riskLevel
5. If invalid → fall back to 'strict' (tampered or missing signature)
```

### What This Catches

| Attack Vector | Caught? | Why |
|---------------|---------|-----|
| Direct DB write (SQL/shell) | Yes | Agent doesn't have UMK → can't forge signature |
| Unauthorized API mutation | Yes | No authenticated endpoint for agent to call |
| Process memory extraction | No | UMK is in memory during authenticated sessions |
| Compromised server process | No | Game over regardless |

### Implementation Changes

**User Model** (`src/core/models/user-model.mjs`):
- Add `settingsSignature` STRING(128) column alongside `settings` TEXT(long)
- `updateSettings(partial, userKey)` — merges settings, computes signature, stores both
- `verifySettings(userKey)` — returns `true` if signature matches, `false` otherwise
- `getVerifiedSettings(userKey)` — returns settings if verified, `null` if tampered

**Auth Controller** (`src/server/controllers/auth-controller.mjs`):
- On settings update: derive user key, pass to `user.updateSettings()`
- Signature computed server-side, never sent by client

**Interaction Controller** (`src/server/controllers/interaction-controller.mjs`):
- In the `checkPermission` callback: load user, derive user key, verify settings
- Pass verified `userRiskLevel` to permission engine (or `'strict'` on verification failure)

**No client changes** — the client sends `{ riskLevel: 'permissive' }`, the server
handles signing transparently. The client never sees or handles signatures.

### Updated Implementation Steps

**Step 1: Fix the `agent` passthrough gap** *(unchanged)*

**Step 1b: Pass verified user riskLevel to permission engine**
`src/server/controllers/interaction-controller.mjs`
- Load user record, derive user key from `request.getUMK()`
- Call `user.getVerifiedSettings(userKey)` — returns settings if signature valid
- Pass `userRiskLevel` in `checkPermission` callback options
- On verification failure: pass `'strict'` as fallback

**Step 2: Add `settings` + `settingsSignature` to User model**
`src/core/models/user-model.mjs`
- `settings` TEXT(long) — JSON blob (extensible for future settings)
- `settingsSignature` STRING(128) — HMAC-SHA256 hex string
- `getSettings()` — parse JSON, merge with defaults `{ riskLevel: 'normal' }`
- `updateSettings(partial, userKey)` — merge, stringify, sign, save both fields
- `verifySettings(userKey)` — `keystore.fingerprint(settings, userKey) === settingsSignature`
- `getVerifiedSettings(userKey)` — verify then return, or `null` on failure

**Step 3: Unlock the permission engine** *(unchanged from Round 3)*
- Resolution chain: agent config → verified user settings → `'strict'` fallback
- Normalize `'medium'` → `'normal'` for backward compat
- `strict`: restrict ancestry to current session only
- `normal`: existing walk-up behavior
- `permissive`: run full pipeline, flip no-match default to `false`

**Step 4: Update Agent model** *(unchanged from Round 3)*
- Remove `riskLevel` from `AGENT_DEFAULTS`
- Add `'riskLevel'` to PROTECTED_KEYS
- Validate riskLevel values when explicitly set

**Step 5: Expose riskLevel in APIs**
- `src/server/controllers/agent-controller.mjs` — accept `riskLevel` in agent update
- `src/server/controllers/auth-controller.mjs` — accept `riskLevel` in profile update,
  derive user key, call `user.updateSettings()` with signature

**Step 6: Agent form dropdown** *(unchanged from Round 3)*
- 4 options: Account Default / Strict / Normal / Permissive (YOLO)

**Step 7: Settings page permissions tab** *(unchanged from Round 3)*
- Replace stub with dropdown (3 options, no "Account Default")
- Read/write via `PUT /api/v2/auth/me`

**Step 8: Tests**
- All previous test categories plus:
- Settings signing: `updateSettings()` produces valid signature
- Settings verification: tampered settings fail verification
- Tampered DB value: permission engine falls back to `'strict'`
- Missing signature: treated as tampered (fallback)
- Server restart: signatures remain valid (user key is UMK-derived, not REK-derived)

### Updated Affected Files

| File | Change |
|------|--------|
| `src/core/permissions/permission-engine.mjs` | Resolution chain, 3-way branch |
| `src/server/controllers/interaction-controller.mjs` | Pass `agent` + verified `userRiskLevel` |
| `src/core/models/user-model.mjs` | Add `settings` + `settingsSignature` columns, signing methods |
| `src/core/models/agent-model.mjs` | Remove riskLevel default, add to PROTECTED_KEYS |
| `src/server/controllers/agent-controller.mjs` | Accept `riskLevel` in update |
| `src/server/controllers/auth-controller.mjs` | Accept `riskLevel`, sign settings on update |
| `src/client/components/kikx-agent-form-modal/kikx-agent-form-modal.mjs` | Dropdown (4 options) |
| `src/client/components/kikx-settings-page/kikx-settings-page.mjs` | Permissions tab dropdown |
| `src/client/lib/api.mjs` | Pass riskLevel in updates |

### Complexity Update

Slightly larger than Round 3 — the signing adds ~30 lines to the User model and
~10 lines to each controller that touches settings. But the crypto primitives
already exist (`keystore.fingerprint`, `keystore.deriveUserKey`), so we're just
wiring them together. No new crypto code needed.

<!--
Let's also update the "configContext" (the agent's personal data store) for the agent.

While we are at it, I want the agent config to be plural. We need to move the agent (and now user) config to a separate "values" or "contexts" or "configs" table.

Reasoning: Not only do we now need a place to store an (evergrowing) config for the user, but we already have such a need for the agent, and the risk is also the same for the agent.

Besides, this fits perfectly in to my next plan I was going to have us work on: queryable storage for agents, so they can store memories and details.

Next round.
 -->

---

## Round 5 — Unified Config Store Table

### Motivation

Today, config/settings data lives as inline JSON blobs on individual models:

| Entity | Field | Pattern |
|--------|-------|---------|
| Agent | `config` TEXT(long) | `getConfig()` / `updateConfig()` / `PROTECTED_KEYS` |
| Session | `context` TEXT(long) | `getContext()` / `updateContext()` / `getEffectiveContext()` |
| User | *(nothing yet)* | — |

Problems with JSON blobs:
1. **Not queryable** — can't ask "which agents have `riskLevel: permissive`?"
2. **Not individually signable** — the whole blob is one opaque unit
3. **Same tampering risk** on agent config as on user settings (same host)
4. **Not extensible** for agent memories/storage — stuffing everything into
   one JSON column is a dead end

### Proposal: `ConfigValue` Table

A unified key-value store that replaces all three inline JSON columns:

| Field | Type | Notes |
|-------|------|-------|
| `id` | XID (`cfg_`) | Primary key |
| `organizationID` | FK → Organization | CASCADE, required |
| `ownerType` | STRING(32) | `'agent'`, `'user'`, `'session'` |
| `ownerID` | STRING(128) | The entity's ID |
| `namespace` | STRING(64) | Grouping: `'config'`, `'context'`, `'memory'` |
| `key` | STRING(256) | The setting key (e.g., `'riskLevel'`, `'abilities'`) |
| `value` | TEXT(long) | JSON-encoded value |
| `signature` | STRING(128) | Optional HMAC-SHA256 (nullable) |
| `createdAt` | DATETIME | From ModelBase |
| `updatedAt` | DATETIME | From ModelBase |

<!-- 
Let's add a "scopeID" here too. For example, if the agent wants to store memories, it will want to do so per-session. Right now this design allows for the agent to store its own values, but it doesn't have a good way to _organize_ that storage, and search on it later.
 -->

**Indexes:**
- UNIQUE: `(ownerType, ownerID, namespace, key)` — one value per entity/namespace/key
- INDEX: `(organizationID)` — org-scoped queries
- INDEX: `(ownerType, namespace, key)` — cross-entity queries like "all permissive agents"

### Namespace Design

| Namespace | Owner Types | Who Writes | Signed? |
|-----------|-------------|------------|---------|
| `config` | agent, user | Human (via UI/API) | Yes — sensitive keys |
| `context` | session | Agent (via memory tools) | No |
| `memory` | agent | Agent (via memory tools, future) | No |

The namespace provides clean permission boundaries:
- Agents can read/write their own `memory` namespace freely
- Agents can *read* their `config` namespace (via `getSafeConfig`)
- Agents **cannot write** to `config` namespace protected keys
- `context` namespace replaces Session's inline `context` column

### Signing Strategy

Not every entry needs signing — only sensitive keys that affect security:

| Key | Signed With | Why |
|-----|-------------|-----|
| `riskLevel` (user) | User's key (`deriveUserKey(UMK, userID)`) | Prevents agent self-escalation |
| `riskLevel` (agent) | User's key (same — user sets agent config) | Same risk |
| `abilities` (agent) | Not signed | Agent writes these itself |
| Session context keys | Not signed | Agent-managed runtime data |
| Future memory keys | Not signed | Agent's own storage |

Signing only happens when a human writes through an authenticated endpoint.
Agent-written values are inherently trusted *by the agent that wrote them* — the
concern is only about *other actors* tampering with *human-set* values.

### Service Layer: `ConfigStore`

Rather than scattering ConfigValue queries across every model, introduce a
`ConfigStore` service registered on `CascadingContext`:

```
ConfigStore
  .get(ownerType, ownerID, namespace, key)            → value or null
  .set(ownerType, ownerID, namespace, key, value, options)
  .getAll(ownerType, ownerID, namespace)               → { key: value, ... }
  .setAll(ownerType, ownerID, namespace, entries)       → bulk set
  .delete(ownerType, ownerID, namespace, key)
  .getVerified(ownerType, ownerID, namespace, key, userKey) → value or null (tamper check)
  .setSigned(ownerType, ownerID, namespace, key, value, userKey) → signs + stores
```

The existing model methods (`agent.getConfig()`, `session.getContext()`, etc.)
become thin wrappers that delegate to ConfigStore. This keeps the API surface
familiar while centralizing the storage logic.

### Model Method Migration

**Agent Model:**
```
getConfig()       → configStore.getAll('agent', this.id, 'config')
                    merged with AGENT_DEFAULTS
updateConfig(p)   → configStore.setAll('agent', this.id, 'config', p)
getSafeConfig()   → getConfig() with PROTECTED_KEYS stripped
getAbilities()    → configStore.get('agent', this.id, 'config', 'abilities')
setAbilities(t)   → configStore.set('agent', this.id, 'config', 'abilities', t)
```

**Session Model:**
```
getContext()            → configStore.getAll('session', this.id, 'context')
updateContext(p)        → configStore.setAll('session', this.id, 'context', p)
getEffectiveContext()   → walk parent chain, merge getAll results root-down
```

**User Model (new):**
```
getSettings()           → configStore.getAll('user', this.id, 'config')
                          merged with USER_DEFAULTS
updateSettings(p, ukey) → configStore.setSigned(...) for sensitive keys,
                          configStore.set(...) for others
getVerifiedSettings(uk) → configStore.getVerified('user', this.id, 'config', 'riskLevel', uk)
```

### Impact on Memory Plugin

The memory plugin tools currently do direct model operations:
- `memory:getAgentConfig` → `agent.getSafeConfig()`
- `memory:updateAgentConfig` → `agent.updateConfig()` + `agent.save()`
- `memory:getSessionContext` → `session.getContext()`
- `memory:updateSessionContext` → `session.updateContext()` + `session.save()`

<!-- 
We need generic "getAgentValue" and "setAgentValue", and "searchAgentValues" which will search names and content.
 -->

After migration, these same tools work through the model wrappers (which delegate
to ConfigStore). The tool code itself barely changes — the abstraction shift
happens underneath.

**Key difference:** `memory:updateAgentConfig` with a protected key like
`riskLevel` currently just strips it via `stripProtectedKeys()`. With ConfigStore,
we could additionally verify that the existing signed value hasn't been tampered
with before allowing other config updates.

### What About the Old Columns?

Since this is v2 pre-release with no production data:
- **Agent.config** — remove after migration (or keep as deprecated, no longer read)
- **Session.context** — same
- **User** — never had a settings column, so nothing to remove

If backward compat is a concern, the model wrappers can check the old column
as a fallback on first read, migrate the data to ConfigValue rows, and clear the
old column. But given pre-release status, a clean break is probably fine.

### Future: Agent Queryable Storage

This table is the **exact foundation** for the next planned feature. Agent memories
would use namespace `'memory'` with arbitrary keys:

```
ownerType: 'agent', ownerID: 'agt_xxx', namespace: 'memory'
key: 'user_preferences', value: '{"theme":"dark","language":"en"}'
key: 'conversation_summary', value: '"User is building a chat platform..."'
key: 'last_topic', value: '"permission system architecture"'
```

New memory tools would just be ConfigStore CRUD operations with
`namespace: 'memory'`.

<!-- 
No, let's not do this in the future. It is three more tools. We are working on this system now. Let's just add it.
 -->

### Updated Implementation Steps

**Step 0: Create ConfigValue model + ConfigStore service** *(NEW)*
- `src/core/models/config-value-model.mjs` — schema as above
- `src/core/config-store.mjs` (or `src/core/lib/config-store.mjs`) — service class
- Register ConfigStore on CascadingContext in application.mjs

**Step 1: Migrate Agent model to ConfigStore**
- `src/core/models/agent-model.mjs` — rewrite `getConfig()`, `updateConfig()`,
  `getSafeConfig()`, `getAbilities()`, `setAbilities()` as ConfigStore wrappers
- Remove `config` column (or mark deprecated)
- Remove `AGENT_DEFAULTS.riskLevel` (now optional)
- Add `'riskLevel'` to PROTECTED_KEYS

**Step 2: Migrate Session model to ConfigStore**
- `src/core/models/session-model.mjs` — rewrite `getContext()`, `updateContext()`,
  `getEffectiveContext()` as ConfigStore wrappers
- Remove `context` column (or mark deprecated)

**Step 3: Add User settings via ConfigStore**
- `src/core/models/user-model.mjs` — add `getSettings()`, `updateSettings()`,
  `getVerifiedSettings()` wrappers
- No column changes needed on User (data lives in ConfigValue table)

**Step 4: Fix the `agent` passthrough gap + user riskLevel resolution**
- `src/server/controllers/interaction-controller.mjs` — pass `agent` to
  checkPermission, load + verify user riskLevel, pass `userRiskLevel`

**Step 5: Unlock the permission engine**
- `src/core/permissions/permission-engine.mjs` — resolution chain, 3-way branch
- Same logic as Round 3-4, unchanged

**Step 6: Expose riskLevel in APIs**
- `src/server/controllers/agent-controller.mjs` — accept `riskLevel`, write via
  ConfigStore with signing
- `src/server/controllers/auth-controller.mjs` — accept `riskLevel`, write via
  ConfigStore with signing

**Step 7: Agent form dropdown**
- 4 options: Account Default / Strict / Normal / Permissive (YOLO)

**Step 8: Settings page permissions tab**
- Replace stub with dropdown (3 options)

**Step 9: Update memory plugin**
- `src/core/internal-plugins/memory/index.mjs` — tools delegate through model
  wrappers (minimal changes if model API stays the same)

**Step 10: Tests**
- ConfigValue model: CRUD, unique constraint, indexes
- ConfigStore service: get/set/getAll/setAll/delete, signing, verification,
  tampered value detection, missing signature fallback
- Agent model wrapper: getConfig/updateConfig round-trips through ConfigStore
- Session model wrapper: getContext/updateContext/getEffectiveContext
- User model wrapper: getSettings/updateSettings with signing
- Permission engine: resolution chain with verified settings
- Memory plugin: existing tools still work
- Backward compat: `'medium'` → `'normal'` normalization

### Updated Affected Files

| File | Change |
|------|--------|
| `src/core/models/config-value-model.mjs` | **NEW** — ConfigValue schema |
| `src/core/lib/config-store.mjs` | **NEW** — ConfigStore service |
| `src/server/application.mjs` | Register ConfigStore on context |
| `src/core/models/agent-model.mjs` | Rewrite config methods as ConfigStore wrappers |
| `src/core/models/session-model.mjs` | Rewrite context methods as ConfigStore wrappers |
| `src/core/models/user-model.mjs` | Add settings methods via ConfigStore |
| `src/core/permissions/permission-engine.mjs` | Resolution chain, 3-way branch |
| `src/server/controllers/interaction-controller.mjs` | Pass agent + verified userRiskLevel |
| `src/server/controllers/agent-controller.mjs` | Accept riskLevel, signed writes |
| `src/server/controllers/auth-controller.mjs` | Accept riskLevel, signed writes |
| `src/core/internal-plugins/memory/index.mjs` | Minimal updates (delegates through models) |
| `src/client/components/kikx-agent-form-modal/kikx-agent-form-modal.mjs` | Dropdown (4 options) |
| `src/client/components/kikx-settings-page/kikx-settings-page.mjs` | Permissions tab dropdown |
| `src/client/lib/api.mjs` | Pass riskLevel in updates |

### Complexity Update

This is now a **medium** implementation. The ConfigValue model + ConfigStore
service is the biggest new piece (~150-200 lines), but it follows well-established
ORM patterns. The model method rewrites are mechanical — same API surface, different
storage backend. The permission engine changes are still the same surgical branch
from Round 2.

### Open Questions

1. **Table name:** `ConfigValue`, `Property`, `Setting`, or something else? I
   proposed `ConfigValue` — it's descriptive and doesn't collide with any existing
   model names.

   <!-- 
   The only problem is that everything that will be stored here won't always be "config" related.

   Let's go with "ValueStore" instead.
    -->

2. **Clean break vs. fallback migration?** Since this is pre-release v2, I recommend
   just dropping the old columns. No fallback reads. But if you want graceful
   migration (read old column if ConfigValue is empty, migrate, clear old), that's
   ~20 extra lines per model.

   <!-- 
   Go for it. Drop em'.
    -->

3. **Should ConfigStore be async all the way?** The current `getConfig()` /
   `getContext()` methods are *synchronous* (they just parse `this.config` JSON).
   ConfigStore queries will be *async* (database reads). This means all callers
   need to `await`. The primer assembler and permission engine already use async,
   so this should be fine — but it's a breaking change to the model API surface.
   The memory plugin tools are also already async.

   <!-- 
   Yes, we will want this, especially with the agent being able to search for its own stored values.
    -->

<!--
Ready for the next round? I think we are getting close. I don't see any testing in this plan. Did you forget to use your ::agis.test* skills?
 -->

---

## Round 6 — Finalized Design + Test Protocol

### Resolved from Round 5 Feedback

1. **Table name:** `ValueStore` (model + table). Service: `ValueStoreService`.
2. **`scopeID` column added** — nullable, for per-session agent memories.
   Default: `''` (empty string, not NULL) to keep UNIQUE constraints working
   in SQLite (SQLite treats NULLs as distinct in UNIQUE indexes).
3. **Agent memory tools: build now, not later.** Three new tools:
   `memory:getValue`, `memory:setValue`, `memory:searchValues`.
4. **Clean break** — drop old `config`/`context` columns.
5. **Async all the way** — model wrapper methods become async.

### Final `ValueStore` Schema

| Field | Type | Notes |
|-------|------|-------|
| `id` | XID (`vs_`) | Primary key |
| `organizationID` | FK → Organization | CASCADE, required |
| `ownerType` | STRING(32) | `'agent'`, `'user'`, `'session'` |
| `ownerID` | STRING(128) | The entity's ID |
| `namespace` | STRING(64) | `'config'`, `'context'`, `'memory'` |
| `scopeID` | STRING(128) | Optional scoping (e.g., session ID). Default: `''` |
<!-- 
Why default to an empty string, instead of NULL?
 -->
| `key` | STRING(256) | The setting/memory key |
| `value` | TEXT(long) | JSON-encoded value |
| `signature` | STRING(128) | Optional HMAC-SHA256 (nullable) |
| `createdAt` | DATETIME | From ModelBase |
| `updatedAt` | DATETIME | From ModelBase |

**Indexes:**
- UNIQUE: `(ownerType, ownerID, namespace, scopeID, key)`
- INDEX: `(organizationID)`
- INDEX: `(ownerType, namespace, key)` — cross-entity queries
- INDEX: `(ownerType, ownerID, namespace, scopeID)` — "all values for this entity in this scope"

### `ValueStoreService` API

```
Core CRUD:
  .get(ownerType, ownerID, namespace, key, { scopeID })       → parsed value or null
  .set(ownerType, ownerID, namespace, key, value, { scopeID }) → void
  .getAll(ownerType, ownerID, namespace, { scopeID })          → { key: value, ... }
  .setAll(ownerType, ownerID, namespace, entries, { scopeID }) → void (bulk upsert)
  .delete(ownerType, ownerID, namespace, key, { scopeID })     → void

Signed operations:
  .setSigned(ownerType, ownerID, namespace, key, value, userKey, { scopeID })
  .getVerified(ownerType, ownerID, namespace, key, userKey, { scopeID }) → value or null

Search:
  .search(ownerType, ownerID, namespace, query, { scopeID })
    → [{ key, value, scopeID, updatedAt }, ...]
    Searches key names AND value content (LIKE-based).
```

### Memory Plugin: New Tools

**`memory:getValue`** — Read a stored value
```
riskLevel: 'low'
input: { key, namespace?, scopeID? }
  - namespace defaults to 'memory'
  - scopeID defaults to current session ID
output: { key, value, scopeID }
```

**`memory:setValue`** — Write a stored value
```
riskLevel: 'low'
input: { key, value, namespace?, scopeID? }
  - namespace defaults to 'memory'
  - Cannot write to 'config' namespace (enforced)
  - scopeID defaults to current session ID
output: { key, value, scopeID }
```

**`memory:searchValues`** — Search stored values by key/content
```
riskLevel: 'low'
input: { query, namespace?, scopeID?, limit? }
  - namespace defaults to 'memory'
  - scopeID optional (null = search across all scopes)
  - limit defaults to 50
output: { results: [{ key, value, scopeID, updatedAt }, ...], count }
```

<!-- 
Let's make sure we supply a "limit" argument for this tool, and that it has a sane default "limit" (like maybe 10 or 20).
 -->

These complement the existing tools. The existing `memory:getAgentConfig`,
`memory:updateAgentConfig`, etc. still work — they just delegate through the
model wrappers which now use ValueStoreService underneath.

### Final Implementation Steps

**Step 1: Create ValueStore model**
`src/core/models/value-store-model.mjs`
- Schema as above
- XID prefix `vs_`

**Step 2: Create ValueStoreService**
`src/core/lib/value-store-service.mjs`
- CRUD: get/set/getAll/setAll/delete
- Signed: setSigned/getVerified
- Search: LIKE-based query on key + value columns
- Register on CascadingContext in `application.mjs`

**Step 3: Migrate Agent model**
`src/core/models/agent-model.mjs`
- Rewrite `getConfig()`, `updateConfig()`, `setConfig()`, `getSafeConfig()`,
  `getAbilities()`, `setAbilities()` as async wrappers around ValueStoreService
- Remove `config` column from schema
- Remove `riskLevel` from `AGENT_DEFAULTS` (now optional)
- Add `'riskLevel'` to PROTECTED_KEYS
- Validate riskLevel values in config writes

**Step 4: Migrate Session model**
`src/core/models/session-model.mjs`
- Rewrite `getContext()`, `updateContext()`, `setContext()`,
  `getEffectiveContext()` as async wrappers
- Remove `context` column from schema

**Step 5: Add User settings**
`src/core/models/user-model.mjs`
- Add `getSettings()`, `updateSettings(partial, userKey)`,
  `getVerifiedSettings(userKey)` methods
- `USER_DEFAULTS = { riskLevel: 'normal' }`
- No schema changes (data in ValueStore table)

**Step 6: Fix agent passthrough + user riskLevel resolution**
`src/server/controllers/interaction-controller.mjs`
- Pass `agent` to checkPermission options
- Load user, derive user key, verify settings
- Pass `userRiskLevel` to permission engine

**Step 7: Unlock permission engine**
`src/core/permissions/permission-engine.mjs`
- Resolution chain: agent config → verified user settings → `'strict'`
- Normalize `'medium'` → `'normal'`
- `strict`: restrict ancestry to `[currentSessionID]`
- `normal`: existing walk-up (unchanged)
- `permissive`: full pipeline, flip no-match to `false`

**Step 8: Expose riskLevel in APIs**
- `src/server/controllers/agent-controller.mjs` — accept `riskLevel`, sign via ValueStoreService
- `src/server/controllers/auth-controller.mjs` — accept `riskLevel`, sign via ValueStoreService

**Step 9: Add new memory tools**
`src/core/internal-plugins/memory/index.mjs`
- Add `memory:getValue`, `memory:setValue`, `memory:searchValues`
- Update existing tools to use async model wrappers
- Enforce: `memory:setValue` cannot write to `config` namespace

**Step 10: Agent form dropdown**
`src/client/components/kikx-agent-form-modal/kikx-agent-form-modal.mjs`
- 4 options: Account Default / Strict / Normal / Permissive (YOLO)

**Step 11: Settings page permissions tab**
`src/client/components/kikx-settings-page/kikx-settings-page.mjs`
- Replace stub with dropdown (3 options, no "Account Default")

**Step 12: Tests** *(see full test protocol below)*

### `::agis.test_protocol` — Full Test Plan

#### 12a: ValueStore Model Tests
`spec/core/models/value-store-model-spec.mjs`

- **CRUD basics:** create entry, read back, update value, delete
- **Unique constraint:** duplicate (ownerType, ownerID, namespace, scopeID, key) → error
- **ScopeID isolation:** same key with different scopeIDs → separate entries
- **Empty scopeID default:** entries without explicit scopeID use `''`
- **Organization cascade:** deleting org removes all its ValueStore entries
- **JSON value storage:** objects, arrays, strings, numbers, booleans, null
- **Nullable signature:** entries without signature → `null`
- **Large values:** TEXT(long) handles large JSON blobs

#### 12b: ValueStoreService Tests
`spec/core/lib/value-store-service-spec.mjs`

**Core CRUD:**
- `get()` — existing key returns parsed value
- `get()` — missing key returns null
- `get()` — wrong namespace returns null (no cross-namespace leakage)
- `get()` — wrong scopeID returns null
- `set()` — creates new entry
- `set()` — updates existing entry (upsert)
- `set()` — null value behavior (delete or store null?)
- `getAll()` — returns all keys in namespace as object
- `getAll()` — empty namespace returns `{}`
- `getAll()` — scoped vs unscoped don't leak
- `setAll()` — bulk create multiple keys
- `setAll()` — bulk update existing keys
- `setAll()` — mixed create + update
- `delete()` — removes entry
- `delete()` — missing key → no error (idempotent)
- `delete()` — verify actually gone

**Signed operations:**
- `setSigned()` — stores value + signature
- `setSigned()` — signature is 64-char hex
- `setSigned()` — deterministic (same inputs → same signature)
- `getVerified()` — valid signature → returns value
- `getVerified()` — tampered value → returns null
- `getVerified()` — missing signature → returns null
- `getVerified()` — wrong userKey → returns null
- `getVerified()` — signature survives service restart (UMK-derived, not REK)

**Search:**
- `search()` — matches key name substring
- `search()` — matches value content substring
- `search()` — no matches → empty array
- `search()` — respects namespace filter
- `search()` — respects scopeID filter (when provided)
- `search()` — null scopeID → searches across all scopes
- `search()` — respects limit parameter
- `search()` — returns key, value, scopeID, updatedAt

#### 12c: Agent Model Wrapper Tests
`spec/core/models/agent-config-migration-spec.mjs`

- `getConfig()` — returns AGENT_DEFAULTS when no stored values
- `getConfig()` — merges stored values with defaults
- `getConfig()` — stored values override defaults
- `updateConfig()` — creates new config entries
- `updateConfig()` — updates existing entries
- `updateConfig()` — preserves unmodified keys
- `getSafeConfig()` — strips PROTECTED_KEYS (apiKey, encryptedAPIKey, riskLevel)
- `getAbilities()` — reads from ValueStore
- `setAbilities()` — writes to ValueStore
- `hasAbilities()` — true when set, false when not
- riskLevel validation — invalid value rejected
- riskLevel absent → not in getConfig() result (no default)
- All methods are async (return promises)

#### 12d: Session Model Wrapper Tests
`spec/core/models/session-context-migration-spec.mjs`

- `getContext()` — empty by default
- `getContext()` — returns stored values
- `updateContext()` — creates entries
- `updateContext()` — merges with existing (shallow)
- `setContext()` — replaces all entries in namespace
- `setContext(null)` — clears all entries
- `getEffectiveContext()` — no parent → returns own context
- `getEffectiveContext()` — with parent chain → merges root-down
- `getEffectiveContext()` — deepest child wins on key conflicts
- All methods are async

#### 12e: User Model Wrapper Tests
`spec/core/models/user-settings-spec.mjs`

- `getSettings()` — returns USER_DEFAULTS when empty
- `getSettings()` — merges stored with defaults
- `updateSettings()` — signs sensitive keys (riskLevel)
- `updateSettings()` — doesn't sign non-sensitive keys
- `getVerifiedSettings()` — valid signature → returns settings
- `getVerifiedSettings()` — tampered riskLevel → returns null
- `getVerifiedSettings()` — missing signature → returns null
- `getVerifiedSettings()` — different userKey → returns null
- `'medium'` backward compat → treated as `'normal'`

#### 12f: Permission Engine Tests
`spec/core/permissions/permission-engine-risklevel-spec.mjs`

**Risk level behavior:**
- `strict` mode + parent session allow rule → does NOT apply to child session
- `strict` mode + own session allow rule → applies normally
- `strict` mode + global allow rule → applies normally (global is not ancestry)
- `normal` mode → existing walk-up behavior (regression test)
- `permissive` mode + no matching rules → auto-approved (returns `false`)
- `permissive` mode + deny rule → still denied (throws PermissionDeniedError)
- `permissive` mode + critical tool → still needs approval (returns `true`)
- `permissive` mode + createSession → still needs approval (CrossSessionPermissions)
- `permissive` mode + Permissions.checkPermission() returns `true` → respected
- `permissive` mode + Permissions.checkPermission() returns `false` → respected
- `permissive` mode + Permissions.checkPermission() returns `null` → auto-approved

**Resolution chain:**
- Agent has riskLevel → uses it
- Agent has no riskLevel, user has riskLevel → uses user's
- Neither has riskLevel → falls back to `'strict'`
- Agent `'permissive'` overrides user `'strict'`
- User `'permissive'` applies when agent has no value
- Tampered user settings (bad signature) → falls back to `'strict'`

**Backward compat:**
- `'medium'` in agent config → treated as `'normal'`
- `'medium'` in user settings → treated as `'normal'`

#### 12g: Memory Plugin Tests
`spec/core/internal-plugins/memory/memory-plugin-spec.mjs`

**Existing tools (regression):**
- `memory:getAgentConfig` — returns config via model wrapper
- `memory:updateAgentConfig` — writes config, strips protected keys
- `memory:getSessionContext` — returns context
- `memory:updateSessionContext` — merges context

**New tools:**
- `memory:getValue` — read by key, default namespace 'memory'
- `memory:getValue` — with explicit namespace
- `memory:getValue` — with scopeID
- `memory:getValue` — missing key → null
- `memory:setValue` — write new value
- `memory:setValue` — update existing value
- `memory:setValue` — with scopeID (per-session storage)
- `memory:setValue` — namespace 'config' → rejected (enforced)
- `memory:setValue` — namespace 'memory' → allowed
- `memory:searchValues` — search by key substring
- `memory:searchValues` — search by value content
- `memory:searchValues` — with scopeID filter
- `memory:searchValues` — without scopeID → cross-scope search
- `memory:searchValues` — limit parameter respected
- `memory:searchValues` — no results → empty array

#### 12h: API Controller Tests
`spec/server/controllers/agent-controller-risklevel-spec.mjs`
`spec/server/controllers/auth-controller-settings-spec.mjs`

- Agent update with valid riskLevel → stored + signed
- Agent update with invalid riskLevel → 400 error
- Agent update with riskLevel = null → clears (falls back to user default)
- User settings update with riskLevel → stored + signed
- User settings update → signature verifiable
- User settings GET → returns current riskLevel

#### 12i: Integration / Tamper Tests
`spec/core/permissions/tamper-detection-spec.mjs`

- Write riskLevel via API → read back verified → matches
- Modify ValueStore row directly (simulate DB tampering) → verification fails → fallback to `'strict'`
- Delete signature row directly → verification fails → fallback
- Full flow: user sets permissive → agent auto-approved → tamper to strict in DB → agent still auto-approved (because tampered value fails verification, falls back to strict... wait, that's the opposite)

Actually, let me think about this: if someone tampers `permissive` → `strict`,
the signature won't match, so `getVerifiedSettings()` returns null → fallback
to `'strict'`. The tamperer achieved nothing (they set strict and the fallback
is strict). The dangerous tamper is `strict` → `permissive`, which also fails
verification → fallback `'strict'`. That's the scenario we actually care about.

- Tamper `strict` → `permissive` in DB → verification fails → engine uses `'strict'` ✓
- Tamper `permissive` → `strict` in DB → verification fails → engine uses `'strict'` ✓ (conservative)
- Tamper `normal` → `permissive` in DB → verification fails → engine uses `'strict'` ✓

### Updated Affected Files (Final)

| File | Change |
|------|--------|
| `src/core/models/value-store-model.mjs` | **NEW** — ValueStore schema |
| `src/core/lib/value-store-service.mjs` | **NEW** — ValueStoreService |
| `src/server/application.mjs` | Register ValueStoreService on context |
| `src/core/models/agent-model.mjs` | Async wrappers, drop `config` column, PROTECTED_KEYS |
| `src/core/models/session-model.mjs` | Async wrappers, drop `context` column |
| `src/core/models/user-model.mjs` | Settings methods via ValueStoreService |
| `src/core/permissions/permission-engine.mjs` | Resolution chain, 3-way branch |
| `src/server/controllers/interaction-controller.mjs` | Pass agent + verified userRiskLevel |
| `src/server/controllers/agent-controller.mjs` | Accept riskLevel, signed writes |
| `src/server/controllers/auth-controller.mjs` | Accept riskLevel, signed writes |
| `src/core/internal-plugins/memory/index.mjs` | 3 new tools + async migration |
| `src/client/components/kikx-agent-form-modal/kikx-agent-form-modal.mjs` | Dropdown (4 options) |
| `src/client/components/kikx-settings-page/kikx-settings-page.mjs` | Permissions tab dropdown |
| `src/client/lib/api.mjs` | Pass riskLevel in updates |

### Complexity Assessment

This is now a **medium-to-large** implementation due to scope expansion:
- ~200 lines: ValueStore model + ValueStoreService
- ~100 lines: Agent/Session/User model rewrites (async wrappers)
- ~80 lines: Permission engine changes
- ~120 lines: New memory tools (3 tools)
- ~50 lines: Controller changes (agent + auth)
- ~50 lines: UI (dropdowns)
- ~800-1000 lines: Tests (9 test files/sections)

Total: ~600-700 lines implementation + ~800-1000 lines tests.

The scope grew from "unlock the riskLevel gate" to "build the unified value
store + agent memory foundation." But this is the right call — doing it now
means the next feature (queryable agent storage) is already mostly done.

<!--
Much better on the tests, but I only see mostly "happy-path" tests here... what about "failure-path" tests? Can you think up more deliberate failures we could test?
 -->

---

## Round 7 — Addressing Feedback + Failure Path Tests

### Why `''` Instead of `NULL` for `scopeID`?

SQLite treats NULLs as **distinct** in UNIQUE constraints. If `scopeID` were
NULL, you could insert the same `(ownerType, ownerID, namespace, NULL, key)`
combination **multiple times** without a UNIQUE violation — because each NULL
is considered different from every other NULL.

Example of the problem with NULL:
```sql
-- Both succeed! No UNIQUE violation in SQLite.
INSERT INTO value_stores (ownerType, ownerID, namespace, scopeID, key) VALUES ('agent', 'agt_1', 'config', NULL, 'riskLevel');
INSERT INTO value_stores (ownerType, ownerID, namespace, scopeID, key) VALUES ('agent', 'agt_1', 'config', NULL, 'riskLevel');
```

Empty string `''` is a real value, so the UNIQUE constraint works correctly.

<!-- 
Got it! Thank you for explaining to me.
 -->

**Alternative:** We could use NULL + partial UNIQUE indexes (`WHERE scopeID IS NULL`
and `WHERE scopeID IS NOT NULL`), but mythix-orm may not support partial indexes,
and it adds complexity. Empty string is the pragmatic choice — `''` just means
"not scoped."

### Search Limit Default

Changed to **20** (from 50). The `memory:searchValues` tool schema now has
`limit` with a default of 20.

### Failure Path Tests — `::agis.test_protocol` (Adversarial Pass)

Here's every failure mode I can think of, organized by component:

#### ValueStore Model — Failure Paths

- **Missing required fields:** Create without `organizationID` → error
- **Missing required fields:** Create without `ownerType` → error
- **Missing required fields:** Create without `key` → error
- **Invalid ownerType:** Value not in `['agent', 'user', 'session']` → error or
  silently stored? (Design decision: validate in service, not model)
- **FK violation:** Non-existent `organizationID` → FK error
- **Duplicate key:** Violate UNIQUE constraint → error
- **Oversized key:** Key exceeding STRING(256) → truncation or error
- **Corrupted JSON in value column:** Manually corrupted DB data → graceful handling on read

#### ValueStoreService — Failure Paths

**Construction / initialization:**
- Missing context → throws
- Missing models on context → throws

**get() failures:**
- Non-existent owner (ownerID doesn't match any entity) → returns `null` (not throw)
- Corrupted JSON in stored value → graceful fallback (return raw string? return null? log warning?)

**set() failures:**
- `undefined` value → should it delete the entry or throw?
- Circular reference in value object → JSON.stringify throws → surface error
- `null` value → should it delete the entry? store `"null"`?
- Non-serializable value (functions, symbols) → JSON.stringify throws → surface error

**getAll() failures:**
- Entity has no entries → returns `{}` (not throw)
- Mixed corrupted and valid entries → skip corrupted? include raw?

**setAll() failures:**
- Empty entries object → no-op (not throw)
- Partial failure (some keys invalid) → atomic? or best-effort?

**delete() failures:**
- Non-existent key → no-op, no error (idempotent)
- Non-existent owner → no-op, no error

**setSigned() failures:**
- `null` userKey → throws (can't sign without key)
- `undefined` userKey → throws
- Empty Buffer as userKey → throws or produces invalid signature?
- Value that can't be JSON-stringified → throws

**getVerified() failures:**
- No entry exists → returns `null` (no signature to verify)
- Entry exists but signature is `null` → treated as unverified → returns `null`
- Signature is present but wrong length (not 64 hex chars) → returns `null`
- Signature contains non-hex characters → returns `null`
- Valid signature format but wrong value (tampered) → returns `null`
- Valid signature but value was modified → returns `null`
- Valid value but signature was modified → returns `null`
- Both value AND signature modified (forgery attempt without UMK) → returns `null`

**search() failures:**
- Empty query string → returns all? or empty? (Design: require non-empty)
- Query with SQL LIKE metacharacters (`%`, `_`) → properly escaped, no injection
- Query with SQL injection attempt (`'; DROP TABLE`) → escaped, no injection
- Very long query string → truncated or limited
- No matching results → empty array (not throw)

#### Agent Model Wrappers — Failure Paths

- `getConfig()` when ValueStoreService not on context → throws with clear message
- `updateConfig()` with non-object argument (string, number, array) → throws
- `updateConfig()` with null → no-op or throws? (Design: no-op)
- `updateConfig()` with empty `{}` → no-op
- `updateConfig()` with PROTECTED_KEYS included → silently stripped
- `updateConfig({ riskLevel: 'invalid_value' })` → throws validation error
- `updateConfig({ riskLevel: 123 })` → type validation error
- `updateConfig({ riskLevel: '' })` → empty string invalid
- `setConfig(null)` → clears all config entries
- `setConfig()` with non-object → throws
- `getAbilities()` when no abilities set → returns `null`
- `setAbilities(null)` → clears abilities entry
- `setAbilities('')` → sets empty string (or clears? Design decision)
- Agent deleted → CASCADE deletes ValueStore entries (verify via model)

#### Session Model Wrappers — Failure Paths

- `getContext()` with no stored entries → returns `{}`
- `updateContext()` with non-object → throws
- `updateContext()` with null → no-op
- `setContext(null)` → clears all context entries
- `getEffectiveContext()` with orphaned `parentSessionID` (parent deleted) → stops at break, returns what it has
- `getEffectiveContext()` with deep chain (100+ levels) → respects max depth guard
- `getEffectiveContext()` with circular reference (shouldn't happen, but guard) → detects and stops

#### User Model Wrappers — Failure Paths

- `getSettings()` with no stored entries → returns `USER_DEFAULTS`
- `updateSettings()` called without `userKey` → throws
- `updateSettings()` called with `null` userKey → throws
- `updateSettings({ riskLevel: 'invalid' })` → validation error
- `getVerifiedSettings()` when no settings exist at all → returns defaults (nothing to verify, safe)
- `getVerifiedSettings()` with `null` userKey → throws
- `getVerifiedSettings()` after password change (new UMK → new userKey) → old signatures invalid → fallback to `'strict'`

#### Permission Engine — Failure Paths

- `agent` option is `null` → no agent riskLevel, fall through to user
- `agent` option is `undefined` → same
- `agent.getConfig()` throws (ValueStoreService down) → should catch and fallback to `'strict'`
- User record not found for `userRiskLevel` resolution → fallback to `'strict'`
- `userRiskLevel` is `null` → fallback to `'strict'`
- `userRiskLevel` is unrecognized string → fallback to `'strict'`
- Agent riskLevel is valid but user riskLevel is tampered → agent value takes precedence (no fallback needed)
- Both agent and user riskLevel are missing → `'strict'`
- riskLevel is a number instead of string → type check, fallback
- riskLevel is empty string → fallback

#### Memory Plugin — Failure Paths

- `memory:getValue` without `key` parameter → error message
- `memory:getValue` with empty string key → error
- `memory:setValue` without `key` → error
- `memory:setValue` without `value` → error or stores null?
- `memory:setValue` with `namespace: 'config'` → rejected with clear error
- `memory:setValue` with very large value (100KB+) → accepted (TEXT long) but test it
- `memory:searchValues` without `query` → error
- `memory:searchValues` with empty string query → error
- Tool called without `agentID` in params → error
- Tool called with non-existent `agentID` → error ("Agent not found")

#### API Controller — Failure Paths

- `PUT /api/v2/agents/:id` with `riskLevel` but no auth → 401
- `PUT /api/v2/agents/:id` with `riskLevel` for agent in different org → 403/404
- `PUT /api/v2/agents/:id` with `riskLevel: 'invalid'` → 400
- `PUT /api/v2/agents/:id` with `riskLevel: null` → clears, reverts to user default
- `PUT /api/v2/auth/me` with `riskLevel` but no auth → 401
- `PUT /api/v2/auth/me` with `riskLevel: 'invalid'` → 400
- `PUT /api/v2/auth/me` when UMK unavailable (bad JWT vault) → 500
- `GET /api/v2/auth/me` when no settings exist → returns defaults

#### Security / Tamper — Failure Paths

- Direct DB: change `value` column, leave `signature` → `getVerified()` returns `null`
- Direct DB: change `signature` column, leave `value` → returns `null`
- Direct DB: change both `value` AND `signature` (without UMK) → returns `null`
- Direct DB: delete the entire ValueStore row → `getVerified()` returns `null` → fallback
- Direct DB: insert new row with forged `value` + random `signature` → fails verification
- Direct DB: copy signature from another user's entry → fails (different userKey)
- Replay attack: save old (value, signature) pair, user changes setting, replay old pair → old signature is valid for old value, but the VALUE is now "wrong" from the user's intent — actually this succeeds, the signature matches. Is this a problem? Only if the attacker can intercept AND replay. Since the DB is the storage, "replaying" just means restoring a previous value. The signature protects integrity, not versioning.

### Summary of Design Decisions Needed

From the failure paths above, a few design choices surfaced:

1. `set()` with `null` value — delete the entry? or store JSON `"null"`?
   Recommendation: **delete the entry** (treat null as "unset")
   <!-- 
   Delete the entry.
    -->
2. `set()` with `undefined` value — same as null? or throw?
   Recommendation: **throw** (undefined is a programming error, null is intentional)
   <!-- 
   Also delete the entry.
    -->
3. Corrupted JSON on read — return `null`? throw? log?
   Recommendation: **return null + log warning** (graceful degradation)
   <!-- 
   Return null, log a warning. I'd like it if we could figure out how to have the agent see the warning? Maybe that isn't important right now. I doubt such a thing will be happening often.
    -->
4. `searchValues` with empty query — return all? or require non-empty?
   Recommendation: **require non-empty** (empty query is probably a bug)
   <!-- 
   HHmmmm... it probably is useful to allow the agent to "scan" values like a file listing. List allow an empty search, and aside from a limit, let's also add an "offset" for this purpose.
    -->
5. `setAbilities('')` — clear or store empty?
   Recommendation: **clear** (treat empty string same as null for text values)
   <!-- 
   Clear. Let's make sure at the site where we inject the ability string that we are properly handling "null" values and skipping.
    -->
6. Password change → old signatures invalid → is this acceptable?
   Yes — user re-sets their preferences after a password change. The fallback
   to `'strict'` is safe. We could add a re-signing step to the password change
   flow later if this becomes friction.
   <!--
   I believe we already fixed this issue. The users-password is the "master key", not the "final key". The final key is already stored away, encrypted by the master key.

   So the change password process is:
   1. Set new password
   2. Use existing auth token as master key (or rather, it is embedded in the JWT)
   3. Decrypt the users vault with the master key
   4. Recrypt the users vault with the new password
   5. Store the new password hash

   But wait... this fixes the vault, but you are talking specifically of the verification key, which is public. Yes, if THIS changed, then we would treat all signatures as invalid (sorry). But the public verification key is NOT the password. The private signing key is what is stored inside the vault.

   Did I miss something here?
    -->

---

## Round 8 — Final Clarifications

### Design Decision Resolutions

| # | Decision | Resolution |
|---|----------|------------|
| 1 | `set()` with `null` | Delete the entry |
| 2 | `set()` with `undefined` | Also delete the entry (not throw) |
| 3 | Corrupted JSON on read | Return `null` + log warning |
| 4 | Empty search query | **Allow it** — acts as "scan" / listing. Add `offset` param for pagination |
| 5 | `setAbilities('')` | Clear (delete entry). Verify abilities injection site handles `null` gracefully |
| 6 | Password change signatures | **Non-issue** — see below |

### Password Change & Signatures — My Mistake

You're right, I was wrong to flag this. Let me trace through why:

The signing key is `deriveUserKey(UMK, userID)` = `HMAC-SHA256(UMK, userID)`.

During password change:
1. Old password-derived key wraps the UMK in `passwordSlot`
2. Existing JWT vault claim has UMK wrapped with REK
3. Unwrap UMK from JWT → **same UMK as before**
4. Re-wrap UMK with new password-derived key → new `passwordSlot`
5. **UMK itself never changes** → `deriveUserKey()` produces the **same user key**
   → all existing signatures remain valid

So: signatures survive password changes. The concern was unfounded. Removing
the "password change invalidates signatures" test case — it would be testing
for a bug that can't happen.

**One small clarification:** You mentioned "public verification key" vs "private
signing key" — in our system it's actually HMAC (symmetric), so the same key
both signs and verifies. There's no public/private split. But the conclusion
is identical: the key (`deriveUserKey`) is stable across password changes because
the UMK is stable, so signatures persist.

The only scenario where signatures would break is if the UMK itself were rotated
(e.g., key rotation feature — which is a separate future plan). At that point,
we'd need a re-signing step as part of the rotation flow.

### Updated `searchValues` Tool Schema

Per feedback, the search tool now supports empty queries (listing mode) and
adds `offset` for pagination:

```
memory:searchValues
riskLevel: 'low'
input:
  query:     STRING (optional — empty/null = list all)
  namespace: STRING (default: 'memory')
  scopeID:   STRING (optional — null = all scopes)
  limit:     INTEGER (default: 20)
  offset:    INTEGER (default: 0)
output:
  results: [{ key, value, scopeID, updatedAt }, ...]
  count:   INTEGER (total matches, not just page)
```

### Abilities Injection — Null Guard

The abilities injection site is `src/core/interaction/abilities-reinjection.mjs`
and `src/core/primer/index.mjs`. Both need to handle `getAbilities()` returning
`null` (entry deleted / never set). Quick check: the current code already does
`if (abilities)` before injection, but we should verify this still works after
the async migration (the return value from `await agent.getAbilities()` vs the
old synchronous `agent.getAbilities()`).

### Are We Ready?

I believe the plan is now complete:
- **12 implementation steps** covering model, service, engine, API, UI, and tests
- **Schema finalized** with all design decisions resolved
- **Failure paths** covered across every component
- **Signing infrastructure** validated against the existing key hierarchy
- **No open questions remaining**

Ready to convert this into a TODO.md execution plan whenever you give the word.
