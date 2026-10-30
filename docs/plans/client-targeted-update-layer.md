---
title: Client targeted-update layer and migration plan
status: proposed
doc_type: plan
audience: [owner, client-developers, framework-maintainers, qa]
applies_to: development-v3
last_verified: 2026-10-30
canonical: false
keywords: [plan, client, aeor, property store, keyed reconciler, dom reuse, targeted updates]
---

# Client targeted-update layer and migration plan

> **Proposed plan.** The audit evidence is in
> [the client targeted-update audit](../reports/client-targeted-update-audit-2026-10-30.md).
> This plan is not complete implementation history. The framework layer and the
> Kikx shell migration require owner approval before Phase 2 begins.

## Goal

Make the client obey one rule:

> A state change updates only the properties and DOM nodes that depend on it.
> Existing nodes are reused unless the structure genuinely changed.

This is not a React-style render pass. There is no virtual tree, no tree diff,
no deep equality scan, and no background reconciliation loop. The layer consists
of explicit stores, narrow change events, and keyed node updaters.

The intended result:

- A frame whose content did not change is not touched.
- A frame whose text changed updates its text node; its buttons, disclosures,
  listeners, and nested controls stay connected.
- A toolbar status change updates the status leaf, not the thread.
- A runtime frame event updates the keyed frame and nothing else.
- Navigation/auth transitions may replace a shell section, but only that
  section and only with an explicit reason.
- A view-only toggle, including Raw Markdown, changes a class or a property and
  performs zero structural renders.

## Non-goals

- No virtual DOM.
- No full-tree diffing.
- No automatic dependency tracking or proxy magic beyond simple property reads.
- No polling or interval-based “check for changes.”
- No rewrite of the server, frame protocol, or durable data.
- No generic component framework for every future UI.
- No claim that all full rebuilds are forbidden. Authentication, navigation,
  and explicit recovery may require a structural swap.

## Current evidence

See the audit for details. The relevant gaps are:

1. `renderAppShell()` empties `kikx-app` and appends a rebuilt tree.
2. 78 direct app render requests are spread across ordinary state, data, editor,
   agent/team, navigation, and runtime paths.
3. `KikxFrameItem` and `KikxChatView` already contain useful targeted code, but
   some update boundaries still call full component renders or remount the page
   source.
4. AEOR has per-component getters/setters and reactive leaf bindings, but no
   common property-store or keyed reconciliation layer.
5. Tests do not generally assert node identity or a render budget.

## AGIS critical review (post-draft)

The first version of this plan was written before an explicit AGIS pass. That
was a process mistake: the plan described the right direction but did not yet
prove the territory, alternatives, failure behavior, or test adequacy. This
section records the pass that was run afterward and the changes it forced.

### Territory map

Producers and consumers checked in source:

- **Framework producers:** `elements.js` creates bindings; `reactive-state.js`
  batches state; `query.js` moves live nodes; `components/aeor-scrollview.js`
  owns page/item update primitives.
- **Framework consumers:** the framework behavior harness, component sources,
  and every consumer that imports `elements`/`ReactiveState`. A new helper must
  not change existing binding semantics.
- **Kikx producers:** `kikxState`, data loaders, runtime-event queues, navigation
  helpers, and controllers.
- **Kikx consumers:** `renderAppShell`, `KikxChatView`, `KikxFrameItem`,
  `KikxChatScrollView`, `kikx-frame-scroll`, topbar/status builders, editors,
  agent/team views, Inbox, and session grid.
- **Tests:** Kikx mini-DOM specs, framework behavior tests, Puppeteer/Playwright
  browser lanes, and render counters.

The 78 `_render()`/`_requestRender()` call sites are not one class. They include
legitimate structural transitions, data completion, editor panels, and
high-frequency live paths. The plan must migrate by ownership, not by mechanically
rewriting every call.

### Findings that changed the plan

1. **A new store must not duplicate `ReactiveState`.** The initial draft did not
   say whether `PropertyStore` wraps, replaces, or sits beside the existing
   batching primitive. The revised design requires one batching primitive, a
   compatibility facade for existing `bindState` consumers, and no second
   notification system.
2. **Item identity alone is insufficient for a keyed list.** A mutable frame
   object can change in place without changing identity. The revised design
   carries a revision/change hint from the owning store and only skips updates
   when the key and revision are both unchanged.
3. **The shell section boundaries were underspecified.** `renderAppShell` owns
   topbar, runner/auth, status, editors, error surface, and z-order. The plan now
   requires an explicit section registry, a detached-build/swap transaction,
   and a failure path that keeps the old section.
4. **Property writes can clobber user input.** The revised binding contract
   includes a focus/caret/revision guard: an external property update must not
   overwrite a newer focused edit.
5. **Tests were not strong enough.** The plan now defines framework unit tests,
   Kikx identity tests, mutation-ledger tests, browser stress tests, performance
   budgets, and bounded watchdogs before migration starts.
6. **The plan must distinguish a state notification from a render request.**
   Store mutation is the only production notification path. Calling a broad
   render is an explicit structural/recovery action with a recorded reason.

### Alternatives considered and rejected

- **Virtual DOM/deep diff:** rejected by the owner's rule and by cost. It spends
  cycles discovering changes the store already knows.
- **Periodic reconciliation:** rejected; it hides missed events and burns idle
  CPU.
- **One store per DOM node:** rejected; too many listeners and ownership leaks.
  Scoped records owned by a session/collection are the unit.
- **Rebuild the shell but improve snapshots:** rejected as the primary path. It
  still detaches listeners and cannot preserve node identity.
- **Make every component a custom element with its own setter protocol:** too
  broad and would not solve keyed list ownership. The layer must work for plain
  DOM and custom elements.

### Remaining review conditions

- Phase 2 cannot start until the framework-layer tests pass and one pilot proves
  DOM identity across a real browser update.
- Any migration step that changes a user-facing scroll, focus, or draft behavior
  needs a browser regression, not only a mini-DOM test.
- The render-reason ledger must be in place before any broad call site is
  converted, so a regression can identify the new path.

## Architecture

```text
AppStore
  ├─ SessionStore(sessionID)
  │    ├─ FrameStore(frameID) / FrameRecord
  │    ├─ ViewStore(viewID)       (filters, selected window, focus)
  │    └─ DraftStore              (composer/question/expansion controllers)
  ├─ ShellStore                   (auth, navigation, status, editor)
  └─ RuntimeStore                 (connection, event queue, resync state)

Store mutation
  → one narrow change set
  → keyed subscribers
  → property patch / keyed child update
  → existing DOM reused
```

Stores are explicit objects with methods. Components do not mutate arbitrary
`_state` fields. A store owns its values and exposes:

- `get(key)`;
- `set(key, value)` with an equality guard;
- `update(key, updater)` or an explicit domain method such as
  `setFrameContent(frameID, content)`;
- `transaction(fn)` to coalesce related writes;
- `observe(key, listener)` / `observe(keys, listener)`;
- `dispose()`.

### 1. PropertyStore

Create `reactive-property-store.js` in `aeor-web-components` (or extend the
current state module behind a compatibility facade).

Required semantics:

- Values are top-level keys; no nested mutation notifications.
- `Object.is` is the equality check. Equal assignments do nothing.
- A setter emits exactly one narrow change record for the key:
  `{ key, previous, next, revision }`.
- A transaction batches keys and flushes once in a microtask.
- Per-key subscribers receive only their keys. A wildcard observer is opt-in
  for diagnostics; it is not used by production renderers.
- No listener is called for an unchanged value.
- Mutation order is deterministic and a revision counter lets stale async work
  identify itself.
- Disposal removes listeners and descendants. No global registry is required.

Compatibility: keep `ReactiveState` working. `PropertyStore` can be a thin
specialization or a new API layered over the same batching primitive. Do not
break existing `bindState` consumers.

### 1a. Mutation ownership and cardinality

To keep the layer small:

- `AppStore` is the root owner for shell/view preferences and navigation.
- One `SessionStore` exists per loaded session. It owns session metadata, paging,
  a `FrameCollection`, and its view/draft records.
- A `FrameRecord` is owned by exactly one `FrameCollection`; it is not a global
  store and has no app-level wildcard subscription.
- `ViewStore` records are scoped to a session/view and may be disposed with their
  surface.
- Controllers in `src/client/state/` remain the authority for composer,
  question, and expansion user state. The new stores may host their values, but
  must not create a second draft authority.

Only domain methods mutate stores. Direct writes to `_state` from components are
a migration defect. The existing mutation-ledger diagnostics should classify any
remaining direct write during the transition.

### 1b. Change records and revision rules

A store change record contains:

```js
{ key, previous, next, revision, source }
```

- `source` is a short domain label (`frame.content`, `session.status`,
  `runtime.events`), for diagnostics.
- One microtask flush contains at most one entry per key.
- A keyed record's revision increases only when its value or a declared child
  revision changes.
- A keyed list update receives `changed(item, previous, revision)`; it does not
  serialize the item or compare every field.
- A stale async load carries the session/frame epoch it started with and is
  rejected if the owning record has advanced past it.

### 1c. Failure semantics

A targeted update is not allowed to leave a half-written node:

- Build replacement structural sections detached and swap only after the build
  succeeds. On failure, keep the old section and report through the existing
  client error boundary.
- Keyed item updates run inside the existing `guardClientOperation` boundary.
  If an update throws, keep the previous node, report the frame key, and do not
  remove sibling nodes.
- Store transaction listeners must not swallow errors or continue with corrupt
  state; the first failure is rethrown after the remaining cleanup where
  required by the existing teardown contract.


Add a builder/runtime helper for **properties**, not only attributes:

```js
element.bindProperty('value', store, 'value', {
  apply: (node, value) => { node.value = value; },
  cleanup: (node) => {},
});
```

or an equivalent `bindStoreProperty(element, store, key, apply)` function.
It must:

- subscribe to one key;
- apply only when the value changes;
- support custom-element properties and native properties such as
  `textarea.value`;
- retain the existing DOM node;
- expose a cleanup callback for bindings teardown.

The existing `.bindState` remains for attributes and leaf text. This helper
fills the property gap without changing its public contract.

### 3. Keyed reconciler

Create `reconcile.js` with a small, explicit API:

```js
let list = createKeyedList(parent, {
  key: (item) => item.id,
  create: (item) => makeNode(item),
  update: (node, item, previous) => updateNode(node, item, previous),
  remove: (node, item) => node.remove(),
  mount: (node, item, before) => parent.insertBefore(node, before || null),
});

list.update(items);      // create/update/remove only what changed
list.dispose();          // remove nodes and run cleanup
```

Contract:

- `key(item)` is the identity. Duplicate keys are a programming error.
- Existing nodes are reused by key.
- No update call when the key and item reference are unchanged.
- If the owner has a change revision, it may pass a `changed(item, previous)`
  predicate; otherwise item identity is the signal.
- Order changes move the minimum nodes required; unchanged nodes are not
  recreated.
- `create` is called only for new keys.
- `remove` is called only for disappeared keys.
- No deep equality, JSON serialization, or full list scan for updates.
- Focus, selection, open disclosures, and native media/control state belong to
  the node or its controller and survive because the node survives.
- The list does not guess at application state; update callbacks are explicit.

Add a sibling `patchProperties(node, previous, next)` for static property maps
if that proves useful, but do not build a component-level virtual DOM.

### 4. Store hierarchy

The application owns root stores; views receive scoped stores rather than the
whole app object.

- `AppStore`: auth identity, navigation stack, current view/session, status
  connection, debug/raw preferences.
- `SessionStore`: session metadata, frame index/window, paging, previews,
  participant/tag data. One per session; disposed when evicted.
- `FrameStore` / `FrameRecord`: frame payload, status, content revisions,
  expansion intent. One per frame ID; keyed by session.
- `ViewStore`: filter query, page context, selected page, scroll intent, focus
  anchor.
- `DraftStore`: existing composer/question/expansion controllers, scoped and
  durable as already designed.
- `RuntimeStore`: event queue/coalescing, connection state, resync epochs.

Subscriptions are directional: a frame item observes its frame record and the
small view properties it needs. It does not observe the entire app store.

### 5. Update protocol

Every update follows this sequence:

1. **Intent:** a domain method validates the change.
2. **Transaction:** related writes are batched; revisions advance once.
3. **Change set:** only changed keys are emitted, with previous/next values.
4. **Subscriber:** the owning component receives only its key(s).
5. **Patch:** apply the narrow DOM/property change.
6. **Verify:** tests assert untouched nodes by identity and focus/scroll
   preservation where applicable.
7. **Dispose:** only removed nodes are cleaned up.

No renderer is allowed to scan the entire state tree to discover what changed.
No mutation may call `app._render()` as a convenient notification.

### 6. Structural updates

Some changes are structural:

- login/logout;
- opening/closing a session when the shell surface changes;
- switching a plugin main view;
- a shell section appears/disappears (editor, account panel);
- explicit recovery from a corrupt/incomplete view.

Those use a **section registry**:

- each section has a stable key (`topbar`, `runner`, `status`, `editor`,
  `error-surface`);
- a section update may replace its own node while siblings stay mounted;
- the replacement reason is explicit (`auth`, `navigation`, `view`, `recovery`);
- the rest of the shell is not rebuilt;
- a structural update captures/restores focus and scroll only for the section it
  replaces.

The section registry is not a general diff engine. It maps keys to current nodes
and update functions.

## Framework deliverable

Add to `aeor-web-components`:

1. `reactive-property-store.js` — scoped top-level property stores with narrow
   change records and transactions, preserving `ReactiveState` compatibility.
2. `reconcile.js` — keyed child list and property patching helpers.
3. `property-bindings.js` (or equivalent) — property-aware binding helpers.
4. Tests:
   - equal assignment emits no event;
   - one assignment emits one event for the correct key;
   - transaction batches and preserves revision order;
   - keyed list updates preserve untouched nodes;
   - removed nodes are disposed once;
   - reorder moves nodes without rebuilding contents;
   - property binding updates native/custom properties without attribute
     serialization loss;
   - nested stores do not notify unrelated branches.
5. Documentation update in the framework reference and skill.

Do not make the helper a hidden global. It must be importable, inspectable, and
testable in the framework harness.

## Kikx migration

### Phase 0 — Guardrails and evidence

- Add render outcome records: reason, scope, affected frame IDs, and whether the
  update was structural.
- Add identity assertions to existing browser probes:
  - shell node identity across a status/typing/frame update;
  - frame node identity across content updates;
  - composer/question focus and selection;
  - scroll position across view-only toggles.
- Add a failing test for the current `renderAppShell` replacement path.
- No broad source migration yet.

Exit: the team can point to the exact event that rebuilds the shell and the test
that catches it.

### Phase 1 — Framework layer

- Implement the property store, keyed list, and property binding in AEOR.
- Exercise them in a framework testbed page.
- Use them in one low-risk Kikx component as a pilot, preferably the topbar
  status/preview leaves or the session grid.
- No shell rewrite.

Exit: framework tests pass; pilot component keeps DOM identity across updates.

### Phase 2 — Shell sections

- Split `renderAppShell` into stable section builders/controllers:
  `topbar`, `runner/auth`, `status`, `editor`, `error`.
- Mount each once; update properties/sections on state changes.
- Preserve existing snapshot restoration only for structural replacements.
- Add tests that a status change does not detach the thread, topbar search, or
  composer.

Exit: navigation/auth are the only paths that replace a shell section; ordinary
status/data updates do not rebuild the app.

### Phase 3 — Thread and view

- Make `KikxChatView` update frames with the keyed list; remove `_render()` from
  ordinary frame updates.
- Replace `KikxFrameItem`'s `appState`-identity rebuild trigger with narrow
  subscriptions to its frame record and view record. A different app-state
  object must not be treated as a reason to rebuild a frame.
- Keep `KikxFrameItem` identity and narrow content descriptors.
- Make filter/search update the mounted page source in place where possible, or
  replace only the source/page list while preserving the surrounding view and
  scroll anchor.
- Ensure Raw/filter changes never remount the thread.
- Add DOM identity tests for unchanged frames and markdown nodes.

Exit: streaming and filters touch only affected frames; no shell rebuild; no
whole-thread remount for view-only changes.

### Phase 4 — Runtime and data

- Route runtime frame changes into the frame records; update keyed items.
- Remove `_requestRender()` fallbacks from ordinary runtime/data paths.
- Keep explicit recovery resyncs, but make them observable and bounded.
- Migrate data loads and previews to update their keyed sections.

Exit: a runtime replay that only changes frames produces zero shell and zero
thread rebuilds.

### Phase 5 — Editors, agents, teams, Inbox

- Replace editor field `_render()` calls with controller/store updates.
- Migrate agent/team manager rows, status leaves, and Inbox list/card updates to
  keyed lists.
- Keep structural editor open/close replacements explicit.

Exit: typing in any editor or inline control does not detach the focused node.

### Phase 6 — Cleanup and gate

- Remove obsolete snapshot workarounds where node reuse makes them unnecessary.
- Keep a fallback snapshot only for genuine structural swaps.
- Add a CI/browser gate that fails on unexpected full renders and DOM identity
  loss.
- Update architecture/reference docs and the AEOR skill.

Exit: all acceptance criteria below pass, and a forced-streaming browser test
shows no full shell rebuild and no focus/scroll loss.

## Test protocol (TDD)

Tests are written before implementation and are part of the plan, not a
post-hoc checklist.

### Framework layer tests

1. Equal assignment emits zero notifications.
2. One assignment emits exactly one record for the correct key.
3. A transaction coalesces related keys and preserves revision order.
4. Nested stores do not notify unrelated branches.
5. `createKeyedList` creates only new keys and reuses unchanged nodes.
6. Removing a key disposes its node exactly once.
7. Reordering moves nodes without recreating or re-updating unchanged contents.
8. A changed revision updates only the affected item, not the complete list.
9. Property binding updates native/custom-element properties, not attributes,
   and preserves focus/selection when the controller says local input wins.
10. Binding/list disposal removes listeners and does not call callbacks for
    detached owners.

### Kikx identity tests

1. A shell status update keeps the same thread, composer, and topbar nodes.
2. A frame stream update keeps the same DOM node for every untouched frame.
3. A changed frame updates only its content region and preserves sibling items,
   listeners, and disclosures.
4. Raw mode performs zero shell/thread/chat-view rebuilds and preserves
   `scrollTop` and node identity.
5. A filter/search change does not discard the mounted thread or lose the scroll
   anchor while the source is re-scoped.
6. Composer and question-answer focus, value, and caret survive runtime events
   and unrelated frame updates.
7. An agent-only runtime replay produces zero shell/thread rebuilds.
8. A structural auth/navigation change is the only path allowed to replace the
   named shell section.

### Performance and hang discipline

- Unit tests use a 10-second watchdog by default.
- Browser identity tests use a bounded 90-second lane timeout, with per-test
  timeouts and cleanup in `finally`.
- No test may wait on an unmocked network, an unresolved promise, or an
  unbounded event stream.
- Reconciliation of a 1,000-item keyed list must be linear in changed items and
  must not serialize items or scan the full state tree.
- Performance assertions are separate from correctness assertions; a slow
  machine must fail with diagnostics, not hang silently.

### False-confidence risks to guard against

- Mini-DOM identity is not proof of browser focus/scroll/lifecycle behavior.
- A test that only checks values can pass while the DOM was detached.
- A keyed-list test that creates all nodes on every update can hide a missing
  update callback; assert node identity and update counts.
- A store test with a fake listener can miss batching order; assert one flush.
- A passing visual screenshot cannot prove listeners or custom-element state
  survived; use browser node identity and focus checks.


1. **Unchanged content:** an unchanged frame, markdown block, status leaf, and
   grid card keep the same DOM node object across unrelated updates.
2. **Narrow update:** a frame content change updates only that frame’s content
   region; sibling frame nodes and listeners remain.
3. **View-only toggle:** Raw mode changes classes/properties without a shell,
   thread, or chat-view rebuild; scrollTop and focus are unchanged.
4. **Typing:** composer and question-answer inputs retain focus, selection,
   value, and listeners across runtime events.
5. **Runtime:** a replay of frame-only events produces zero shell/thread
   rebuilds and no detach.
6. **Structural changes:** auth/navigation/editor open-close may replace only the
   named section and record a reason.
7. **No diff engine:** no deep-equality traversal, JSON snapshot comparison, or
   whole-state scan on the update path.
8. **Teardown:** removed nodes dispose bindings/listeners exactly once; reused
   nodes are not disposed.
9. **Observability:** debug mode reports render reason, scope, touched IDs, and
   revision; the data does not include secrets.
10. **Fallback:** if a structural render happens while an input is focused or
    dirty, the existing snapshot protocol still preserves user state.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Two state systems drift (`ReactiveState` vs new stores) | Compatibility facade; one batching primitive; no duplicate source of truth |
| Store hierarchy becomes a global singleton | Explicit scoped instances and disposal; no module-global mutable stores |
| Keyed list update callbacks become a mini framework | Keep API small: key/create/update/remove; consumer owns semantics |
| Missing updates because a mutation bypasses a store | Domain methods only; audit direct `_state` writes; debug diagnostics |
| Structural render still needed unexpectedly | Section registry with explicit reason and snapshot fallback |
| Stale async writes win | Revision/epoch on stores and load operations; reject stale |
| DOM reuse leaves stale attributes | `patchProperties` uses previous/next and explicit removal semantics |
| Performance regression from extra store layers | O(1) keyed maps, equality guards, batched flushes; benchmark update paths |
| Migration changes behavior | Phased migration with old tests and new identity tests at each phase |

## Plan readiness check

- **Scope:** bounded to a framework layer plus phased Kikx migration; no
  virtual DOM and no server changes. Pass.
- **Dependencies:** framework layer and pilot precede shell/thread migration.
  Pass.
- **Ownership:** app/session/frame/view store owners and section keys are named.
  Pass.
- **Failure behavior:** detached structural builds, guarded keyed updates, stale
  async rejection, and teardown are specified. Pass.
- **Tests:** framework, identity, streaming, focus/scroll, and performance tests
  are specified before implementation. Pass.
- **Remaining gate:** Phase 2 requires owner approval and a passing framework
  pilot. Open by design.
- **Known uncertainty:** exact section boundaries and page-source re-scope
  mechanics will be confirmed by the Phase 2/3 implementation tests; they are
  not hidden assumptions in Phase 1.

## Stop rules and approval

- This plan does not authorize a full shell rewrite in one step.
- Phase 2 and later require owner approval after the framework layer and pilot
  are reviewed.
- Do not remove snapshot recovery until node reuse is proven under the browser
  stress test.
- Do not use a virtual DOM, deep diff, or periodic full-state scan as a
  shortcut.
- Do not deploy production as part of this campaign without explicit permission.

## Open design decisions

1. Should `PropertyStore` be a new class or a compatibility mode on
   `ReactiveState`? Recommendation: new class with a shared batching primitive,
   keep `ReactiveState` unchanged.
2. Which store owns raw/debug preferences? Recommendation: `AppStore`; they are
   local view preferences, not frame data.
3. Should the first Kikx pilot be the topbar status or the session grid?
   Recommendation: topbar status, because it is small and already uses
   bindings, and it proves the store/binding contract without touching frame
   layout.
4. How long should the framework helper remain Kikx-agnostic? Recommendation:
   permanently; Kikx-specific frame descriptors stay in Kikx.
