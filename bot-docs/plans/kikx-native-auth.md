# Kikx-native authentication + PostgreSQL-primary storage

Status: **DONE (Phases A–C)** — owner approved 2026-10-06; PostgreSQL is the live primary store.

## Goal

Make **PostgreSQL the primary system of record** for a Kikx distribution
container, with authentication owned by **Kikx core** rather than by AeorDB.
The database becomes a plain document store; Kikx owns users, sessions, API
keys, and magic links.

AeorDB remains available (and its data preserved) so Kikx can move back to it
later once it is stable. It is no longer the authority for identity.

## Why (current coupling)

Today authentication *is* AeorDB:

- `src/server/routes/auth-routes.mjs` proxies all four endpoints
  (`/auth/magic-link`, `/magic-link/verify`, `/token`, `/refresh`) to
  `context.require('aeordb')` — which `createServer` sets to the **active
  storage driver**.
- `src/core/account/account-store.mjs` `verifyIdentity()` authenticates by
  calling AeorDB's `withToken(token).listOwnAPIKeys()`; email/username come from
  AeorDB `system/user` records.
- `AeorDBClient` supplies `requestMagicLink`, `verifyMagicLink`,
  `exchangeAPIKey`, `refreshToken`, `listOwnAPIKeys`, `getSystemUser`,
  `updateSystemUser`.

`PostgreSQLConnection` and `SQLiteConnection` have none of these, so switching
the default driver to PostgreSQL breaks login (500 on `/auth/magic-link`;
`verifyIdentity` silently degrades to `false`). Therefore the auth subsystem
must land before (or with) the driver switch.

Per owner: **do not** extract an "AeorDB auth provider" abstraction. Replace the
AeorDB-specific auth surface with a Kikx-owned subsystem that runs over the
generic driver contract, so it works identically on AeorDB, SQLite, and
PostgreSQL.

## Non-goals (for now)

- SAML/OAuth/social login.
- JWT / stateless tokens (owner: opaque tokens now, JWT "later"; keep the token
  layer swappable).
- Multi-tenant orgs, roles beyond `user | admin`.
- Password login is optional; magic-link + API keys are the required paths.

## Phases

### Phase A — PostgreSQL in the image + deploy (kikx-docker)

Bake the PostgreSQL 17 server into `kikx/kikx`, keeping all data **and config**
under the existing bind-mounted home dir.

- Data/config dir: `${KIKX_HOME}/.local/share/kikx/postgres` (same mount that
  already carries `kikx.aeordb`, `runtime/`, `chrome-profile/`).
- New `docker/lib/postgres-supervisor.mjs`: idempotent first-run `initdb`,
  generated per-instance password, `postgres` child (not `pg_ctl` daemon) with
  log forwarding and fatal-exit handling, `pg_isready` wait, fast shutdown.
- `docker/entrypoint.mjs`: start Postgres before Kikx; construct the driver URL
  and pass it (plus `ORG_AEOR_KIKX_DATABASE_DRIVER=postgresql`) into the Kikx
  child env. AeorDB supervision stays for now (data preserved; "move back").
- `images/kikx/Dockerfile`: install `postgresql postgresql-contrib` (PG17) with
  `create_main_cluster=false` + a `policy-rc.d` guard so no cluster is created
  at build time; add `pg` to the app's npm install (it is an optionalDependency
  and must be present for the driver).
- `compose.yml` / `.env.example` / `README.md` / `bootstrap.sh`: document and
  wire `KIKX_DATABASE_DRIVER=postgresql`, `KIKX_DATABASE_URL`, `PG_HOST_PORT`.

Port: `PG_HOST_PORT` default **5433** on `127.0.0.1`. Because `network_mode:
host` shares host loopback, the port must not collide with any host service; the
generated password + `scram-sha-256` for TCP connections is required (not
`trust`).

### Phase B — Kikx-native auth (kikx core)

`AuthService` + stores over the generic driver contract
(`get/put/merge/delete/list/entries/getMany/batch` — the universally required
methods, so no search/scan dependency).

Document layout (under the active driver):

- `/kikx/auth/users/<userId>.json` — `{ id, email, username, name, roles[],
  status, disabled, createdAt, updatedAt }`
- `/kikx/auth/email-index/<normalizedEmail>.json` — `{ userId }` (O(1) lookup; no
  reliance on `search`).
- `/kikx/auth/sessions/<tokenId>.json` — `{ id, userId, secretHash, createdAt,
  accessExpiresAt, refreshExpiresAt, rotatedFrom, revokedAt, userAgent, ip }`
- `/kikx/auth/api-keys/<keyId>.json` — `{ id, userId, label, prefix, secretHash,
  createdAt, lastUsedAt, expiresAt, revokedAt }`
- `/kikx/auth/magic-links/<linkId>.json` — `{ id, email, userId?, codeHash,
  createdAt, expiresAt, consumedAt }`

Token strategy (opaque now, swappable later):

- Access + refresh tokens are `<tokenId>.<secret>`; only `sha256(secret)` is
  stored, so a DB read cannot mint a token. Lookup is O(1) by `tokenId`.
- Short-lived access token, long-lived rotating refresh token; rotation revokes
  the prior session record and links via `rotatedFrom`.
- API keys use the same `<id>.<secret>` shape with a display `prefix`.

Mailer is pluggable: default `LogMailer` (dev mode — logs/returns the magic-link
URL when no SMTP is configured); `SmtpMailer` when SMTP settings exist. Config
lives under `/kikx/auth/...` config paths.

Root/admin bootstrap: on first run (empty user set), create the
`KIKX_ADMIN_EMAIL` user and emit a one-time setup link; store bootstrap state
under `KIKX_HOME`. Never fatal.

Rewire `auth-routes.mjs` and `AccountStore` to `AuthService`; remove the
`withToken`/`getSystemUser` dependence. New endpoints: `GET /auth/me`,
`POST /auth/logout`, `GET|POST|DELETE /auth/api-keys`.

### Phase C — Migrate AeorDB documents → PostgreSQL (done)

Copied every non-internal document with `scripts/migrate-database.mjs` over the
generic driver contract (`entries()` + `get()` + `put()`), skipping AeorDB's
`.aeordb-*` index/config files. The tool records a size+sha256 manifest and
verifies each target document byte-for-byte (dry-run / verify-only / resume
supported).

Live result (2026-10-06): 9202 source paths, 77 AeorDB-internal excluded,
**9125 documents migrated and verified, 0 mismatch**; the target holds those
plus 3 bootstrap auth documents. `kikx.aeordb` is untouched as a read-only
fallback. `deploy.sh` is PostgreSQL-primary and now runs the legacy AeorDB
scheduled-frame verifier only when AeorDB is the active driver.

## Decisions (owner)

- PostgreSQL is the primary driver; move back to AeorDB later when stable.
- Opaque tokens now; JWT may come later (keep the token layer swappable).
- No AeorDB auth-provider abstraction.

## Verification

- `kikx`: unit specs for every store + `AuthService` over the in-memory
  reference driver; a full magic-link → verify → refresh → logout round-trip;
  API-key exchange; expired/revoked/replayed token rejection; a Postgres-backed
  run when the private cluster is up; `npm test` green.
- `kikx-docker`: image builds; throwaway container boots Postgres, creates the
  cluster once, restarts idempotently, data persists across container
  recreate, and Kikx reaches `ready:true` against it.
- Phase C: live migration + byte-for-byte verification; a Postgres-backed
  magic-link → verify → `/auth/me` → `/account` → API-key → session-list
  round-trip against the migrated data.
