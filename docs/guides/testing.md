# Testing guide

> **Current documentation — Kikx v3 (unreleased).** Last verified 2026-10-27 against `package.json` and the complete `spec/` tree.

Kikx uses Node's built-in test runner for all lanes. As of the verification date, the main `*-spec.mjs` suite contains 274 files: architecture 2, client 98, core 141, ownership 5, scripts 3, server 22, and shared 3.

## Main suite

```bash
npm test
```

The package command applies a 120-second outer timeout and a 30-second per-test timeout to `spec/**/*-spec.mjs`.

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

The top-level lanes currently contain 7 Playwright files, 11 Puppeteer files, and 26 Stagehand files. A separate Puppeteer canvas benchmark lives under `spec/ui/spike/` and is not part of the package glob.

Current package UI commands run through `scripts/with-aeordb-token.mjs`. This is legacy test-harness coupling: local browser fixtures inject a native auth-service double, but the wrapper still requires an AeorDB token/root-key path. Do not document that coupling as a product requirement.

Database-neutral direct commands are available when their actual prerequisites are supplied:

```bash
timeout 120 node --test --test-timeout=60000 'spec/ui/playwright/*-playwright.mjs'
timeout 120 node --test --test-timeout=60000 'spec/ui/puppeteer/*-puppeteer.mjs'
KIKX_STAGEHAND_OPENAI_API_KEY='<test credential>' \
  timeout 120 node --test --test-timeout=60000 'spec/ui/stagehand/*-stagehand.mjs'
```

Do not put the Stagehand credential in a command transcript, tracked file, or documentation. If no explicit model key is present, the Stagehand utility currently attempts a legacy AeorDB lookup for an agent secret.

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

## Sources of truth

- `package.json`
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
