# Sidebar scope seam — contract for the shell owner

Written by the ownership prong (Kikx-Ownership-Eng) for the shell owner
(Prong A) to implement. This prong does not edit shell files.

## CORRECTION (supersedes every earlier version of this file)

An earlier revision told you to call
`filterItemsInScope(viewerSessionID, items, sessions)` and to import it into
`kikx-shell-builders.mjs`. **Both halves of that were wrong**, measured at HEAD
`d402558`:

1. `filterItemsInScope` has signature `(viewerSessionID, items, sessions)`
   (`src/client/state/session-scope.mjs:163`) — it takes the viewer, not a
   per-item filter. It does not satisfy the seam Prong A actually built.
2. The seam Prong A built is a **callback**, not an array filter:
   `buildSidebarSessionObjects(app, { scopeFilter })`
   (`kikx-sidebar-session-objects.mjs:108`) and
   `filterSessionObjectItems(items, scopeFilter, appState)` (`:83`),
   which calls `scopeFilter(item, item.scopeSessionID, appState)`.
3. The call site is `kikx-shell-builders.mjs:260`
   (`buildSidebarSessionObjects(app),` — one argument, so `scopeFilter`
   defaults to `null` and today nothing is filtered).

So the shell does not need an import of `filterItemsInScope` at all. It needs
**one function passed as the second argument**. That keeps the diff to a single
line in Prong A's file and needs no new import if the filter is defined there —
but the filter must be the shared predicate, not a second implementation.

## What to import

```js
// src/client/components/kikx-shell-builders.mjs, in the existing import block
import { isSessionVisibleTo } from '../state/session-scope.mjs';
```



```js
// src/client/components/kikx-shell-builders.mjs, in the existing import block
import { filterItemsInScope } from '../state/session-scope.mjs';
```

`../state/session-scope.mjs` is served byte-identical by the dev server
(`GET /client/state/session-scope.mjs` → 200). It has no imports of its own, so
it adds nothing to the module graph beyond itself.

## The one call

```js
buildSidebarSessionObjects(app, { scopeFilter });   // see "The predicate" below
```

`scopeFilter` has the signature the seam already calls:
`(item, scopeSessionID, appState) -> boolean`. The exact body is given and
measured further down; do not use the one-line version I sent earlier, it is
wrong at the project root.

| arg | what it holds at the seam |
|---|---|
| `item` | the descriptor being considered (`{ id, kind, label, scopeSessionID, onSelect }`) |
| `scopeSessionID` | the owner session id, or **`null`** for the one global item |
| `appState` | `app?._state` — use it to resolve the viewer |

### MEASURED DEFECT in my own earlier advice — `scopeSessionID === null` is ambiguous

I previously told this lane to grant when `scopeSessionID === null` and to call
that "the account carve-out". Running the real builder proves that is wrong:

```
viewer=G    built=5 filtered=5  scopeIDs=account-chip:null,account:G,agents:G,teams:G,sign-out:G
viewer=null built=5 filtered=5  scopeIDs=account-chip:null,account:null,agents:null,teams:null,sign-out:null
```

When `navigationStack` is empty (the project-root view), **every** row gets
`scopeSessionID: null` (`kikx-sidebar-session-objects.mjs:34-37`), which is
indistinguishable from the account carve-out at that seam. A filter that grants
on `null` therefore grants all five items at root via the carve-out branch, not
just the account. The branch is still net-correct at root — every item there
*would* be owned at the root level — but the comment above it would be a lie,
and the same clause would silently grant an unscoped row anywhere else.

### The predicate that is actually correct — three branches, verified

My two earlier attempts were both wrong in opposite directions, so here is the
one I ran against the real builder:

```js
// Verified at HEAD d402558 against the real buildSessionObjectItems output.
scopeFilter: (item, scopeSessionID, appState) => {
  // 1. The one global item. Identified by IDENTITY, because scopeSessionID
  //    === null also means "root view" (see 2).
  if (item?.id === 'account-chip') return true;

  // 2. Root view: navigationStack is empty, so there is no viewer id and every
  //    item is owned at this level. Fails closed would hide the whole cluster.
  let viewer = appState?.navigationStack?.at(-1)?.sessionID ?? null;
  if (viewer == null) return true;

  // 3. Everything else: the owner must be the viewer or an ancestor of it.
  return isSessionVisibleTo(viewer, scopeSessionID, sessions);
}
```

Measured output (`node`, real module, harness below):

```
viewer=G    count=5 ids=account-chip,account,agents,teams,sign-out
viewer=C    count=5 ids=account-chip,account,agents,teams,sign-out
viewer=P    count=5 ids=account-chip,account,agents,teams,sign-out
viewer=null count=5 ids=account-chip,account,agents,teams,sign-out
sibling row (S) for G     -> 0   (correct: denied)
own row (G) for G         -> 1
ancestor row (P) for G    -> 1
descendant row (G) for C  -> 0   (correct: a parent cannot use a child's item)
account-chip for G        -> 1
no-op control (always true) on the sibling row -> 1   <- proves the test discriminates
```

**Branch 2 must grant, and identity-only is not enough.** I first wrote a
two-branch version (`account-chip` by id, else defer to the predicate). Measured
at the project root it yields `count=1` — it hides Account, Agents, Teams and
Sign out, because at root every row's `scopeSessionID` is `null` and the
visibility predicate fails closed on a null viewer. That is a visible regression
in the most common view in the app.

**Branch 1 must be identity, and `scopeSessionID === null` is not enough.** The
version I recommended before this correction granted every `null` row as
"the account carve-out"; at root that happens to be net-correct, but the branch
would then be a blanket grant for any unscoped row anywhere. Identity keeps the
owner's "except the user account" true and nothing more.

## Honest limitation — read this before you claim the sidebar is scoped

At HEAD `d402558` **every sidebar row is scoped to the session currently being
viewed** (`kikx-sidebar-session-objects.mjs:34-37` reads
`navigationStack.at(-1).sessionID`). So for every scoped row,
`scopeSessionID === viewer`, and the predicate returns `true`.

Wiring this seam correctly therefore **changes nothing visible today**. It makes
the sidebar *able* to be scoped and makes the account carve-out explicit. It is
not the thing that hides a sibling's agent from you. Real enforcement needs two
changes outside this seam:

- owner-scoped items carrying the owner's session id rather than the viewer's
  (the agent/team/inbox lists, not this five-item cluster), and
- the server-side filter in `src/core/ownership/`, which has no caller yet.

State it that way in the commit message if you land this. A commit claiming
"session ownership now enforced in the sidebar" would be false, and the test
below would still pass.

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

**Importing the component directly does not work.** Measured:
`import('.../kikx-sidebar-session-objects.mjs')` fails with
`ERR_MODULE_NOT_FOUND: /vendor/aeor-web-components/elements.js` (via
`src/client/lib/aeor-ui.mjs`) — `aeor-ui.mjs` is written for the browser, where
`/vendor/` is a served absolute path. Use the existing harness the other client
specs use (`spec/client/inbox-view-rebuild-spec.mjs:41-44`):

```js
import { register } from 'node:module';
import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);
const { document } = installDom();
const { buildSessionObjectItems, filterSessionObjectItems } =
  await import('../../src/client/components/kikx-sidebar-session-objects.mjs');
const { isSessionVisibleTo } = await import('../../src/client/state/session-scope.mjs');
```

Then assert the cases that actually distinguish a correct filter from a no-op.
The measured behaviour above shows a `count === 5` assertion on the cluster
**cannot** detect a broken predicate — it is 5 for every viewer including a
no-op filter. These can:

```js
// P -> {C, S}; C -> {G}
const sessions = [
  { id: 'P', parentSessionID: null },
  { id: 'C', parentSessionID: 'P' },
  { id: 'G', parentSessionID: 'C' },
  { id: 'S', parentSessionID: 'P' },
];

const row = (sessionID) => [{ id: 'x', scopeSessionID: sessionID }];
const pred = (viewer) => (item, scopeSessionID) => {
  if (item?.id === 'account-chip') return true;
  if (viewer == null) return true;
  return isSessionVisibleTo(viewer, scopeSessionID, sessions);
};
const survives = (viewer, sessionID) =>
  filterSessionObjectItems(row(sessionID), pred(viewer), {}).length;

// Denials — these are the security boundary (all measured 0)
assert.equal(survives('G', 'S'), 0);   // sibling
assert.equal(survives('C', 'G'), 0);   // descendant: parent may not use a child's item

// Grants — these are the owner's "trickle down" (all measured 1)
assert.equal(survives('G', 'G'), 1);   // self
assert.equal(survives('G', 'C'), 1);   // parent
assert.equal(survives('G', 'P'), 1);   // grandparent

// The carve-out is the account only, at every viewer including root.
const root = { _state: { navigationStack: [], account: { name: 'w' } } };
const rootItems = filterSessionObjectItems(buildSessionObjectItems(root), pred(null), root._state);
assert.equal(rootItems.length, 5);                                 // measured 5
assert.equal(rootItems[0].id, 'account-chip');

// Control: a constant-true filter must FAIL the denial assertions above.
assert.equal(filterSessionObjectItems(row('S'), () => true, {}).length, 1);
```

A test that only checks the filter was invoked, or only checks the cluster's
count, passes even if the result is discarded or the predicate constantly
returns `true`. Both were true of a `count === 5` test on this cluster.

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
