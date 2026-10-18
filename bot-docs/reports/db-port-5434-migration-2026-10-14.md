# Handoff: prod `kikx` database moved to the personal cluster on 5434

> **SUPERSEDED / REVERTED (2026-10-14).** The owner chose to keep prod in the
> container on **5433**. The 5434 clone (`kikx` DB + `kikx` role) has been
> **dropped**; 5434 is dev-only again (`kikx-dev`). Do **not** act on the
> switchover steps below — they are historical. Prod remains the container's
> bundled PG17 on 5433.

**From:** Pi (wyatt-desktop) · **Date:** 2026-10-14 · **Owner-requested change**

## What changed (infrastructure only — no application code touched)

The owner asked to remove the one-database `5433` port exception and have
everything use the personal PostgreSQL cluster on `5434`.

Done on the host:

- Created role **`kikx`** (LOGIN) on the `5434` cluster, using the **same
  password** already stored in `${KIKX_HOME}/.local/share/kikx/postgres/db-password`,
  so switching the app from 5433 to 5434 only requires a port change.
- Created database **`kikx`**, owned by role `kikx`, on the `5434` cluster.
- Migrated the prod data with `pg_dump` (container PG17, socket
  `/tmp/kikx-postgres-5433`) piped into `psql` (host PG18, `127.0.0.1:5434`),
  `--no-owner --no-privileges`, restored **as the `kikx` role** so ownership is
  correct.

Verified: `documents` = **52,928 rows** on both sides; 1 table, 2 indexes,
extensions `pg_trgm` + `plpgsql`; database size 273 MB (source 312 MB — fresh,
compacted load). TCP login as `kikx` on 5434 works.

## What the Kikx bot needs to change

The prod database no longer needs to live in the container, so the app should
point at the host cluster and the bundled PG should be retired:

1. `kikx-docker/compose.yml` — `PG_HOST_PORT: "${PG_HOST_PORT:-5433}"` (line 56)
   is the single knob that pins this. Do **not** simply set it to `5434`: the
   container uses `network_mode: host`, and the host cluster already owns
   `127.0.0.1:5434`, so the bundled PG would collide. Instead point the
   application's database URL at `127.0.0.1:5434` (the pattern already used by
   `.env.dev`: `ORG_AEOR_KIKX_DATABASE_URL`) and stop supervising a bundled
   Postgres.
2. `kikx-docker/docker/entrypoint.mjs` — `const PG_PORT =
   process.env.PG_HOST_PORT || '5433'` (line 58) starts/binds that bundled PG.
3. `kikx-docker/.env.example` — `PG_HOST_PORT=5433` (line 11).
4. `kikx-docker/README.md` — port references on lines 50, 80, 85, 93, 110.
5. `kikx/bot-docs/database-drivers.md` — the "Ports on this host (2026-10-08)"
   note describing prod on 5433.
6. `kikx/bot-docs/plans/kikx-native-auth.md` (line 70) and the staged copy under
   `kikx-docker/images/kikx/staging/app/bot-docs/plans/`.
7. `kikx/.pi/DETAILS.md` — the port map (lines ~11-25) and line ~40.

Also worth noting: `5432` stays reserved for the owner's work SSH tunnel, which
is why the personal cluster lives on `5434`.

## Rollback / safety

- **Nothing in the container was modified.** Its PG17 data directory
  `${KIKX_HOME}/.local/share/kikx/postgres` is intact and still serving 5433, so
  pointing the app back there restores the previous state exactly.
- **Hazard unchanged:** that directory is prod's live data dir — never start a
  host-side Postgres against it while the container runs (one writer only).
- The container should keep running its bundled PG until the application is
  switched, otherwise prod breaks. Retire it only as part of that switch.
