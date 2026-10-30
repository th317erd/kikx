# Coordinator residue: rung 4 now resolves through the session tree

Session: `edebed2f-3867-4c8f-9f1e-58024a5709c7` (child of `cb551b14`), coordinator Zav (`99129d53`).
Agent: Kikx-Runtime-Eng (`e5403bc7`). Repo: `kikx2`, based on `b9761322` (clean, `origin/main...HEAD` = `0 0`).

## 1. What was actually broken (measured, not assumed)

`select-compactor.mjs` rung 4 gated on the session's **own** field:

```js
let explicitCoordinatorID = normalizeOptionalString(session?.coordinatorAgentID);
if (explicitCoordinatorID) { ... }
```

A child session stores `coordinatorAgentID: null` when it inherits — resolution is *derived*,
not stored (`resolveSessionCoordinator` header, and `coordinator-join-override-spec.mjs:81`
asserts `resolved.persisted === false` for exactly this case). So for any child session, rung 4
was dead code and compaction fell through to rung 5 ("largest window"), ignoring who owned the run.

Reproduced with a failing test before touching the source
(`spec/core/compaction/select-compactor-spec.mjs`, "rung 4 accepts a coordinator INHERITED…"):

```
✖ rung 4 accepts a coordinator INHERITED from an ancestor session
  AssertionError: Expected values to be strictly deep-equal:
  +   agentID: 'big',
  +   reason: 'largest',
  -   agentID: 'root',
  -   reason: 'coordinator'
```

## 2. The change

- `src/core/compaction/select-compactor.mjs` — rung 4 calls `resolveCoordinator(session, participants, getSession)`,
  accepting `source === 'explicit'` **or** `'inherited'`, and deliberately **not** `'promoted'`.
  Promotion is not a designation; counting it would collapse rung 5 entirely and hand compaction
  to a bot nobody assigned. New optional `getSession` parameter.
- `src/core/compaction/compactor-resolver.mjs` — threads a real lookup into selection. Accepts an
  injected `input.getSession`, else reaches `frameRuntime` through the exported
  `resolveService` from `agent-route/normalize.mjs:64` (no seventh private copy of that helper;
  six already exist). Prefers the in-hand session record so a runtime that does not cache the
  current session cannot silently downgrade rung 4.
- `spec/core/compaction/compactor-resolver-tree-spec.mjs` (new, 4 tests) — reachability proof
  through the **production entry point**, not just the pure function.

## 3. Proof

- New spec, targeted: `TREE_SPEC_EXIT=0`, 4/4.
- Full gate at this tree: `GATE_EXIT=0`, **tests 2791 / pass 2762 / fail 0 / skipped 29**,
  duration 5907 ms, `find src spec -newermt @START` printed nothing (no concurrent writer).
- Pre-change baseline in this same session was 2774 tests; the +17 is 3 new rung-4 spec
  assertions + 4 resolver-tree tests plus collection from the newly added files.

## 4. Self-corrections worth keeping

1. **My first fixture was non-discriminating.** `resolveCompactionAgent` builds participants from
   `resolveSessionWindows`, which derives every window from provider/catalog — so both agents got
   the same default window, rung 5 tied, and the tie broke by participant order. The "inherited"
   test passed for the wrong reason. Fixed by putting `big` first so rung 5 answers `big` and
   rung 4 answers `root`: the two paths now give different answers.
2. **The spec caught a real bug in my own patch:** `ReferenceError: resolveService is not defined`
   in `compactor-resolver.mjs`. Fixed by importing the existing export rather than adding a copy.

## 5. Lane 2 NOT done: `applyJoinCoordinatorOverride` delete order

I did **not** delete it. The delete order rests on "it is redundant with the read path", and its
own spec contradicts that premise at this commit — 8/8 passing, with two tests that exist
specifically to document the uncovered shapes:

- **JOIN-A** joiner coordinates C's parent → covered by inheritance (`source: 'inherited'`).
- **JOIN-B** joiner coordinates an *unrelated* branch → **not covered**; resolution force-promotes
  the parent's first participant (`spec:87-97`).
- **JOIN-C** joiner unrelated while C inherits from an ancestor → **not covered**; the ancestor
  wins and `hasCoordinatorAuthority({agentID:'X', targetSessionID:'C'})` returns
  `{allowed:false, reason:'not-coordinator'}` (`spec:128-145`).

So deleting it removes the only executable statement of owner ruling P3 for two of three join
shapes. It is also not wired: `grep -rn applyJoinCoordinatorOverride src/` returns exactly one
hit — its own definition at `coordinator-scope.mjs:483`. Unwired is true; redundant is not.
Decision left to the coordinator: wire it at the invite/join path, or delete it *and* record that
JOIN-B/JOIN-C are knowingly unsupported.

## 6. Not verified / risks

- No real-browser or live-session evidence: this is server-side selection logic, proven at the
  spec boundary. A real compaction in a live child session was not triggered.
- `selectCompactor` remains pure and still degrades to the local field when no lookup is supplied;
  that path is pinned by a test, but it means any *future* caller that forgets `getSession`
  reintroduces the residue silently for inherited sessions.
- `applyJoinCoordinatorOverride` is untouched and still unwired.
- No commit or push: this agent is forbidden from both.
