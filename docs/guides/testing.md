# Testing guide

> **Current documentation — Kikx v3 (unreleased).** Last verified 2026-10-30 against `package.json` and the complete `spec/` tree.

Kikx uses Node's built-in test runner for all lanes. As of the verification date, the main `*-spec.mjs` suite contains 328 files. The UI lanes hold 12 Playwright, 13 Puppeteer, and 26 Stagehand files.

## Run every lane

```bash
npm test                # unit + ui:playwright (the two hermetic lanes)
npm run test:unit       # the unit lane alone, for a fast loop
npm run test:all        # unit + ui:playwright + ui:stagehand + ui:puppeteer
```

All three call `scripts/run-test-lanes.mjs`, which runs each lane in turn and
prints a per-lane PASS/FAIL summary plus an explicit `NOT RUN` line for any lane
it did not select. Its exit code is 0 only if every lane that ran passed.

Lane selection comes from `resolveSelection()` in `scripts/test-lanes.mjs`: no
argument selects `DEFAULT_LANE_NAMES` (`unit`, `ui:playwright`), `--all` selects
every lane, and a bare lane name selects just that lane. Passing an explicit lane
name therefore **overrides** the default set — which is why `npm test` must not
name one.

A lane that matches its globs but executes no tests is reported as `EMPTY` and
fails the gate. Ten of the twelve Playwright specs skip themselves when no
Chrome binary is present, so without this rule a Chrome-less host would print
PASS for a browser lane that asserted nothing.

**Why this exists.** The lane globs are disjoint: the unit lane matches
`spec/**/*-spec.mjs`, while the UI specs end in `-playwright.mjs`,
`-stagehand.mjs`, or `-puppeteer.mjs`. Until the runner landed, `npm test`
matched only the unit glob, so a green `npm test` said nothing about the UI
lanes, and several consecutive "full suite green" reports silently excluded
every browser spec. Never quote a suite total without also quoting the lane it
came from.

## Main suite

```bash
npm test
```

`npm test` runs the unit lane **and** the Playwright lane (30-second and
60-second per-test timeouts respectively). For a fast unit-only loop use
`npm run test:unit`. `spec/scripts/test-lane-coverage-spec.mjs` asserts the shape
of these scripts and fails if `test` names an explicit lane, so the default set
cannot silently shrink again.

The suite includes unit, integration, lifecycle, concurrency, recovery, routing, storage, server, and client-model coverage. Major core families include agents, auth, commands, compaction, config, context, database, frames, mentions, merge, OCR, plugins, preferences, questions, runtime, tags, teams, and tools.

## Disposable PostgreSQL warning

The PostgreSQL driver/search specs probe `KIKX_TEST_PG_URL`. If reachable, they create/use the `documents` table and delete test prefixes between cases. Their fallback is a private loopback test cluster.

Never point `KIKX_TEST_PG_URL` at development, dogfood, production, or any database whose contents matter. Use a disposable cluster dedicated to tests. A missing test cluster causes the PostgreSQL-specific cases to skip; it does not prove the PostgreSQL contract passes.

Run the driver family explicitly only with that same precaution:

```bash
timeout 120 node --test --test-timeout=30000 'spec/core/database/*-spec.mjs'
```

## Browser lanes

Package commands:

```bash
npm run test:ui:playwright
npm run test:ui:puppeteer
npm run test:ui:stagehand
```

A separate Puppeteer canvas benchmark lives under `spec/ui/spike/` and is not part of the package glob.

Current package UI commands run through `scripts/with-aeordb-token.mjs`. This is legacy test-harness coupling: local browser fixtures inject a native auth-service double, but the wrapper still requires an AeorDB token/root-key path. Do not document that coupling as a product requirement.

**The wrapper exits 2 when AeorDB is unreachable, before any spec runs.** That makes `npm run test:ui:playwright` fail for an environment reason rather than a product reason. The Playwright lane needs no database at all — each spec starts its own fixture server and skips itself when Chrome is absent — so prefer the direct command, which `scripts/run-test-lanes.mjs` uses:

```bash
npm run test:ui:playwright:direct
```

Database-neutral direct commands are available when their actual prerequisites are supplied:

```bash
timeout 120 node --test --test-timeout=60000 'spec/ui/playwright/*-playwright.mjs'
timeout 120 node --test --test-timeout=60000 'spec/ui/puppeteer/*-puppeteer.mjs'
KIKX_STAGEHAND_OPENAI_API_KEY='<test credential>' \
  timeout 120 node --test --test-timeout=60000 'spec/ui/stagehand/*-stagehand.mjs'
```

Do not put the Stagehand credential in a command transcript, tracked file, or documentation. If no explicit model key is present, the Stagehand utility currently attempts a legacy AeorDB lookup for an agent secret.

Chrome is located by `findChromeExecutable()` in `spec/ui/stagehand/stagehand-test-utils.mjs`, which checks `KIKX_STAGEHAND_CHROME_PATH`, then `CHROME_PATH`, then `/opt/google/chrome/chrome`, `/usr/bin/google-chrome`, `/usr/bin/chromium`, and `/usr/bin/chromium-browser`. It does **not** read `CHROME_BIN`; setting that variable has no effect on these specs. When no candidate exists the browser specs report as skipped, not failed — a skip here means the browser contract was never exercised.

## Choosing coverage

- Pure functions and stores: focused `spec/core` or `spec/shared` cases.
- HTTP contracts and composition: `spec/server` plus relevant core tests.
- Client state/render logic: `spec/client` mini-DOM tests.
- Ownership/ancestry changes: `spec/ownership` and matching agent/session tests.
- Browser module, focus, lifecycle, layout, scrolling, or event behavior: Playwright or Puppeteer.
- Any user-facing UI change: add/update Stagehand coverage under project policy.
- Database drivers: run the shared contract harness plus driver-specific search/error tests.
- Plugins: loader, registry, descriptor, client-asset, and real plugin behavior.

## Static verification

```bash
npx --no-install eslint .
git diff --check
```

For documentation consolidation, also verify active links and stale locations:

```bash
test ! -e bot-docs
rg -n 'bot-docs/' README.md docs --glob '*.md'
rg -n -i '\bAeorDB\b' README.md docs --glob '*.md'
rg -n '/home/wyatt|~/Projects/kikx-workspace/kikx2|bot-docs/' README.md docs --glob '*.md'
```

The last three are review queries, not unconditional zero-match assertions: backend reference, migration instructions, and clearly marked historical records may legitimately mention AeorDB or an old path.

## Interpreting results

Report passes, failures, and skips separately. A green suite with PostgreSQL cases skipped is not database parity evidence. A mini-DOM pass is not browser/framework evidence. A browser pass against a stub proves the client workflow but not a live external provider. Match claims to the lane that actually ran.

A gate is only trustworthy if no source file changed while it ran. Confirm with a freshness check before quoting a result:

```bash
START=$(date +%s)
# ... run the lane ...
find src spec docs scripts package.json -type f -newermt "@$START" | wc -l   # must be 0
```

Include `docs/` in that check. The documentation invariants in `spec/architecture/documentation-spec.mjs` walk the tree, so a report written mid-run fails a suite that would otherwise be green. Include `scripts/` and `package.json` as well: editing the gate while the gate runs is the same error in a different directory.

## Sources of truth

- `package.json`
- `scripts/run-test-lanes.mjs`
- `spec/`
- `spec/core/database/driver-contract-harness.mjs`
- `spec/core/database/postgresql-connection-spec.mjs`
- `spec/core/database/postgresql-search-spec.mjs`
- `spec/ui/stagehand/stagehand-test-utils.mjs`
- `.codex/quirks.md`

## Related

- [Development setup](development.md)
- [Frontend guide](frontend.md)
- [Database driver reference](../reference/database-drivers.md)
- [Plugin authoring](plugin-authoring.md)
