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
  64KB). **NO per-namespace quotas** (owner, 2026-11-13): "Kikx plugins
 naturally have an immense amount of power, and are a 'trusted space'. Since
 plugins tie directly into system classes (by design), a malicious plugin
 author can do anything they want, including bypassing safety mechanisms. We
 are going to the trouble we are already going to _just to provide sane
 guardrails_ for healthy plugins." Guardrails serve healthy plugins; the
 flood-cap was defending against an adversary who is already omnipotent.
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
  isolated (forced FQID prefix + no ambient rights), so the remaining risk
  (storage flood) is accepted under the trust doctrine quoted in §1 — plugins
  are a guarded-for-health, not contained-for-malice, space:
  - declared own keys get their schema validated server-side,
  - undeclared own keys (dynamic) are accepted within bounds,
  - **any absolute/foreign key requires the `access` grant — undeclared = denied.**
- Grants are read/write SEPARATE maps; deny beats allow; `/*` allowed.
  **Superseded reading (owner Q2, 2026-11-13):** evaluation is
  AeorDB-inspired — NEAREST/most-specific declaration wins, deny decides
  equal-specificity ties, no match = no opinion = default deny (cf. aeordb
  `permission_resolver.rs`). The §4 example above works as written under
  these rules. `{uuid}` segments are legal in patterns; `{current}` is
  identity-resolved in the calculate step only (owner Q1, 2026-11-13).
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
  **Hard cut (owner: "I am the only user in the world currently")** — no
  localStorage import: localStorage becomes dead code immediately; new/default
  blue until a choice is made. Email: key `/core/kikx/email/configuration`,
  scope `global`, password
  under the envelope columns. Boot reads properties only; **no import from
  `.kikx/mailer.json`** (owner: single configured-DB location; there is no
  production file to migrate) — `mailer-settings.mjs` is rewritten onto the
  store and the file writer disappears. Endpoints/keep-hot-swap seam stay.

## Phases (failing-first; full unit lane green before each commit; no deploys)

- **P1 — core store.** `src/core/properties/` : `store.mjs` (interface +
  factory by driver), `store-sql.mjs` + migration DDL, `envelope.mjs`
  (seal/open, allowlist, key match), `keys.mjs` (normalization).
  **DDL EXECUTION POINT (map_territory finding):** the properties table is
  created by the CORE schema bootstrap BEFORE `pluginLoadPromise` — plugins
  may write properties during `setup()`/`onInit()`, and both run INSIDE the
  boot load (create-server ~262), before plugin migrations (~278). Boot-order
  test required: a fixture plugin writing a property during setup at boot
  succeeds.
  **Unit dialect (test_check finding):** the SQL store unit-tests against
  **sqlite** (file-backed, in-lane — the unit lane must never need a live
  PostgreSQL); the aeordb store uses the fake-`db` object pattern tags already
  uses. Real-PostgreSQL/AeorDB parity = P7, env-skipped with a documented
  bound.
  Tests: normalization matrix (`..`, `//`, case, length) PLUS a
  property-style hostile-string sweep, PK/scope round-trip, envelope
  seal/open + alg/kid mismatch refusal + missing-key fail-closed, secret
  write refused without `KIKX_PROPERTIES_ENCRYPTION_KEY`, size cap,
  boot-order fixture-plugin test.
- **P2 — facade + rules.** `facade.mjs` (relative/absolute resolution,
  caller classes), `registry.mjs` (core sensitivity definitions),
  `grants.mjs` (prefix matching, deny-wins, `/*`). Tests: every rule row of
  §3, plugin caller denied undeclared absolute read/write, `/*` grant allows
  subtree only, deny-precedence matrix, own-namespace unrestricted (dynamic
  keys), and **deny-attempt LOGGING** (owner 2026-11-13: "we do want to log
  such things") — structured line with key, caller, decision. Plus ONE
  end-to-end through the REAL loader (cynic pass: hand-built grants give false
  confidence): `loadPlugins` registers a manifest's `access` block, then the
  facade enforces it against a live plugin caller.
- **P3 — HTTP surface.** `properties-routes.mjs`: GET/PUT/DELETE scoped by
  identity (own-account + global read; global write = identity bar; secrets
  → `hasValue` only), optimistic `version` → 409. Boot/harness precedence
  pinned here: `create-server options.*` > properties > env defaults — tests
  and embedders keep overriding without touching the store.
  Tests: scope matrix incl.
  hostile cross-account reads, 401/503 gate parity with the auth family.
- **P4 — theme migration.** server endpoint (thin, over P3), client
  `lib/theme.mjs` → account-scoped store, **hard cut — no import** (owner
  ruling). **Kick point (map_territory finding):** `initTheme()` runs at state
  MODULE init — no app, no fetch helper, no identity yet — so it keeps
  painting default blue, and the account fetch is kicked at APP BOOT after
  auth resolves (mirror the `loadServerVersion` pattern); the var swaps on
  arrival (one-time blue→chosen flash on cold load — accepted). Signed-out or
  fetch-failed → default blue, no error surface. theme-spec note: its
  localStorage tests DIE with the hard cut and are rewritten as
  account-fetch tests; palette/validation/apply tests stay verbatim.
  Tests: store round-trip over the injected fetcher, unknown id -> default,
  fetch-fail -> default blue held, puppeteer: pick purple → reload restores
  from the ACCOUNT (the follow-you property).
- **P5 — email migration.** `mailer-settings.mjs` onto the store (secret
  envelope for password), boot reads store (async before authService, under
  the P3 precedence), save/test endpoints unchanged outside storage,
  `.kikx/mailer.json` writer deleted. **Undecryptable-secret boot (finding):**
  key absent or `key_ref` mismatch on existing rows → LOUD warn + treat as
  unconfigured (log-mode fallback), GET surfaces an error flag — never a boot
  crash, never a silent plaintext fallback.
  Tests: port the 5+5 specs onto the store, hot-swap still proven, password
  never returned (hasValue), undecryptable-row boot behavior, legacy file
  ignored (clean cut).
- **P6 — plugin manifests + disclosure.** **First task = premise recon
  (map_territory):** confirm WHICH file `.kikx-sig` actually signs (it signs
  "manifest bytes" — kikx-plugin.json vs package.json vs directory list);
  grants must parse from exactly that file, after admission. Then: Loader
  parses `properties`/`access`,
  registers into grants registry (signed-manifest → grants), inventory
  exposes grants, settings card + install/Browse cards render the disclosure.
  Internal plugins obey the SAME contract — full modules with `package.json`
  like every plugin (owner: not loose JS files); internal signing follows
  once the system stands up, automated via tooling (`--all-bundled`).
  Tests: undeclared absolute access denied at the facade, disclosure text
  from signed bytes, loader refuses malformed grant shapes.
- **P7 — AeorDB implementation** + driver-parity suite (same specs run
  against both backends). Sequencing freedom: may TRAIL P6 — no caller needs
  the aeordb backend until an aeordb deployment returns; P1–P6 must not
  import it eagerly.
- **P8 — docs.** `.env.example` (`KIKX_PROPERTIES_ENCRYPTION_KEY` with the
  fail-closed note), properties reference page + README index, authoring-guide
  manifest section, HANDOFF/MEMORY update.

Working rules (standing): failing-first everywhere; suites before commits;
push at green milestones; never touch `kikx2`/`:3001`; no deploy without the
owner; source caps 500 soft / 800 hard; light-DOM only.

## Genuely open concerns ledger — RESOLVED by owner rulings (2026-11-13)

1. **Session-scoped plugin access —** DECIDED: defer to demand; v1 =
   own-namespace + granted absolute keys only.
2. **Deny-attempt audit —** DECIDED: yes, log now (P2 structured line:
   key, caller, decision); audit rows later when §10.7 grows past `updated_by`.
3. **Optimistic concurrency —** DECIDED: yes; `version` in P1, 409 in P3,
   form re-fetches on conflict.
4. **Quotas —** DECIDED: **NO.** Owner trust doctrine (quoted in §1):
   plugins are a trusted space; guardrails are for healthy plugins; a
   malicious author bypasses everything by design (they plug into system
   classes). Value size cap stays (protocol sanity), flood-caps do not.
5. **Theme import —** DECIDED: hard cut (owner is the only user; no import).
6. **Debug/raw flags —** owner correction: these are **system settings, not
   plugin concerns** — "a plugin is in development mode if the system itself
   is in development mode." If they ever migrate, they are GLOBAL-scope
   properties; they do not follow the account and plugins never manage them.
7. **Loader runtime files —** DECIDED: stay files (boot-before-migrations);
   not stuffing everything into the DB — just refusing "JSON file hell" for
   CONFIG, especially with third-parties leaning on our storage.
8. **Internal-plugin signing —** DECIDED: after the system stands up enough
   for signatures to work, automated with tooling; internal plugins are full
   modules with `package.json`, exactly like every other plugin.
9. **Uninstall retains namespaces —** DECIDED: yes (durable-data ruling).
10. **Scope vocabulary —** "CHECK-closed" meant only: `scope_type` is
    constrained by a SQL CHECK inside the table DDL, so adding a scope kind
    (e.g. 'agent') later needs an ALTER migration, not just app code — a
    deliberate integrity-vs-flexibility trade. Nothing else follows from it;
    the CHECK stays (it is what makes the PRIMARY KEY trustworthy).

## Test inventory (planned)

- `spec/core/properties/keys-spec.mjs` (incl. hostile-string sweep),
  `envelope-spec.mjs`, `store-sql-spec.mjs` (sqlite dialect),
  `store-aeordb-spec.mjs` (fake-db pattern; real parity = P7, env-skipped).
- `spec/core/properties/facade-spec.mjs`, `grants-spec.mjs` (P2 — the rule
  matrix is the heart; incl. the REAL-loader E2E and the deny-log assertion).
- `spec/server/properties-routes-spec.mjs` (P3 — scope/hostile-read matrix,
  409 version conflict, secrets → hasValue).
- Boot-order fixture-plugin test (DDL before pluginLoadPromise) — P1.
- Client: `spec/client/theme-spec.mjs` rewritten around the account fetch
  (P4 — localStorage tests die with the hard cut), email specs ported (P5),
  disclosure assertions in system-settings-plugins (P6).
- `spec/ui/puppeteer/system-settings-shell-puppeteer.mjs` extended for theme
  account round-trip.
- Watchdogs (test_check): lanes already bound via node `--test-timeout`
  (60s); no test in this plan touches the network (all local store); hang
  classes named — sqlite handles closed in after-hooks, theme fetch bounded,
  deny-log I/O must never throw into the request path, P7 parity env-skipped
  with a documented bound.

## NEXT ACTION after compact

P1, in this order: 1) recon where core schema DDL executes relative to
`pluginLoadPromise` (search, don't recall); 2) write
`spec/core/properties/keys-spec.mjs` + `envelope-spec.mjs` (RED);
3) `keys.mjs` + `envelope.mjs` green; 4) `store.mjs` interface +
`store-sql.mjs` (sqlite) + DDL at the boot-safe point + boot-order fixture
test; 5) full unit lane green → commit → push. Standing rules apply
(failing-first, lane before commits, no deploys, never touch
kikx2/:3001, 500/800 caps, light DOM only).
