---
title: Unified properties store (theme, email, plugin access)
status: current
doc_type: plan
audience: [developers, maintainers, operators]
applies_to: development-v3
last_verified: 2026-11-13
---

# Unified properties store (theme, email, plugin access)

## Why

Owner, 2026-11-13: "I don't like this ununified surface of storing things.
`localStorage` isn't going to work for user settings like Theme, as I want
such things to follow the user around. Dropping random JSON blobs is not only
messy, but unflexible (with our plugin architecture), and likely will end up
being a security hole we will have to patch later."

Today's split surface this replaces for its first two members:

| Setting | Today | After |
| --- | --- | --- |
| Theme (`kikx.theme`) | `localStorage`, browser-local | property, account-scoped |
| Email configuration | `<root>/.kikx/mailer.json` (0600) | property, global scope, password envelope-encrypted |

Explicitly out of the first wave (with reasons — see Deferred): auth tokens,
`.kikx/plugin-paths.json`, `.kikx/plugin-disabled.json`, session-preferences,
debug/raw-mode flags.

## Locked decisions (design rounds 2026-11-13)

### 1. Schema

```sql
properties (
  key          text        NOT NULL,   -- full normalized path, ALWAYS
  scope_type   text        NOT NULL DEFAULT 'global'
               CHECK (scope_type IN ('global','account','session','plugin')),
  scope_id     text        NOT NULL DEFAULT '',   -- '' when global (PK-safe; see pitfalls)
  value        jsonb       NOT NULL,    -- ALWAYS JSONB, always an envelope object
  encryption_method text   NULL,        -- 'aes-256-gcm'; NOT NULL IMPLIES secret (reversible)
  hash_method  text        NULL,        -- 'sha-512';      NOT NULL IMPLIES secret (one-way)
  key_ref      text        NULL,        -- key name + fingerprint, never the key: 'properties-v1/9f3ab2c1'
  version      integer     NOT NULL DEFAULT 1,   -- optimistic concurrency (PUT mismatch -> 409)
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text,                    -- account id / 'core' / plugin fqid (audit seam, §10.7)
  deleted_at   timestamptz,             -- soft delete: cleared ≠ never-set
  PRIMARY KEY (scope_type, scope_id, key),
  CHECK ((encryption_method IS NULL AND hash_method IS NULL)
      OR (encryption_method IS NOT NULL AND key_ref IS NOT NULL)
      OR (hash_method      IS NOT NULL AND key_ref IS NOT NULL))
)
```

- **There is no `secret` boolean.** Presence of `encryption_method` or
  `hash_method` IS the secret flag (owner: presence "implies secret: true") —
  one truth, no `secret=true AND method=NULL` state to constraint.
- **Envelope is self-describing and must match the columns.** Value = plain
  `{"value": …}` or protected `{"__enc": {"v":1,"alg":"aes-256-gcm",
  "kid":"properties-v1/9f3ab2c1","iv","tag","ct"}}`. On decrypt, `alg` must
  equal `encryption_method` AND `kid` must equal `key_ref`, else refuse
  (fail-closed): column tampering cannot aim decryption anywhere the envelope
  does not independently confirm.
- **Algorithm allowlist** (`aes-256-gcm` only in v1): agility is downgrade
  surface; unknown method = refuse, same posture as `signature_mode=required`.
  GCM's auth tag covers integrity for reversible secrets; `hash_method` is
  for future one-way values (compare-only, never returned) and exists now so
  we never migrate for it.
- **Key normalization on every write:** trim, collapse `//`, reject `..` and
  empty segments, lowercase, bounded length (e.g. 256). ` /a/b`, `/a/b` and
  `/a//b` must never be three keys.
- **Value bounds:** JSON-only (JSONB enforces), app-side size cap (default
  64KB) and per-namespace quotas (see Open #4).
- **JSONB always (owner's rule):** even scalars live as `{"value": …}` so the
  store can target any NoSQL / NoSQL-shaped backend — including AeorDB "whenever
  we decide to return to it". The interface never learns which backend it is.

### 2. Key model: relative vs absolute (owner's HTTP-path metaphor)

- **Relative key** (`'custom_plugin_value'`) → resolved into the CALLER'S
  OWN namespace. For a plugin: `/plugins/<fqid>/custom_plugin_value`.
- **Absolute key** (leading `/`) → global path, permission-checked.
- Plugin namespace derives from the **fully-qualified plugin identifier**,
  never a filesystem path (paths leak layout, differ per host, break on
  rename). FQID = Java-style, path-form, manifest-declared, registry-UNIQUE:
  `/org/category/name` (owner's example `/kikx/plugins/discord`). Short
  `name` stays the display label.

### 3. Caller classes and the rule engine (absolute keys only)

- `core` — server code. **Server code ONLY.** Internal/bundled plugins get NO
  ambient rights: "I have been deliberately trying to NOT hold ambient
  internal rights... internal plugins should also just have the proper
  manifest" (owner 2026-11-13). They declare and are signed like everyone.
- `plugin:<fqid>` — every plugin, bundled included.
- HTTP user identity — never reaches the facade; it keeps the scope rules
  (own-account read/write, global read, global write = identity bar).
- **Sensitivity is core-owned, never requester-owned** (no self-granting):
  a core property registry defines absolute keys/patterns
  `{ sensitivity: 'public' | 'internal' | 'secret', schema }`.
  - `public` — any caller may read.
  - `internal` — read/write only `core` caller-class or an explicit grant.
  - `secret` — reads only server-side from `core` (HTTP returns `hasValue`
    only); writes need `core` or an explicit grant.
- **Wildcards: prefix-only in v1.** `/core/*` = the whole subtree under
  `/core/`; `/*` = everything (owner: "might be needed for things like
  backup, or auditing plugins"). Everything else = exact key.
  **Deny wins; default is deny** for any unmatched absolute access.

### 4. Manifest schemas (two lists, one relaxed gate)

```jsonc
{
  "properties": {            // (1) OWN keys — schema, OPTIONAL to declare
    "last_run": { "type": "number", "default": 0 }
  },
  "access": {                // (2) FOREIGN (absolute) keys — MANDATORY to touch
    "read":  { "deny": "*", "allow": ["/core/kikx/email/configuration"] },
    "write": { "deny": "*", "allow": [] }
  }
}
```

- **RELAXATION (owner concern, 2026-11-13: dynamic properties):** a plugin may
  ALWAYS read/write ITS OWN namespace (relative keys) with NO declaration.
  The static-manifest gate was protecting validation and bounds, not security —
  and it made dynamic per-item keys impossible. Own-namespace is already
  isolated (forced FQID prefix + no ambient rights), so the remaining risks are
  bounded by quotas (Open #4) and optional validation:
  - declared own keys get their schema validated server-side,
  - undeclared own keys (dynamic) are accepted within bounds,
  - **any absolute/foreign key requires the `access` grant — undeclared = denied.**
- Grants are read/write SEPARATE maps; deny beats allow; `/*` allowed.
- Grants ride the manifest, which `.kikx-sig` already signs → **tamper-proof
  by the existing S4 machinery**, disclosed at install time from signed bytes
  ("This plugin can write to /core/* properties") — same pattern as the
  existing mount-auth disclosures in the inventory. Future official
  permissions system = UI over this.

### 5. Storage abstraction

One `PropertiesStore` interface, two implementations (owner approved both):
- SQL: driver-qualified migration DDL (precedent: the campaign's migrations).
- AeorDB: document put/get via `db.putFile` (the exact mechanism tags uses).
Callers (facade, HTTP, boot) only ever see the interface. JSONB-always keeps
the two byte-identical in shape.

### 6. Migration of the first two members (clean cuts, no dual-storage)

- **Theme:** key `/core/user/theme/primary_color`, scope `(account, uid)`.
  One-time client import (POST the old `localStorage` value once, then delete
  the key) so nobody loses their pick; after that localStorage is dead code.
- **Email:** key `/core/kikx/email/configuration`, scope `global`, password
  under the envelope columns. Boot reads properties only; **no import from
  `.kikx/mailer.json`** (owner: single configured-DB location; there is no
  production file to migrate) — `mailer-settings.mjs` is rewritten onto the
  store and the file writer disappears. Endpoints/keep-hot-swap seam stay.

## Phases (failing-first; full unit lane green before each commit; no deploys)

- **P1 — core store.** `src/core/properties/` : `store.mjs` (interface +
  factory by driver), `store-sql.mjs` + migration DDL, `envelope.mjs`
  (seal/open, allowlist, key match), `keys.mjs` (normalization).
  Tests: normalization matrix (`..`, `//`, case, length), PK/scope round-trip,
  envelope seal/open + alg/kid mismatch refusal + missing-key fail-closed,
  secret write refused without `KIKX_PROPERTIES_ENCRYPTION_KEY`, size cap.
- **P2 — facade + rules.** `facade.mjs` (relative/absolute resolution,
  caller classes), `registry.mjs` (core sensitivity definitions),
  `grants.mjs` (prefix matching, deny-wins, `/*`). Tests: every rule row of
  §3, plugin caller denied undeclared absolute read/write, `/*` grant allows
  subtree only, deny-precedence matrix, own-namespace unrestricted (dynamic
  keys) inside quotas, quota exceeded -> 400/507-style refusal.
- **P3 — HTTP surface.** `properties-routes.mjs`: GET/PUT/DELETE scoped by
  identity (own-account + global read; global write = identity bar; secrets
  → `hasValue` only), optimistic `version` → 409. Tests: scope matrix incl.
  hostile cross-account reads, 401/503 gate parity with the auth family.
- **P4 — theme migration.** server endpoint (thin, over P3), client
  `lib/theme.mjs` → fetch/store through account scope, one-time
  localStorage import + delete, `initTheme` waits for fetch with default-blue
  paint-first. Tests: store round-trip, import fires once then clears,
  unknown id -> default, puppeteer: pick purple → reload on a NEW profile
  equivalent (account fetch) restores.
- **P5 — email migration.** `mailer-settings.mjs` onto the store (secret
  envelope for password), boot reads store (async before authService),
  save/test endpoints unchanged outside storage, `.kikx/mailer.json` writer
  deleted. Tests: port the 5+5 specs onto the store, hot-swap still proven,
  password never returned (hasValue), legacy file ignored (clean cut).
- **P6 — plugin manifests + disclosure.** Loader parses `properties`/`access`,
  registers into grants registry (signed-manifest → grants), inventory
  exposes grants, settings card + install/Browse cards render the disclosure.
  Tests: undeclared absolute access denied at the facade, disclosure text
  from signed bytes, loader refuses malformed grant shapes.
- **P7 — AeorDB implementation** + driver-parity suite (same specs run
  against both backends).
- **P8 — docs.** `.env.example` (`KIKX_PROPERTIES_ENCRYPTION_KEY` with the
  fail-closed note), properties reference page + README index, authoring-guide
  manifest section, HANDOFF/MEMORY update.

Working rules (standing): failing-first everywhere; suites before commits;
push at green milestones; never touch `kikx2`/`:3001`; no deploy without the
owner; source caps 500 soft / 800 hard; light-DOM only.

## Genuinely open concerns (owner asked to keep talking — each with a recommendation)

1. **Session-scoped plugin access.** v1: plugins get own-namespace + granted
   absolute keys only; `session`-scope rows stay core/user-side. If a plugin
   needs session data later, bind scope through the facade's request context
   with an explicit grant to the session subtree. *Recommend defer to demand.*
2. **Deny-attempt audit.** A refused absolute read/write is alert-worthy.
   *Recommend:* structured log line now (key, caller, decision), audit ROWS
   when the campaign's audit seam (§10.7) grows past `updated_by`.
3. **Optimistic concurrency.** Two operators editing email config will
   silently lose one write. *Recommend:* keep `version` in P1 schema, 409 in
   P3, form re-fetches on conflict.
4. **Quotas (new this round — the cost of relaxing own-namespace).** A plugin
   with unrestricted dynamic own-keys can flood rows. *Recommend:*
   per-namespace caps (row count + total bytes) with config defaults
   (`KIKX_PROPERTIES_MAX_ROWS_PER_NAMESPACE`, `…_MAX_BYTES_PER_NAMESPACE`),
   exceeded -> refused + logged; core scope unbounded (operator-owned).
5. **Theme import.** One-time localStorage POST vs hard cut (everyone resets
   to blue). *Recommend:* keep the tiny import — it's 10 lines and nobody
   loses their pick.
6. **Later migrations** (candidates, not commitments): debug flag,
   raw-markdown flag (both then follow the account), session-preferences (the
   biggest remaining ununified surface — touches live session behavior, so
   its own pass).
7. **Loader runtime files stay files** (`.kikx/plugin-paths.json`,
   `plugin-disabled.json`): the loader reads them at boot BEFORE migrations
   create tables. v2 option: property-table early-ensure before plugin load;
   until then, files are honest and boot-order-safe.
8. **Internal-plugin signing** (owner: "soon"): `--all-bundled` signing
   already exists in `scripts/sign-plugin.mjs`; wire it into boot/CI when P6
   manifests start carrying `properties`/`access`.
9. **Uninstall retains the plugin namespace** (durable-data ruling); an
   explicit purge action stays future, like plugin data.
10. **Scope vocabulary closed by CHECK** — adding a scope type later is a
    migration; `plugin` scope rows are reserved for facade-managed namespaces
    (HTTP never writes them directly).

## Test inventory (planned)

- `spec/core/properties/keys-spec.mjs`, `envelope-spec.mjs`,
  `store-sql-spec.mjs`, `store-aeordb-spec.mjs` (P1/P7 parity).
- `spec/core/properties/facade-spec.mjs`, `grants-spec.mjs` (P2 — the rule
  matrix is the heart).
- `spec/server/properties-routes-spec.mjs` (P3 — scope/hostile-read matrix).
- Client: `spec/client/theme-spec.mjs` extended (P4), email specs ported
  (P5), disclosure assertions in system-settings-plugins (P6).
- `spec/ui/puppeteer/system-settings-shell-puppeteer.mjs` extended for theme
  account round-trip.
