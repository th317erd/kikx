# Browser gate diagnosis — 2026-10-18

**Root cause: the stagehand fixture injected its auth double under the wrong key.**
`createAuthStub()` (`spec/ui/stagehand/stagehand-test-utils.mjs:402`) is an **auth-SERVICE**
double — it exposes `requestMagicLink` / `verifyMagicLink` / `exchangeAPIKey` /
`refreshToken`. The fixture injected it as `aeordb: createAuthStub()` (`:129`), so
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
Residual: an auth-bootstrap warning persists, but the message is now
`authService.ensureAdmin is not a function` (the stub exposes no `ensureAdmin`) rather than
`db.list is not a function` — benign, caught, out of scope for this fix.

## Post-fix evidence (measured, not reported)
Specs run directly, bypassing the `:6830` wrapper (`/tmp/e2e/direct-suite.log`, 22:48:55 -0700):

```
node --test --test-timeout=60000 'spec/ui/playwright/*-playwright.mjs'
✔ the Inbox lists open questions in the browser and posts a free-form answer (1684ms)
✔ Playwright manages teams through the topbar Teams UI (3087ms)
✔ the thinking rack shows a fixed per-agent panel and never pollutes the thread (2999ms)
tests 3 · pass 3 · fail 0 · skipped 0 · REAL_EXIT=0
```
`find src spec -newer /tmp/e2e/direct-suite.log` → nothing, so that log certifies HEAD `0d8640b`.

## Proof the browser gate can fail (red → green → red)
A green suite proves nothing unless the same spec can go red. One spec, three runs:

| Log (mtime -0700) | Tree | Result |
|---|---|---|
| `/tmp/browser-fixed.log` 22:42:47 | fixture fix only | 3 tests, 2 pass, **1 fail** |
| `/tmp/browser-real-1.log` 22:45:24 | + `applyAuth` questions fix | **3 pass, 0 fail** |
| `/tmp/mutant-browser.log` 22:45:48 | `applyAuth` fix removed | **1 fail** — `locator.waitFor: Timeout 10000ms`, `.kikx-sidebar__inbox-badge`, `inbox-question-playwright.mjs:132` |

The failing assertion is the sidebar Inbox badge, i.e. the exact user-visible consequence of the
missing `_loadQuestions()` call — not an incidental timeout. No mini-DOM spec could observe a
missing fetch in the `applyAuth` path.

## Correction — the pre-fix probe is stale, not fresh
`/tmp/e2e/boot-probe.log` is timestamped 22:32:59, i.e. **10 minutes before** the fixture fix was
written (`stagehand-test-utils.mjs` mtime 22:42:33). Its `401 /magic-link/verify` is pre-fix
evidence. It was briefly reported as a fresh contradicting run; that reading was wrong.

## Residual warning is `ensureAdmin`, not `db.list`
Current runs emit `Kikx auth bootstrap skipped: authService.ensureAdmin is not a function`. The
real auth service is no longer constructed (that was the 401 cause), but `createAuthStub()`
(`:402`) exposes no `ensureAdmin`, so the now-correct `authService` path warns instead. Benign —
caught at `create-server.mjs:293-321`, returns `{error}`, boot continues — but the message above
describes the *old* symptom and should not be quoted as current.

## Note on line numbers
Line references above were re-pinned after the one-line fixture fix (`authService: createAuthStub()` at `:128`, `aeordb:` at `:129`) shifted the file by 7 lines.
