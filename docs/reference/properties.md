---
title: Properties store reference
status: current
doc_type: reference
audience: [developers, maintainers, operators]
applies_to: development-v3
last_verified: 2026-11-13
canonical: true
keywords: [properties, settings, theme, email, secrets, envelope, grants, manifests, scopes]
---

# Properties store reference

> **Current documentation — Kikx v3 (unreleased).** Last verified 2026-11-13
> against plan `docs/plans/properties-store.md` (all phases P1–P7 delivered).

One durable home for settings that must follow the user and the system —
replacing `localStorage` for theme and `.kikx/mailer.json` for email (owner,
2026-11-13: "Dropping random JSON blobs is not only messy, but unflexible
(with our plugin architecture), and likely will end up being a security hole
we will have to patch later.").

## Members today

| Setting | Key | Scope | Secret |
| --- | --- | --- | --- |
| Primary theme | `/core/user/theme/primary_color` | `(account, uid)` | no |
| Email configuration | `/core/kikx/email/configuration` | `global` | yes (whole value sealed) |

Both are **clean cuts**: no `localStorage` import, no `.kikx/mailer.json`
import — a leftover file is ignored by design.

## Schema and values

- PK `(scope_type, scope_id, key)`; `scope_type` CHECK-closed to
  `global | account | session | plugin` (`''` scope_id for global); soft
  delete (`deleted_at`) keeps **cleared ≠ never-set**; `version` is
  optimistic concurrency (HTTP mismatch → **409**).
- Values are **JSONB-always**: plain `{"value": …}` or a self-describing
  envelope `{"__enc":{v,alg,kid,iv,tag,ct}}`. On open, `alg` must equal the
  row's `encryption_method` and `kid` must equal `key_ref`, or the read
  **refuses** (column tampering cannot re-aim decryption). Presence of the
  envelope columns IS the secret flag — there is no separate boolean.
- Algorithm allowlist: `aes-256-gcm` only (agility is downgrade surface).
  Secret reads/writes are **fail-closed** without a usable
  `KIKX_PROPERTIES_ENCRYPTION_KEY`.
- Keys normalize on every call (trim, lowercase, collapse `//`, refuse
  `..`/`.`/empty/control segments, ≤256 chars); value cap 64KB. **No
  quotas** — owner trust doctrine: guardrails serve healthy plugins; a
  malicious author can bypass everything by design.

## Callers and rules (plan §2–§3)

- **Relative keys** resolve into the caller's own namespace:
  a plugin's `foo` → `/plugins/<fqid>/foo`, forced scope `(plugin, fqid)` —
  unrestricted and **dynamic** (no declaration), with declared own keys
  schema-validated (`string | number | boolean | object | array | null`).
- **Path tokens — the calculate step (owner Q1, 2026-11-13):** paths are
  calculated FOR the permission system first, then evaluated — the AeorDB
  discipline. `{current}` is the ONE server-interpreted token: resolved from
  the authenticated identity at the facade's resolve step; it refuses
  wherever no identity exists (plugins always; core unless one is passed),
  and a hostile identity is refused, never spliced. `{UUID}` is NOT
  server-interpreted — the requester substitutes a real id before the
  request; in grant PATTERNS a `{uuid}` segment (any spelling, lowercased)
  matches exactly one segment (`/core/user/{uuid}/theme/primary_color`).
- **Absolute keys** (leading `/`): `core` (server code only — bundled
  plugins get **no** ambient rights) has ambient access; every
  `plugin:<fqid>` caller runs the gauntlet: core-owned sensitivity registry
  (`public | internal | secret`, unmatched defaults `internal`) + manifest
  grants. Prefix-only wildcards (`/core/*`, `/*`) plus `{uuid}` segments.
  Public reads are free unless manifest-denied.
- **Evaluation — AeorDB-inspired (owner Q2, 2026-11-13; cf. aeordb
  `permission_resolver.rs`: "nearest level with an opinion wins, deny wins at
  the same level"):** the NEAREST (most specific) matching declaration wins —
  full-literal exact > `{uuid}` match > longer prefix > the root `/*` — and
  **deny decides equal-specificity ties**; no matching declaration = no
  opinion = **default deny**. So plan §4's literal example
  (`"deny": "*"` + one exact allow) grants exactly that key, as written.
- Denied absolute attempts emit one structured line:
  `[properties-deny] caller=… action=… key=… decision=deny reason=…`
  (logging can never throw into the request path).
- v1 scope forcing: a plugin's absolute access is **global-scoped** —
  granted key, global rows only; account/session rows stay on the core and
  HTTP-identity paths.

## HTTP surface (`/api/v1/properties`, plan P3)

- 401 without identity (auth-family parity); 503 when the store is absent.
- Default scope = the caller's **own account**; explicit account scope must
  equal the caller (cross-account read/write → 403); global read open,
  global write behind the identity bar; `session`/`plugin` are 403 at the
  transport; unknown vocabulary → 400.
- Secrets cross the transport as **`hasValue` only** — never the plaintext,
  on read or write echo. `updated_by` records the writing identity.

## Manifest declarations (signed; plan P4/P6, guide: [Plugin authoring](../guides/plugin-authoring.md))

`manifest.json` — the exact file `.kikx-sig` signs — may declare
`pluginID` (FQID, ≥3 segments), `access` (read/write grant maps), and
`properties` (own-key schemas). All three register atomically at admission
before any plugin code runs; malformed blocks refuse the load; failed loads
and unloads release the grants. The Settings → Plugins card discloses the
grants line (`Properties: <fqid> · reads … · writes … · declares …`).

## Backends

One `PropertiesStore` contract, three drivers: **sqlite** (unit dialect),
**PostgreSQL** (live default when a database URL is configured),
**AeorDB** (`db.putFile`, one document per scope — retired on this host by
owner ruling). Cross-backend shape parity is enforced by
`spec/core/properties/store-parity-spec.mjs`; live parity tests are
opt-in env-gated (`KIKX_PROPERTIES_PARITY_URL`,
`KIKX_PROPERTIES_PARITY_AEORDB_URL`) and skip by default.

### Running the live parity gate

The unit lane is hermetic by contract, so the live gates skip unless opted
in. To exercise the PostgreSQL gate against the dev database (the DSN stays
in `.env.dev` and is never printed):

```sh
cd kikx
set -a; . ./.env.dev; set +a
KIKX_PROPERTIES_PARITY_URL="$ORG_AEOR_KIKX_DATABASE_URL" \
  node --test spec/core/properties/store-parity-spec.mjs
```

The live test is self-cleaning and history-proof: `put → get → put (the
version increments by exactly 1) → delete clears the value` on an isolated
`/core/parity/probe` key — nothing else in the store is touched. It
deliberately does NOT assert `version === 1`: soft-delete bumps versions by
design (cleared ≠ never-set), so accumulated history can never redden the
gate. Last exercised green on this host: **2026-11-14 (7 pass,
0 fail)**. The AeorDB gate stays skipped forever (backend retired by owner
ruling); a run without the env var is the honest default (6 pass,
2 skips).

## Configuration

- `KIKX_PROPERTIES_ENCRYPTION_KEY` — 64 hex chars or canonical base64 of 32
  bytes; fail-closed when absent/unusable (see [.env.example](../../.env.example)).
- Boot order: the store (and grants/facade) open **before**
  `pluginLoadPromise` so a plugin may write properties during `setup()`.

## Related

- Plan: [Unified properties store](../plans/properties-store.md)
- [Plugin authoring](../guides/plugin-authoring.md) — manifest blocks
- [Plugin system](./plugins.md), [Configuration](./configuration.md),
  [Database drivers](./database-drivers.md)
