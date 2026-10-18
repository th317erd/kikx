# Browser gate diagnosis — 2026-10-18

**Root cause: the stagehand fixture injected its auth double under the wrong key.**
`createAuthStub()` (`spec/ui/stagehand/stagehand-test-utils.mjs:395`) is an **auth-SERVICE**
double — it exposes `requestMagicLink` / `verifyMagicLink` / `exchangeAPIKey` /
`refreshToken`. The fixture injected it as `aeordb: createAuthStub()` (`:122`), so
`create-server.mjs:254` found no `authService`, built the **real** one on top of a
non-database, and `verifyMagicLink` → `magicLinks.consume()` (`auth-service.mjs:82`) threw
`401 invalid_magic_link`. Every spec then sat on the sign-in screen and timed out on
`kikx-session-card`.

## Evidence (boot probe against the fixture)
```
pageerror        (none)
failed requests  (none)
api responses    401 GET /api/v1/auth/magic-link/verify?code=playwright-test
custom elements  aeor-input, kikx-app, kikx-error-surface
body innerText   "Sign in / … / Magic link is invalid or expired"
```
No `pageerror`, no failed request: the client executed cleanly and the server answered 401.
`<main class="kikx-auth-main">` renders instead of the session grid.

## Hypotheses killed by evidence (mine, all three)
- **"The app never boots."** False — `kikx-app` is present, shell and auth panel render.
- **"`Kikx auth bootstrap skipped: db.list is not a function` is the cause."** False — it is
  caught at `create-server.mjs:293-321` and returns `{error}`; boot continues. It is the
  *same wrong-key bug's* second symptom, not the failure. Loudest log line, wrong culprit.
- **"The wrapper is the whole story."** Only layer one; see below.

## Layer 1 — wrapper env mismatch (bypassable)
`scripts/with-aeordb-token.mjs:26` defaults to `http://127.0.0.1:6830`; `.env.dev:1` pins the
same. Nothing listens there (`curl` → 000); live AeorDB is `127.0.0.1:6833` (pid 1358773).
`npm run test:ui:playwright` therefore exits 2 with **zero tests executed**. Running the
specs directly avoids it — the fixture needs no live DB.

## Blast radius / attribution
All three playwright specs failed at `kikx-session-card`, including two pre-existing ones
(`thinking-rack-playwright.mjs`, `team-manager-playwright.mjs`), so this is a **fixture
defect that predates the ask-user work** — not a P3/P4 regression.
`test:ui:playwright` is **not** in the main gate (`test` = `spec/**/*-spec.mjs`), which is
why it went unnoticed. `stagehand-test-utils.mjs` last changed at `0fba2f9`.

## Fix applied
Inject the stub under `authService` (kept under `aeordb` as well so the legacy db alias still
resolves). One line + comment; backup `/tmp/stagehand-utils.bak`.
Residual: `db.list` warning persists (the `aeordb` alias still holds the auth double) —
benign, caught, and out of scope for this fix.

## Status
- `Unverified:` post-fix suite exit code and counts — run in flight (`/tmp/browser-fixed.log`).
