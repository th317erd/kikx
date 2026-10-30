---
title: Client user-state integrity campaign
status: active
doc_type: plan
audience: [developers, maintainers, owner]
applies_to: development-v3
last_verified: 2026-10-30
---

# Client user-state integrity campaign

## Purpose

This campaign exists to make it impossible for a render, runtime event, stale
request, or component rebuild to destroy work the user has typed or a surface the
user has opened.

The triggering incident: the owner was typing an answer while an end-turn
message containing questions was expanded. The typed response disappeared, the
local draft could not be recovered from `localStorage`, and the expanded frame
collapsed again. The existing component-level tests did not prevent this because
they do not exercise the full shell, the real draft lifecycle, and the event
sequence together.

**Implementation is blocked until this plan is reviewed and approved.** No
source fix should be attempted before then.

## What is known and what is not

Known from source inspection:

- The application shell is explicitly disposable: `renderAppShell()` calls
  `_cleanupReactiveBindings()`, empties `kikx-app`, and rebuilds the entire tree.
- The composer textarea is rebuilt with that shell. Its value is restored from
  `app._state.draft`, while the draft controller and `localStorage` are separate
  sources of truth.
- `activateComposerDraftSession()` reads `localStorage` but does not assign the
  local text to the controller when the controller is empty. If the server then
  returns an empty draft list, it removes the local draft and paints an empty
  composer.
- Composer persistence has a debounced server save and a synchronous local
  write, but local removal happens in multiple paths, including an empty server
  response and draft deletion. Those paths do not all prove that the local text
  is obsolete before deleting it.
- Question answer drafts are stored in an in-memory map keyed by question id.
  They are not durably persisted in `localStorage`.
- Frame expansion is stored in a module-level map keyed by frame id. A rebuilt
  item reads that map, but native `<details>` `toggle` events from detached or
  replaced nodes can still mutate the map after a rebuild.
- Runtime question/frame events can request an app render. The exact event
  sequence that produced this incident has not yet been captured.

Unknown until the reproduction phase:

- Whether the lost text was in the bottom composer or an inline question answer
  box.
- Which render path ran, and whether it was a full shell render or a component
  rebuild.
- Whether local draft deletion was caused by an empty server response, a draft
  send/delete, a session mismatch, or a stale asynchronous continuation.
- Whether the collapsed frame was the compact end-turn disclosure or a nested
  question/details disclosure.

The plan deliberately fixes the class of failure rather than guessing at one
event.

## Non-negotiable invariants

These are architectural invariants, not UI conventions.

1. **User-authored state is durable.** Composer text, question answers, focus,
   caret/selection, scroll anchor, and open/closed disclosures belong to a
   controller or store, never solely to a DOM node.
2. **A render is a projection.** Rendering may read user state and create DOM. It
   may not erase, replace, or normalize user state as a side effect.
3. **Input is the source of truth while the user is editing.** A repaint must not
   overwrite a non-empty, newer input with an older model, server response, or
   default.
4. **Local drafts survive until proven obsolete.** Only an acknowledged
   send/delete, or an authoritative server response with a matching newer
   revision, may remove local user text.
5. **Expansion is durable and user-owned.** A collapse caused by a rebuild,
   stale toggle event, frame-type transition, runtime event, or reload is a bug.
6. **Runtime events do not rebuild the shell.** SSE frame/question activity must
   update keyed content in place.
7. **Stale async work cannot mutate current state.** Every load/save/delete
   carries a session id, revision/epoch, and ownership token.
8. **Fail closed.** If the client cannot prove which state is newer, it keeps the
   user's text and reports a recoverable conflict; it never chooses deletion.
9. **No render storm.** No high-frequency path may schedule a full shell render,
   and full renders must be observable and bounded.
10. **OOP ownership.** Each state family has an explicit controller with methods;
    components do not reach into unrelated app fields or mutate DOM state
    directly.

## Architecture

### 1. UserWorkState controllers

Introduce explicit controllers, owned by the app or a per-session view model:

- `ComposerController`
  - current text, draft id, revision, save status
  - `setText()`, `restore()`, `flush()`, `markDelivered()`, `delete()`
  - local write-through on every input
  - server save is an optimization, not the durability mechanism
- `QuestionDraftController`
  - a map keyed by stable question id and session id
  - synchronous local persistence per question
  - explicit `restore()`, `clear()`, `pruneAuthoritative()`
- `ExpansionController`
  - keyed by durable frame id and question id
  - stores user intent with a monotonically increasing revision
  - `applyTo(details)` only when the element is the current live render of that id
- `ViewStateController`
  - shell mode, selected session, scroll anchor, focus/caret snapshot, open
    panels

Controllers are not module globals. They are created per app and are
session-scoped where the data is session-scoped. A full shell rebuild replaces
DOM, not these controllers.

### 2. Render transaction protocol

Every shell or thread render follows one protocol:

1. **Capture** a `UserWorkSnapshot` before DOM mutation:
   - active element and, for text controls, value/selection direction;
   - composer controller revision and local draft;
   - question drafts for visible questions;
   - expansion revisions;
   - scroll anchor/focus frame;
   - selected session and navigation key.
2. **Build** the new tree detached, as the current shell builder already tries
   to do.
3. **Swap** the tree.
4. **Restore only non-conflicting state**:
   - if the controller revision advanced during the build, do not write the
     old snapshot over it;
   - if the user is focused/dirty, never replace the input value;
   - restore expansion only from the current controller revision, not from a
     stale element event;
   - restore focus/caret only to the same logical control.
5. **Record** a render outcome in debug/diagnostics.

A renderer must never do these as a side effect:

- call `removeLocalComposerDraft()` without a delivery/authoritative proof;
- assign `textarea.value` while a newer draft revision exists;
- clear a question draft because the current fetch is incomplete;
- toggle expansion from a detached `<details>` element;
- schedule another full render because a scroll or measurement changed by 1px.

### 3. Composer durability

The composer is a view of `ComposerController`, not a copy of `_state.draft`.

- On every `input`, update the controller revision and write the full local
  draft synchronously. Debounce only the server PUT.
- On render, construct the textarea with the controller text. After mount,
  restore value and caret only if the controller revision matches the snapshot.
- Server hydration:
  - compare revision/timestamp; local wins when newer;
  - an empty server result never deletes a non-empty local draft;
  - a server draft never overwrites newer local text;
  - a delivered message marks its draft terminal before any cleanup;
  - deletion is idempotent and cannot remove a different draft id.
- Add an explicit recovery surface: if a local draft exists but server hydration
  fails or conflicts, keep it and show a non-destructive “restore” state.
- Add `pagehide`/`visibilitychange` synchronous flush as a last-resort local
  write, never as the only write.

### 4. Question answer durability

Question answers are the second composer, and must use the same rules.

- Key drafts by `{sessionID, questionID}` and persist them locally.
- Restore text on card/frame rebuild from the controller, not the DOM.
- A question status event may clear a draft only when that exact question is
  provably answered/dismissed/terminal.
- A partial/truncated question fetch must never prune drafts.
- Inline question frames and Inbox cards read and write the same controller.
- Submitting one question must not touch another question’s draft.

### 5. Expansion durability

- Store expansion by stable frame id; use a stable question id for nested
  question disclosures.
- Give each `<details>` element an owner token and render epoch. A `toggle`
  listener may mutate the store only while its token is current and the element
  is connected and still belongs to the same frame id.
- Ignore `toggle` events caused by detaching/replacing a subtree.
- Persist expansion for the session (at minimum in memory; optionally local
  storage for reload) and reapply it after every rebuild.
- Do not key expansion by row position, frame type, or transient frame object.

### 6. Eliminate unnecessary full renders

- Audit every `_render()` / `_requestRender()` call.
- Runtime frame/question/stream events update only the affected keyed frame,
  question, status, or draft surface.
- Full shell renders are allowed only for explicit structural changes:
  authentication/session/navigation, shell mode, or an explicit recovery action.
- Add render counters and labels in debug mode. A full shell render while a
  composer or question answer is dirty is a test failure.
- Scroll/measurement events never trigger structural page renders.
- The page source and frame items remain keyed so DOM identity is preserved
  across live updates.

### 7. State ownership and OOP cleanup

Remove ad hoc user-state fields from generic app state where they are not
model state. Components interact through controllers and explicit handlers.
No component should:

- read and write unrelated `_state` fields directly;
- treat `details.open`, `textarea.value`, or DOM focus as durable state;
- install a listener that captures a component instance without a teardown
  token;
- mutate a shared map from an event whose element may be stale.

## Verification strategy

The current tests are necessary but insufficient. Add a fault-injecting test
layer that forces the failure instead of hoping an ordinary event reproduces it.

### Unit/controller tests

- Composer: local draft, empty server response, newer local vs older server,
  failed PUT, stale PUT completion, delete race, session switch, send ack,
  reload hydration.
- Question drafts: rebuild restore, partial fetch, terminal status, sibling
  isolation, local persistence, stale question event.
- Expansion: full shell rebuild, forced frame rebuild, type transition, stale
  toggle from detached element, nested question disclosure, reload.
- Snapshot protocol: revision advanced during render, focus moved, selection
  changed, dirty input is never overwritten.

### Browser tests

Use Puppeteer/Playwright with a real textarea and real `<details>`:

1. Type a long multiline response, expand an end-turn frame, and open a nested
   question.
2. Force a shell render, a frame burst, a question update, a reconnect, a filter
   change, and a session return while still typing.
3. Assert exact text, caret/selection, local draft contents, expansion state,
   and focus after every operation.
4. Simulate an empty/older server draft and assert local text remains.
5. Reload and assert draft and expansion restoration.
6. Repeat the forced render while typing for at least 100 cycles; assert no
   character loss and no full shell render in the stream path.

### Mutation/fault harness

- A test-only render-forcing flag that runs `renderAppShell()` between keystrokes.
- A response reordering proxy for draft GET/PUT/DELETE.
- Synthetic stale `toggle` events from detached nodes.
- Runtime event replay for every frame/question event type.
- Assertions on render counts, user-state revisions, and storage keys.

### CI gates

- Any full shell render while `ComposerController.dirty === true` fails.
- Any draft deletion without a matching delivery/ack fails.
- Any expansion change from a non-current element token fails.
- Any runtime frame/question event requesting a structural render fails.
- Existing component tests remain green; the new tests must fail against the
  current implementation before the fixes land.

## Phased execution

### Phase 0 — Reproduce and instrument (no fixes)

- Record the exact event sequence from the owner’s incident.
- Add temporary diagnostics for render reasons, draft lifecycle, expansion
  events, and storage mutations.
- Preserve a failing browser reproduction and artifacts.
- Exit: we can show a single test that wipes/ collapses under the current code.

### Phase 1 — UserWorkState and render transaction

- Add controllers and snapshot/restore plumbing without changing behavior.
- Add revision/token fields and debug counters.
- Exit: forced renders preserve a static snapshot in tests; no user-facing
  behavior change yet.

### Phase 2 — Composer durability

- Make write-through local persistence and conflict rules authoritative.
- Remove unconditional local deletion.
- Add recovery behavior.
- Exit: all composer draft fault tests pass; owner verifies typing survives
  forced renders and reload.

### Phase 3 — Question drafts and expansion durability

- Move question drafts to the shared durable controller.
- Persist and restore expansion with owner tokens and stale-event guards.
- Exit: typed answers and open disclosures survive forced rebuilds, reconnects,
  question updates, and reload.

### Phase 4 — Remove full renders from live paths

- Audit and replace high-frequency render calls with keyed updates.
- Make shell renders explicit and observable.
- Exit: runtime event replay produces zero shell rebuilds; thread remains
  interactive.

### Phase 5 — OOP cleanup and guardrails

- Move remaining ad hoc user state to controllers.
- Remove DOM-as-state paths and stale listeners.
- Add CI gates and debug diagnostics.
- Exit: full suite, browser lane, and forced-render stress pass.

### Phase 6 — Owner acceptance

- Owner reproduces the original workflow for at least several minutes while an
  agent streams updates.
- Show exact recovery after reload and local storage proof.
- No merge until the owner confirms.

## Acceptance criteria

This campaign is complete only when all of the following are demonstrated:

- A long typed composer response survives: forced shell renders, frame bursts,
  question events, SSE reconnect, filters, session return, reload, and an empty
  or stale server draft.
- A typed inline question answer survives the same matrix, per question.
- An expanded end-turn frame and nested question disclosure remain open across
  every rebuild.
- `localStorage` contains the recoverable draft at each point before delivery;
  delivery is the only path that removes it.
- Runtime streaming causes no full shell rebuild and no hover/input freeze.
- The failure-injection test suite fails on the current code and passes after the
  fixes.
- A debug-mode incident report shows render reason, draft revision, storage
  revision, and expansion revision without exposing secrets.

## Explicit stop rule

No source change to composer drafts, question drafts, expansion, shell render
selection, or runtime-event rendering begins until this plan is approved.
