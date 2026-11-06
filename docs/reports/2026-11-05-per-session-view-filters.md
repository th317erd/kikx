---
title: Per-session view filters, persisted in localStorage
status: current
doc_type: report
audience: [maintainers, developers]
applies_to: development-v3
last_verified: 2026-11-05
keywords: [view filters, frame filters, per-session, localStorage, first paint]
---

# Per-session view filters, persisted in localStorage

**Date:** 2026-11-05
**Checkout:** `kikx2` @ `98edc777` (fast-forwarded from `61fd81fe` before starting, as instructed)
**Serving instance:** `127.0.0.1:3001`, pid 34034, cwd `/home/wyatt/Projects/kikx-workspace/kikx2`

## The reported bug

With the eyeball (frame-filter) popup Ctrl+Clicked to **Child Sessions**, entering
one of those child sessions showed an **empty thread**.

The diagnosis in the report was correct and I confirmed the mechanism in source:
`frameFilters` was a single global field on `ReactiveState`
(`src/client/state/kikx-state.mjs:121`) with **21 read sites** across the client.
Nothing tied it to a session. So the "Child Sessions" isolation the user applied
while looking at the parent was still in force inside the child — and a child
session, by definition, contains none. The filter matched nothing, the server
returned nothing, and the thread rendered empty.

A view filter describes how **one** session is being looked at. It has to travel
with that session.

## The fix

### New module: `src/client/state/session-view-filters.mjs` (210 lines)

The scope layer, keyed by session id:

| Export | Purpose |
|---|---|
| `SESSION_VIEW_SCOPE_PREFIX` | `'kikx.viewScope.'` — namespaced storage key |
| `GRID_VIEW_SCOPE` | `'grid'` — the empty-session scope, so it cannot collide with a real id |
| `viewScopeKey(sessionID)` | Maps `''` → `'grid'`, everything else to itself |
| `defaultViewScope()` | Fresh `{ filters, query }` per call, every category on |
| `normalizeViewScope(scope)` | Repairs anything from storage or off the wire |
| `readSessionViewScope` / `writeSessionViewScope` | Storage I/O, failure-tolerant |
| `captureSessionViewScope(state, id)` | Save the live state under the leaving session |
| `applySessionViewScope(state, id)` | Load that session's scope into live state |
| `persistAppViewScope` / `…Soon` | Persist current selection; the `Soon` variant debounces the query |

**The grid has its own scope** (`'grid'`). The header search box filters session
*titles* on the grid and becomes a *frame query* inside a session. Those are
different jobs over different data, so sharing a slot would let a frame query
silently overwrite the title filter.

### Wiring

`syncViewScopeForSelection(app, previousSessionID)` in
`src/client/components/kikx-navigation.mjs` is the single chokepoint. It:

1. captures the **outgoing** session's scope while its state is still live,
2. applies the **incoming** session's scope,
3. clears `app._frameLoadSignature` — see below,
4. repaints the header search field and the popup.

It is called synchronously from every selection transition:

| Call site | Trigger |
|---|---|
| `openSessionFromCard` | clicking a session card |
| `syncSelectedSessionToStack` | stack navigation (enter / minimize / depth) |
| `applySessionDeepLink` | `?session=<id>` on first load |
| `syncFromURL` | browser back / forward |
| `selectSession` (`kikx-editors.mjs`) | programmatic selection |

Persistence hooks: `setFrameFilters` (popup rows, clear button — deliberate,
immediate) and `applyWindowQuery` (typing — debounced 250 ms).

The `deleted` gate is per-session too, so `syncViewScopeForSelection` also
re-derives `showDeletedSessions` from the incoming scope; otherwise the grid's
soft-deleted bucket and the thread would disagree about what "hidden" means.

## Two design constraints that forced this shape

**1. `ReactiveState` forbids a getter/setter.** The vendor class returns a
`Proxy`, and its `get` trap is:

```js
return values[property];
```

A prototype accessor is shadowed by that trap, so `frameFilters` had to stay a
real data key holding the *effective* value for the selected session. That is why
all 21 existing read sites work untouched — only the *value* changes at
transitions. `toJSON()` is also shallow, which the keyed-map approach respects.

**2. A microtask subscription would not have fixed the bug.** Filtering is a
transport concern: `loadFrames` reads `state.frameFilters` **when it builds the
request** (`src/client/components/kikx-data.mjs:351`). `ReactiveState` batches
listeners into one microtask, which is *after* the navigation code that
immediately `await`s `_loadFrames`. A subscription would therefore have sent the
request carrying the **previous** session's filter — reproducing the exact bug by
another route. Hence a synchronous call at the transition.

**Also cleared: `_frameLoadSignature`.** This field caches "which filter+query
produced the frames on screen" and suppresses redundant refetches. Retained across
a session change it would suppress the first load of the session just entered —
the same empty view via a different mechanism.

## Evidence

### Unit and wiring specs

| Spec | Result |
|---|---|
`spec/client/session-view-filters-spec.mjs` | **13/13 pass**
`spec/client/session-view-filters-wiring-spec.mjs` | **8/8 pass**

### Negative control (the important one)

With `syncViewScopeForSelection` short-circuited to a no-op — i.e. the pre-fix
behaviour — the wiring spec fails **6 of 8**:

```
✖ the reported bug: leaving an isolated parent opens the child unfiltered
✖ the parent keeps its isolation in storage after being left
✖ returning to the parent restores its isolation from storage
✖ the signature guard is cleared, so the destination is not suppressed
✖ the popup is repainted so its checkboxes match the new session
✖ the stored payload is namespaced
✔ entering the same session twice is stable   (correctly independent)
✔ an app with no state does not throw          (correctly independent)
```

File restored afterwards; `md5sum` matched the pre-control backup
(`fc50ba767a6a6b868f6d9eb0a51ba51a`). The two survivors are the two assertions
that do not depend on the fix, which is what a healthy control looks like.

### Regression suite

| Lane | Result |
|---|---|
`spec/client/*-spec.mjs` | **1239 pass, 0 fail** |
`run-test-lanes.mjs unit` | **3320 executed, 0 fail, 30 skipped** |

### Reachability over the live server

Not inferred — fetched from the process that actually serves 3001:

```
GET /client/state/session-view-filters.mjs      -> 200, 6329 bytes
GET /client/components/kikx-navigation.mjs      -> 200, 25964 bytes
served nav imports session-view-filters.mjs      -> line 28
served nav calls syncViewScopeForSelection       -> 5 occurrences
served vs on-disk md5                            -> identical (fc50ba76…)
```

(`/src/client/...` returns 404 — the static root maps to `/client/...`. Recorded
because it cost a wrong first guess.)

### Browser (real Chrome, Puppeteer)

`spec/ui/puppeteer/session-view-filters-puppeteer.mjs` — **1/1 pass**

It drives the owner's own gesture: open the parent, Ctrl+Click the "Child
Sessions" row's **label**, click into the child, then assert the child's thread is
not empty and its categories are all on. It then isolates the child to Tools,
reloads, and confirms the child's scope came back — and finally returns to the
parent and confirms the parent's Child Sessions isolation is intact and did **not**
inherit the child's Tools isolation.

**Negative control, in the browser.** With `syncViewScopeForSelection` short-
circuited, the same spec fails with exactly the reported symptom:

```
AssertionError: the child opens with EVERY category on,
                not the parent's Child Sessions isolation
```

Restored afterwards; `md5sum` matched the backup (`59180a1d…`). So the browser
test is bound to the fix rather than passing incidentally.

Three defects in the spec itself were found and fixed while getting there — each
would have produced a false result in a different direction, so they are recorded:

1. `waitForCondition` called `page.evaluate(predicate)` with no argument, so a
   predicate written as `(childID) => ...` compared against `undefined` and could
   never pass. It now forwards an argument.
2. The popup has a pinned master row `data-filter-key="all"` beside the category
   rows; the comparison counted it as a category.
3. `evaluateOnNewDocument` re-runs on **every** navigation, so its
   `localStorage.clear()` wiped the scope the reload was meant to restore — a
   correct implementation looked broken. It now clears once, seeded via
   `sessionStorage`.

## Deliberate non-goals

- **The grid's title search is not frame-scoped.** `sessionSearch` holds both, per
  mode. Splitting it into two fields would be cleaner but touches `getVisibleSessions`,
  `applyWindowQuery`, the shell builders and the topbar; out of scope for this fix.
- **`kikx-navigation.mjs` was already 554 lines at base** (over the 500 soft
  limit) and is now 623. I moved the persist helpers into the state module to
  avoid growing it further; a real split of that file is separate work, not
  something to attempt in the middle of a bug fix.
- **No server-side change.** Filtering was already per-request; the server was
  never the problem.

## Caveats / unverified

- The `Soon` debounce means a reload within 250 ms of the last keystroke can lose
  the final characters of a query. Same trade the frame query already makes.
- `localStorage` is written synchronously; the query path is debounced, the click
  path is not. On a very large session a rapid series of popup clicks therefore
  costs one small write each.
- Private-mode `localStorage` that throws is handled and tested (degrades to
  in-memory), but not exercised against a real private-mode browser.

## Provenance note (added after the fact)

This report was written against the `kikx2` checkout and describes that
investigation; the date, checkout, and serving-instance lines below are the
original ones and are left unedited. The code landed here as a cherry-pick, so
the `kikx2` checkout header describes where the work was done, not where it now
lives.

## Correction: an earlier "green" run of the first-paint spec proved nothing

`spec/ui/puppeteer/view-scope-first-paint-puppeteer.mjs` was previously reported
green. It was not measuring what it claimed. Its MutationObserver callback
iterated `for (let record of records)`, which shadowed a helper also named
`record`; the call `record(node)` therefore invoked a MutationRecord and threw.
The throw aborted the scan on the first record of every callback, so the
assertions of the form "the excluded frame was never inserted" passed without
being evaluated at all.

Measured with the shadowing reintroduced: the predicate throws 143 times while
the filter popup is really inserted at ~158ms with `is-all-on` honest (`false`).

The spec now renames the helper, counts observer health, and fails on it:

- `observerRecords > 0` — a dead observer recorded nothing;
- `observerRecordErrors === 0` — the predicate threw;
- `frameItemsSeen > 0` — it never saw a frame inserted, so it cannot speak to
  absence.

Negative control: reintroduce the shadowing and the lane fails with
"the observer predicate threw 143 time(s); a throw aborts the scan and lets the
absence assertions pass vacuously". Restored, it passes.

The absence of an authority banner in this report also left
`spec/architecture/documentation-spec.mjs` red from the squashed filter commit
onward, unnoticed because the lane output was read from its tail. Both are fixed
in the commit that adds this note.
