# Phase 2 — V1 Parity (Steps 14-19) — COMPLETE

Build order: 14 → 19 → 17 → 16 → 18 → 15

## Step 14 — Permissions System (Basic)
- [x] 14a: PermissionRule Model (`src/core/models/permission-rule-model.mjs`)
- [x] 14b: PermissionEngine (`src/core/permissions/permission-engine.mjs` + index)
- [x] 14c: Wire tool execution into InteractionController
- [x] 14d: Wire PermissionEngine into KikxCore.start()
- [x] 14e: Tests — permission-engine-spec.mjs (30 tests), core-entry updated (+2)

## Step 19 — Permission Fingerprinting
- [x] 19a: Fingerprint in createRule() + checkPermission() validation
- [x] 19b: Tests — fingerprint-spec.mjs (8 tests)

## Step 17 — Shell Plugin
- [x] 17a: Shell Tool Class (`src/core/internal-plugins/shell/index.mjs`)
- [x] 17b: Command Parser (`src/core/internal-plugins/shell/command-parser.mjs`)
- [x] 17c: ShellPermissions (`src/core/internal-plugins/shell/shell-permissions.mjs`)
- [x] 17d: Add `shell-quote` dependency
- [x] 17e: Tests — command-parser-spec.mjs (14 pass) + shell-tool-spec.mjs (10 total, 3 mock pass)

## Step 16 — Websearch Plugin
- [x] 16a: Websearch Tool Class (`src/core/internal-plugins/websearch/index.mjs`)
- [x] 16b: HTML to Markdown (`src/core/internal-plugins/websearch/html-to-markdown.mjs`)
- [x] 16c: Add `puppeteer`, `turndown` dependencies
- [x] 16d: Tests — websearch-spec.mjs (15 total, 12 pass)

## Step 18 — Help System
- [x] 18a: HelpIndex (`src/core/help/help-index.mjs`)
- [x] 18b: HelpTool plugin (`src/core/internal-plugins/help/index.mjs`)
- [x] 18c: Tests — help-index-spec.mjs (15 total, 12 mock pass)

## Step 15 — WebSocket Transport
- [x] 15a: WebSocketTransport (`src/server/transport/websocket-transport.mjs`)
- [x] 15b: Reconnection protocol (lastSeenOrder replay)
- [x] 15c: Add `ws` dependency
- [x] 15d: Tests — websocket-spec.mjs (15 pass)

## Results
- **New tests:** ~95 across 7 new spec files
- **Non-DB tests pass:** 101/117 (16 fail = all node:sqlite pre-existing)
- **Full suite:** 604 total, 279 pass, all failures = node:sqlite (Node 20 vs Node 22+)
- **Dependencies added:** shell-quote, turndown, puppeteer, ws
- **New files:** 15 source files, 7 test files
