# Kikx documentation consolidation campaign

> **Completed documentation campaign (2026-10-27).** This plan records the
> consolidation of the former documentation trees. It is implementation
> history, not current product authority. Executable source, tests, and the
> current canonical docs remain authoritative.

## Objective

Create one comprehensive, bot-friendly documentation system under `docs/` for
Kikx development revision 3. Correct current guidance against live source,
preserve dated evidence as history, remove the separate `bot-docs/` tree, and
make every retained document discoverable from a canonical index.

Kikx has never had a public release. “Revision 3” describes the third internal
development implementation, not the `package.json` semantic version. Revisions
1 and 2 were abandoned after structural problems made replacement preferable to
incremental repair.

## Baseline and evidence

- Baseline revision: `4b4f902089f24c380a08063e652476411c0109a1` on `main`.
- Starting tree: clean when this campaign began; other bots may edit concurrently,
  so every phase must recheck overlap before writing.
- Existing documentation: 42 Markdown files and 7,944 lines across `docs/` and
  `bot-docs/`.
- Live implementation: 398 source files outside vendored dependencies, plus 273
  unit/spec files and separate browser suites.
- The current operational database is PostgreSQL, but the architecture is
  driver-based and source fallback remains `aeordb` when no driver is configured.
  Current general docs therefore say “the database” or “configured database
  driver”; product names belong in driver reference, operations, migrations, or
  accurately dated history.
- Known current-doc defects include stale planned-repository/plugin language,
  AeorDB-owned authentication, a hand-maintained `bot-docs/` landing page,
  contradictory driver defaults, and no record of the three internal revisions.

## Documentation authority contract

Authority descends in this order:

1. Executable source and tests.
2. Current canonical documentation.
3. Active roadmap documents, which describe intent rather than established fact.
4. Completed plans and dated reports.
5. Superseded plans and historical snapshots.

Current docs must distinguish implemented, partial, planned, and historical
behavior. Historical incidents retain backend names, ports, paths, and forensic
facts; rewriting those generically would destroy evidence.

Every current or active document receives a visible status banner. Historical
material receives a banner warning that its topology, deployment state, line
numbers, and paths may no longer be current.

## Target taxonomy

- `docs/README.md` — mandatory routing index by task, role, status, and keyword.
- `docs/overview.md` — mission, differentiators, development-v3 status, and
  implemented/partial/roadmap feature map.
- `docs/architecture/` — system, frame/runtime, actors/routing, sessions and
  hierarchy, async work, compaction, and UI-independence contracts.
- `docs/reference/` — database drivers, plugins, tools, configuration, auth,
  HTTP/SSE API, frame types, storage layout, and source map.
- `docs/guides/` — development, testing, plugin authoring, UI work, and
  troubleshooting.
- `docs/operations/` — startup, readiness, database operations, observability,
  migrations, and the boundary to the external deployment repository.
- `docs/maintainers/` — temporary diagnostics, stability, and known issues.
- `docs/roadmap/` — active design/work only.
- `docs/history/` — revision lineage, completed/superseded plans, incidents,
  reports, reviews, and migrations.

## Current contracts to document

- Frames are the durable interchange model. `FrameRuntime`, `FrameEngine`,
  `FrameRouter`, and shared `FrameManager` separate persistence, routing, and
  projection.
- Sessions are conversation channels with multiple human and bot participants,
  coordinator routing, mentions, suspension, preferences, child sessions,
  cross-session messages, and session-history merge jobs.
- Human and bot actors are implemented. Teams may contain human and bot actors.
  Plugin-provided actor resolution exists only as a seam; plugin actors are not
  yet first-class runtime participants.
- Coordinator inheritance and authority span session trees. Delegated session
  creation has current depth/ownership restrictions that must not be described
  as unlimited hierarchy.
- Agent characters, compressed character prompts, profiles, role tags, teams,
  coordinator/compactor/OCR selection, and agent-owned todos/cwd are distinct
  concepts.
- Compaction is asynchronous, selectable, budgeted by the smallest participant
  window, durable through `CompactionFrame`, and able to wait/retry/chunk/trim at
  hard limits.
- Tools create persisted call/result frames. Long commands are process-managed,
  durable across restarts, inspectable, cancellable/suspendable, and able to
  wake agents on completion.
- Plugins can register or override tools, providers, commands, selectors, core
  classes, database drivers, tags, and client components. Hot unload is partial
  for non-class registries and must be documented as such.
- Kikx-native auth is database-backed and driver-neutral. Driver `auth`
  capability is a separate legacy backend capability.
- The browser is the current UI, not the framework boundary. Core services,
  shared projection, JSON APIs, SSE, and component descriptors are designed so
  another UI can consume them.

## Phases and file ownership

### P0 — Consolidate and classify

Move every `bot-docs/` file into the target `docs/` taxonomy, preserving content
and history. Correct known dangling self-references. Add banners to every moved
plan/report/incident. Remove the empty `bot-docs/` tree and active references to
it.

### P1 — Canonical architecture and concepts

Rewrite current architecture, agent runtime, routing, session hierarchy,
compaction, async-process, and UI-independence docs from source. Extract durable
contracts from completed plans instead of making readers reconstruct current
behavior from campaign ledgers.

### P2 — Reference, guides, and operations

Document database-driver capabilities, persistence, native auth, configuration,
plugin authoring, tool inventory/lifecycle, HTTP/SSE routes, development,
testing, and operations. Describe PostgreSQL as the current operational primary
only where that fact matters; preserve the configured-driver abstraction
elsewhere.

### P3 — Index, history, and root entry points

Write the development-revision history and complete routing index. Update the
root README and TODO/document links so they point into the consolidated tree.
Every Markdown file under `docs/` must appear in the index or in a recursively
indexed historical section.

### P4 — Drift guard and verification

Add a read-only documentation test that checks consolidation, index coverage,
relative Markdown links, status banners, and forbidden active `bot-docs/`
references. Run it, lint changed JavaScript, validate Markdown structure and
links, inspect the final diff, and perform an adversarial source/doc review.

## Verification spine

- `test ! -e bot-docs`
- Enumerate every `docs/**/*.md`; compare it mechanically with index entries.
- Check relative Markdown links while ignoring fenced code and external URLs.
- Search current canonical docs for `AeorDB`/`PostgreSQL`; allow only driver,
  operations, migration, compatibility, or explicitly historical context.
- Search active docs for stale absolute home paths, old `kikx2` working-copy
  claims, missing referenced documents, and `bot-docs/`.
- Run the new documentation architecture spec with a bounded timeout.
- Run ESLint on changed JavaScript and `git diff --check`.
- Do not run the repository-wide suite against an unverified PostgreSQL URL:
  parts of the suite create documents and delete test prefixes. Full-suite
  execution requires a confirmed disposable test database or separate owner
  authorization.

## Definition of done

- All 42 starting documents are accounted for by merge, rewrite, or visibly
  historical relocation; no information is silently discarded.
- `bot-docs/` no longer exists.
- The root README and `docs/README.md` identify revision 3, its unreleased state,
  and the difference between development revision and package version.
- The user-listed differentiators have source-backed current status and links to
  their detailed contracts.
- Current docs use database-neutral language except where an implementation
  name is necessary.
- Current auth, plugin, routing, compaction, async tool, session tree, team,
  character/profile, and UI boundary descriptions match live source.
- Historical evidence remains readable and clearly non-authoritative.
- Every document is indexed for bots by role/task/status.
- Documentation verification passes, and unrun database-writing gates are
  reported rather than implied.
- No commits, pushes, branch changes, or deployment actions are performed; the
  coordinator bot owns repository landing.

## Completion record

All phases were completed on 2026-10-27. The former `bot-docs/` content was
classified and retained under `docs/`; current architecture, reference, guides,
and operations documentation was source-audited; the bot-oriented index covers
every document; and the read-only documentation architecture spec enforces
consolidation, index coverage, links, authority banners, and retired paths.

The broad application suite was intentionally not run because its configured
database was not confirmed disposable. Documentation checks, focused lint,
link validation, whitespace validation, and repository-wide drift searches are
the completion evidence for this documentation-only campaign.
