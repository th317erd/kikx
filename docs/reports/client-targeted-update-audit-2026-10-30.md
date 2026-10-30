---
title: Client targeted-update audit, 2026-10-30
status: current
doc_type: report
audience: [owner, client-developers, framework-maintainers, qa]
applies_to: development-v3
last_verified: 2026-10-30
canonical: false
keywords: [audit, client, aeor, reactive, reconciliation, full render, dom reuse]
---

# Client targeted-update audit, 2026-10-30

> **Dated audit evidence.** This report records the state of the code on
> 2026-10-30. It does not authorize a rewrite by itself; the correction plan is
> [the client targeted-update layer plan](../plans/client-targeted-update-layer.md).

## Verdict

The owner's model is the correct target, and it is **not what the client is
doing today**.

AEOR provides a useful reactive foundation:

- `elements.js` builds light-DOM trees and supports reactive bindings for text
  and attributes (`bindState`).
- `reactive-state.js` batches top-level assignments and emits keyed change sets.
- `query.js` moves live DOM nodes without serializing them.
- Individual shared components expose getters/setters and observed attributes
  (`aeor-input.value`, `aeor-select.setOptions`, `aeor-disclosure.open`,
  `aeor-scrollview.appendItem`/`updatePage`, and others).

It does **not** provide the general layer the owner described: there is no
generic property/data store hierarchy, no keyed child/list reconciler, and no
renderer/scheduler that keeps an existing tree and applies narrow updates.
`docs/overview.md` explicitly says AEOR is not a virtual DOM or renderer
scheduler. That is a real framework gap, not a Kikx misuse of an existing
helper.

Kikx has some correct targeted paths, but the shell and many application
workflows still use broad replacement. The raw-mode flash was one visible
consequence of the larger design gap.

## Scope and method

Audited commits: Kikx `ff53a40b`; AEOR source `9d5b563`. The AEOR checkout has
unrelated worktree documentation changes, which were not treated as audited
runtime behavior.

Reviewed:

- AEOR `elements.js`, `reactive-state.js`, `query.js`, component sources,
  scrollview source, current reference/architecture docs, and behavior tests.
- Kikx app shell, shell builders, chat view, frame item, chat scrollview, frame
  scrolling, runtime-event handling, navigation, data/load layer, editor and
  agent/team controllers, session grid, and current client tests.
- Current render instrumentation in `src/client/components/render-stats.mjs`.

Measurements from the audited tree:

- 78 direct `app._render()` / `app._requestRender()` call sites across eight
  component files.
- 33 component-local `this._render()` call sites; some are legitimate local
  rebuilds, some rebuild a frame subtree that could be patched.
- `kikx-app` is 671 lines; `kikx-shell-builders` is 676; `kikx-frame-item` is
  794; `kikx-frame-scroll` is 912; `kikx-chat-view` is 600.
- `elements.js` is 625 lines and `reactive-state.js` is 156 lines.

These are scale signals, not a claim that every call site is wrong. A
navigation or authentication transition may legitimately build a new shell.
The audit separates structural transitions from live updates below.

## What already works

These pieces should be retained and generalized, not thrown away:

1. **Stable frame identities and in-place frame reconciliation.** 
   `KikxFrameItem.updateFrame()` (`src/client/components/kikx-frame-item.mjs:195`)
   skips work when the frame object and app-state identity are unchanged, and
   `_reconcile()` (`:447`) updates metadata, compact summaries, content, and
   nested custom controls without replacing the whole frame.
2. **Keyed lazy thread pages.** `KikxChatScrollView` and
   `aeor-scrollview` already use stable page/item keys, `appendItem`, and
   `updatePage`; the shared scrollview is a real node-reuse primitive.
3. **Targeted runtime frame flush.** `kikx-runtime-events.mjs` batches frame
   events and calls `syncFrameThread` rather than rebuilding the shell for every
   commit; informational events are coalesced.
4. **Explicit user-state controllers.** Composer drafts, question drafts, and
   expansion have recovery stores. They are the right direction for state, but
   they currently compensate for DOM replacement rather than preventing it.
5. **Paint-only Raw mode.** Raw mode is now a class toggle plus CSS
   `::before`/`::after`; it does not invoke the shell renderer. This is a small
   proof that view-only changes can be made without a rebuild.

## Findings

### F1 — The framework lacks a targeted-update layer (critical)

AEOR's reactive binding applies one value to one element target:

- element text or attributes through `applyBoundValueForBinding`;
- per-key listeners through `ReactiveState`;
- static object state; nested mutation does not notify;
- no list identity, child ownership, update transaction, or subtree lifecycle.

`docs/reference/core-api.md` documents bindings and top-level state but no
keyed list or component patch API. The scrollview's `appendItem`/`updatePage`
are a component-specific exception, not a reusable layer.

Consequence: consumers either hand-roll reconciliation (as parts of Kikx do) or
fall back to rebuilding a subtree (as the app shell does).

### F2 — `renderAppShell()` is a full replacement (critical)

`src/client/components/kikx-shell-builders.mjs:55` builds every shell section,
then at `:106-110`:

1. disconnects the frame-list observer,
2. cleans reactive bindings,
3. empties `kikx-app`,
4. appends a newly built tree.

`KikxApp._render()` is a thin call to this function
(`src/client/components/kikx-app.mjs:647`). Every caller that treats `_render()`
as a generic repaint therefore detaches the entire application tree. Focus,
selection, listeners, custom-element lifecycle, and scroll geometry all have to
be repaired afterward.

The existing `UserWorkSnapshot` restoration is evidence of the cost: it captures
composer value/selection, expansion, and scroll focus specifically because the
tree is about to be destroyed. It is a recovery mechanism, not a targeted
update.

### F3 — Full renders are used for ordinary state and data updates (high)

There are 78 `app._render()` / `app._requestRender()` call sites. The largest
concentrations are:

| Area | File | Calls | Why it matters |
| --- | --- | ---: | --- |
| Editors/forms | `kikx-editors.mjs` | 26 | field edits rebuild the shell and detach controls |
| Data/loading | `kikx-data.mjs` | 19 | network completion rebuilds views |
| Agent/team controller | `kikx-agent-controller.mjs` | 14 | toggles/status rebuild the manager shell |
| Navigation | `kikx-navigation.mjs` | 12 | some are structural, some are ordinary panel changes |
| Runtime events | `kikx-runtime-events.mjs` | 3 | fallback/resync paths still request a broad repaint |
| Composer | `kikx-composer.mjs` | 2 | sends/history paths rebuild instead of patching |

Not every site is a defect: login/logout, opening a session, changing shell
mode, and explicit recovery are structural. The problem is that the same
`_render()` entry point is used for both structural transitions and ordinary
property changes, so callers cannot express intent and the renderer cannot
choose a narrow path.

### F4 — The thread is partly targeted but still has replacement boundaries (high)

`KikxChatView.syncFrames()` (`kikx-chat-view.mjs:155`) updates keyed scrollview
items and `KikxFrameItem.updateFrame()` reconciles frame content. That is the
correct model.

However:

- `KikxChatView.update()` (`:108`) ends in `_render()` for full mode; it is a
  whole chat-view rebuild.
- `setFrames()` (`:125`) chooses `_renderFullShared()` or `_render()`, not an
  in-place list update.
- `_renderFullShared()` calls `_scrollview.mount()` whenever the page-context
  key changes; mounting clears the host.
- Filter/search changes include the filter payload and query in the page
  context key, so a query or filter change re-scopes by remounting the source.
- `KikxFrameItem` treats a new `appState` object identity as a reason for a full
  frame render (`kikx-frame-item.mjs:200,217`), although app state is normally a
  stable object.

The result is a hybrid: streaming frames are efficient, but filter/search and
some app actions still discard the thread DOM.

### F5 — Per-component dynamic properties exist, but there is no common data layer (high)

Shared controls do implement narrow properties and attributes:

- `aeor-input.value` getter/setter;
- `aeor-checkbox.checked/disabled/value`;
- `aeor-select.value/values/options` and `setOptions`;
- `aeor-disclosure.open/summary`;
- `aeor-scrollview.appendItem/updatePage`;
- `aeor-confirm-button.progress`, `aeor-progress-button.progress`, etc.

What is missing is the layer above them:

- no common store/property base;
- no standard update event with path, previous value, next value, and revision;
- no scoped app/session/frame/view store hierarchy;
- no binding from store property to custom-element **property** (the builder's
  `.value.bindState(...)` applies an attribute, not necessarily a live property);
- no keyed list or child-update contract.

The owner's instinct is right: these are mostly simple getters/setters and
events. The missing work is the consistent layer and its integration, not exotic
diffing.

### F6 — Runtime-event protection is partial (medium/high)

The runtime path already avoids rebuilding for ordinary `frame.added` and
`frame.updated` events and coalesces informational events. But it still has
`_requestRender()` fallbacks for session/queue/overflow/unknown conditions, and
the frame path ultimately calls `syncFrameThread`, which can reach a chat-view
or page-source replacement when the view is structurally stale.

The correct invariant is not "runtime events never call `_render()`"; it is
"runtime events mutate only the affected keyed properties and views, and any
broad resync is an explicit, observable recovery operation."

### F7 — Tests do not enforce DOM identity (critical process gap)

The suite verifies many values, classes, ARIA states, and scroll behavior, but
there is no general acceptance gate of the form:

- unchanged frame keeps the same DOM node;
- unchanged markdown keeps the same child nodes;
- unchanged composer/list keeps focus and selection;
- a view-only toggle causes zero `shell`/`thread`/`chatView` rebuild counts;
- an update touches only the expected frame IDs.

`render-stats.mjs` counts rebuilds but does not record **why** a rebuild happened
or **how many** subtrees were touched. Without identity assertions, a broad
rebuild can pass every visual test and remain invisible until the owner notices
a flash or lost caret.

### F8 — The shell's composition boundaries are not controller boundaries (medium)

Topbar, runner shell, status bar, editors, error surface, and work-area view are
built together in one function. There is no stable section registry that says
"this section owns this state and can be updated without touching its
siblings." That makes a targeted migration harder than it needs to be and
encourages callers to use the only available entry point: `_render()`.

### F9 — Snapshot restoration is compensating for detach (medium)

The current snapshot path can restore focus, caret, composer text, expansion,
and scroll after a full rebuild. That is valuable for resilience, but it is not
a substitute for preserving the original nodes:

- a restored focus is not the same focus event;
- custom-element lifecycle still ran disconnect/reconnect;
- listeners are cleaned and reattached;
- selection can be lost between detach and restore;
- asynchronous measurement and scroll work is duplicated.

Snapshots should remain a fallback for genuine structural changes, not the
normal path for a property update.

## Gap matrix

| Capability | AEOR today | Kikx today | Required |
| --- | --- | --- | --- |
| Top-level reactive state | Yes, `ReactiveState` | Used | Keep, add scoped stores |
| Keyed child/list reconciler | No general helper | Hand-rolled in chat/scrollview/grid | Framework helper |
| Property-level custom-element updates | Per-component getters/setters | Partial | Shared property binding/update contract |
| Scoped app/session/frame stores | No | Flat `kikxState` plus controllers | Store hierarchy |
| Explicit update transaction | Keyed state flush only | Ad hoc calls | Narrow change-set transaction |
| DOM reuse on view-only changes | Not enforced | Partial; raw fixed | Always reuse unless structure changes |
| Focus/selection preservation | Bindings plus snapshots | Snapshot recovery | Node reuse first; snapshot only for structural changes |
| List identity/reordering | Scrollview-specific | Manual maps | Reusable keyed list |
| Render reason/observability | Rebuild counters | Counters only | Reason + affected IDs + breadth |
| Runtime narrow updates | Events coalesced | Frame path partly | No broad render on live events |
| Tests for identity | Not general | Per-feature | Framework and app gates |

## What this means

This is an architectural correction campaign, not a patch to raw mode. The
correct sequence is:

1. Build a small property/store/reconciliation layer in AEOR.
2. Prove it in a framework testbed and one Kikx section.
3. Migrate shell sections, then thread/frame/view paths, then editors/runtime.
4. Add identity and render-budget gates before broadening the migration.

The detailed design, phases, tests, and stop conditions are in
[the client targeted-update layer plan](../plans/client-targeted-update-layer.md).

## Limitations of this audit

- This is a source and test audit, not a full performance profile of every
  interaction.
- Some `_render()` calls are legitimate structural transitions; the report
  classifies risk, not guilt.
- The AEOR scrollview is still described as in-flight in its own catalog; its
  update primitives are useful but not yet a stable general framework contract.
- The audit does not claim that all 78 call sites are active in normal use. It
  claims that the API shape cannot express the owner's invariant and that the
  high-frequency paths have already demonstrated the failure mode.
