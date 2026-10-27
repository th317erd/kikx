# Session-scope ownership

An item owned by session **O** is visible to viewer session **V** iff
**O === V or O is an ancestor of V**.

    visible-to-V = items owned by { V } ∪ ancestors(V)

From the owner: *"these agents would trickle down to all child sessions, but
wouldn't be usable in sessions above the level in which they are created"*, and
*"I could start a 'Kikx' project, and create my agents there"* — so usability is
granted at and below the creation level. Forbidden direction: **upward**.
Siblings and unrelated subtrees get nothing, in either direction. The user
account is the one global thing.

## Two modules, deliberately

| module | side | imports |
|---|---|---|
| `src/client/state/session-scope.mjs` | browser | none |
| `src/core/ownership/session-ownership.mjs` | server/core | none |
| `src/core/ownership/ownership-query.mjs` | server/core | `session-ownership.mjs` |

The client bundle is served straight from `src/client` (`src/server/static-files.mjs`),
so a client module importing from `src/core` would 404 in the browser, and a core
module importing from `src/client` would drag browser code into the server graph.
The duplication is therefore deliberate and **pinned**: `core-ownership-spec.mjs`
evaluates both copies over a session tree and asserts identical answers for every
ordered pair. Change the rule in one copy and that spec fails.

## Not the same as `resolveVisibleSessionIDs`

`src/core/questions/question-dedupe.mjs:120` returns `{V} ∪ descendants(V)` — it
answers *"whose questions belong in this Inbox"*. That is the **downward** view
and it is correct for the ask path. It is the **wrong** helper for ownership: used
here it would hide a project's agents from the sessions beneath it and let a
parent use its children's agents. A two-session fixture cannot tell the two apart;
`core-ownership-spec.mjs` has the distinguishing test.

## Policy

`OWNERSHIP_POLICY.ancestorsVisible` (core) / `SCOPE_POLICY.ancestorsVisible`
(client), both default `true`. It is the only switch; nothing else branches on
the rule.

## Anchor edits NOT yet applied (outside this prong's file lane)

These are the four changes that connect the rule to real data. None are in files
this prong may write.

1. **Owner field on the record.** Agent and team records carry no session field
   today. Add `ownerSessionID` at creation, in
   `src/core/aeordb/aeordb-agent-store.mjs` (`createAgent`, ~:52) and
   `src/core/aeordb/aeordb-team-store.mjs`, set from the creating session.
2. **Index it.** Declare `{ name: 'ownerSessionID', type: 'string' }` in the
   agent index body at `src/core/aeordb/aeordb-agent-store.mjs:481-503`, and the
   corresponding team index body. Without this the scope query is a scan.
3. **Filter on read.** In the same store's list path, build the query with
   `buildScopedQuery(ownerScopeFor(viewerSessionID, sessions), { path, extra })`
   and re-filter returned rows with `filterOwnedRows`. `null` from
   `buildScopedQuery` means *no rows*, never *no filter*.
4. **Pass the viewer down.** The listing route in `src/server/routes/`
   (`agent-routes.mjs`, `team-routes.mjs`) must carry the current session id into
   the store call. It is not carried today.

Backfill: existing rows have no `ownerSessionID`, and `filterOwnedRows` drops
rows with no owner rather than granting them. That is the fail-closed choice, and
it means agents created before this change disappear from scoped views until
backfilled or treated as root-owned by an explicit migration.

## Gate

    node --test spec/ownership/*-spec.mjs

A bare directory (`node --test spec/ownership`) does not work on Node 24: it is
resolved as a module path and fails with `MODULE_NOT_FOUND`.

## Specs in this directory

| file | what it pins |
|---|---|
| `session-scope-spec.mjs` | the client visibility surface: self+ancestors in, sibling out, descendant out, cycle/dangling/blank fail closed |
| `session-scope-filter-spec.mjs` | the row filter: owner read from row fields, ownerless rows dropped, caller order preserved |
| `core-ownership-spec.mjs` | the core surface: `ownerScopeFor`, `buildScopedQuery`, `filterOwnedRows` |
| `session-ancestry-parity-spec.mjs` | the client surface and the core surface agree on one 3-level tree |
| `sidebar-seam-spec.mjs` | the seam the shell owner implements, measured against the real `filterSessionObjectItems` |
| `session-scope-fixture.mjs` | shared tree fixture (no tests; not matched by the `*-spec.mjs` glob) |

## Two decisions the coordinator made, recorded so they are not re-litigated

**1. `descendantSessionIDs` exists twice on purpose.** `src/shared/session-ancestry.mjs:258`
is the client's unbounded walk over a supplied list; `src/core/agents/session-subtree.mjs:116`
is core's bounded BFS that reports `truncated`. They are not merged because
`src/client/` may not import from `src/core/`. A comment at the shared definition
says so, with both signatures.

**2. Nothing is deleted from `src/core/ownership/`.** `ownership-query.mjs` filters
in the query rather than after loading every row — on the reference DB that is the
difference between an index probe and ~20k frames per sidebar render. It has no
caller yet because no scoped route exists yet; that is a wiring gap, not dead code.
The four anchors above are what closes it.
