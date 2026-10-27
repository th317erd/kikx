# Sidebar scope seam — contract for the shell owner

Written by the ownership prong (Kikx-Ownership-Eng) for the shell owner
(Prong A) to implement. This prong does not edit shell files.

## What to import

```js
// src/client/components/kikx-shell-builders.mjs, in the existing import block
import { filterItemsInScope } from '../state/session-scope.mjs';
```

`../state/session-scope.mjs` is served byte-identical by the dev server
(`GET /client/state/session-scope.mjs` → 200). It has no imports of its own, so
it adds nothing to the module graph beyond itself.

## The one call

```js
filterItemsInScope(viewerSessionID, items, sessions) -> items[]
```

| # | argument | type | what to pass |
|---|---|---|---|
| 1 | `viewerSessionID` | `string` | the session whose sidebar is being built — `entry.sessionID` |
| 2 | `items` | `Array<object>` | the sidebar entry array, in the order you want rendered |
| 3 | `sessions` | `Array<object>` | the session list — `getVisibleSessions()` from `src/client/state/kikx-state.mjs:357` |

Returns a **new array**, a subset of `items`, **caller's order preserved**. It
filters; it never sorts, never mutates, never adds fields.

## What each row must carry

The filter reads the owning session from the row. Any **one** of these fields:

- `sessionID` (preferred — matches what session records already use)
- `sessionId`
- `ownerSessionID`
- `ownerSessionId`

A row with **none** of them is **dropped**. That is deliberate: an unscoped row
is not granted by default. If a global row must survive (see "Exception" below)
it has to say so explicitly.

## No DOM requirement

The filter runs before rendering, so a hidden row is a row you never build.
No class, no `data-` attribute, no CSS, nothing in `app.css`. Build the filtered
array, then map it to nodes as you already do.

## Where it goes

`buildRunnerShell` (`src/client/components/kikx-shell-builders.mjs:255`) builds
`section.class('kikx-sessions')` containing `h2('Workspace')`,
`buildInboxSidebarEntry(app)` and `buildActivitiesSidebarEntry(app)`.

Insert after the entry array exists and before it is rendered. Today there is no
array — there are two direct calls (`:269`, `:272`) — so the filter lands when
the data-driven entries land:

```js
let entries = [ /* inbox, activities, agents, teams, ... */ ];
let inScope = filterItemsInScope(entry.sessionID, entries, getVisibleSessions());
```

Do **not** insert it before the array exists; there is nothing to filter and a
wrapper around two hardcoded calls would have to be undone.

## The test that proves it is wired

Assert the **count of rendered entries**, not that a function was called:

```js
// sessions: root -> {leafA, leafB}; an agent owned by leafB
let sidebar = buildRunnerSidebarEntries(app_for_leafA);
assert.equal(sidebar.length, expectedInScopeFor(leafA));
assert.equal(sidebar.some((e) => e.sessionID === 'leafB'), false);
```

A test that only checks `filterItemsInScope` was invoked passes even if its
result is thrown away. Assert on the count and on the absence of the sibling.

## Exception the owner has not granted

`kikx-shell-builders.mjs:266-271` comments describe the Inbox as *"the one thing
that must be visible from anywhere, above the project tree"* (§6.1) and
Activities as sitting "one level out" (§6.4). That is the **upward** direction
the owner's requirement forbids:

> "wouldn't be usable in sessions above the level in which they are created"

Two readings are possible and the choice is the owner's, not this prong's:

1. **Inbox and Activities are subtree-scoped** like everything else. The §6.1 /
   §6.4 comments predate the requirement. Then they are ordinary rows with a
   `sessionID` and the filter handles them with no special case.
2. **Inbox and Activities are a deliberate global exception** (they are
   cross-session views by nature). Then they must be marked explicitly and
   exempted from the filter by name — not left in the array to be silently
   dropped, which is what will happen if they carry no `sessionID`.

Until that is decided, passing them through the filter unmarked will hide both.
That is the fail-closed behaviour, and it is a visible regression rather than a
silent leak — but it is a decision, not an accident.
