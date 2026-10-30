# Lane 2 decision: `applyJoinCoordinatorOverride` deleted, spec repurposed as a boundary guard

Session: `edebed2f` (child of `cb551b14`). Coordinator: Zav (`99129d53`).
Executor of lane 1: Kikx-Runtime-Eng (`e5403bc7`). Repo: `kikx2`.

## What was asked

The worker escalated a binary: *wire* `applyJoinCoordinatorOverride` at the
invite/join path, or *delete* it and record that JOIN-B / JOIN-C are knowingly
unsupported. It declined to decide, correctly, because both branches change
contracts it does not own.

## Decision

**Delete it, and repurpose its spec into a guard on the live resolver.**

## Correction recorded against my own first answer

My initial answer in this session was "neither: keep it unwired, delete nothing".
That was wrong, and I corrected it against the record rather than defending it:

- The standing coordinator ruling (my answer to question `398f3b92`, repeated in
  todo "Coordinator residue: delete join override...") is that the override must
  be **deleted, not wired** -- because wiring grants an unrelated joiner
  coordinator authority, whereas the owner's rule is that authority flows DOWN the
  ancestry chain. Lateral takeover by joining is exactly what the ruling forbids.
- "Keep it unwired" satisfies "do not wire", but it leaves dead code that
  *encodes* the rejected semantic. An unwired helper is a loaded gun: the next
  caller to discover it wires it, and the authority rule silently inverts.
- I also treated the spec's JOIN-B/JOIN-C assertions as demanding a fix. They do
  not demand a fix; they document that those shapes are unsupported. The correct
  move was to move those assertions onto the resolver, which is what the ruling
  actually specified.

## Why wiring is not a small edit (why the worker was right to escalate)

An implementation of `isCoordinatorOfSomeSession` **does not exist anywhere in
`src`**: before the delete, `grep -rn isCoordinatorOfSomeSession src/` returned
only the doc comment and the function's own internal use. Wiring therefore meant
*inventing* a tree-wide oracle, not connecting one.

The override also only *returns* `{ coordinatorAgentID, changed }`; its spec says
applying it "is the caller's job". Wiring would therefore have to **write**
`coordinatorAgentID` on the join path (`agent-tools.mjs:138`), which today only
appends to `participantAgentIDs`. That converts a derived property into a
persisted one, contradicting the "resolve instead of store" rule that JOIN-A's
`persisted === false` assertion pins.

## What changed

1. `src/core/agents/coordinator-scope.mjs`: removed `applyJoinCoordinatorOverride`
   and its doc comment (514 -> 469 lines, back under the 500 soft cap).
   `grep -rn applyJoinCoordinatorOverride src/` now returns nothing.
2. `spec/core/agents/coordinator-join-override-spec.mjs` renamed to
   `coordinator-join-boundary-spec.mjs` and rewritten against the LIVE exports:

   - **the deleted helper must stay deleted** -- asserts
     `Object.hasOwn(coordinatorScope, 'applyJoinCoordinatorOverride') === false`,
     so re-adding the export fails a test instead of silently restoring the
     rejected semantic;
   - JOIN-A: a joiner that coordinates the child's parent resolves `inherited`,
     and the session record is still not written (`persisted === false`);
   - JOIN-B: an unrelated joiner is not crowned -- resolution is `promoted` to
     `p1`, and `hasCoordinatorAuthority` returns `{allowed:false,
     reason:'not-coordinator'}`;
   - JOIN-C: an inherited ancestor `Z` outranks the unrelated joiner `X`, and
     `X` has no authority over `C`;
   - requirement 1: a session of pure non-coordinator bots resolves `promoted`
     to one accountable bot, marked as promotion (not a designation), and the
     stored record stays null.

## Proof

- Boundary spec: 6 tests / 6 pass / 0 fail, `SPEC_EXIT=0`.
- **Mutation-proven**: appending a trivial `export function
  applyJoinCoordinatorOverride()` back to the module gives `MUT_EXIT=1`, 5 pass /
  1 fail, and the failure is exactly *"no export can crown a joining bot: the
  join-override helper is gone"*. Restored byte-identically (sha256
  `9dbf8601...` identical before and after, 0 `MUTANT` markers), then 6/6 green
  again (`RESTORE_EXIT=0`).
- Full gate: see the commit message for the recorded totals, exit code and the
  `find src spec -newermt @START` concurrent-write check.

## Consequence, stated plainly

JOIN-B and JOIN-C remain **unsupported**: a bot that coordinates an unrelated
branch and then joins a child does not take over that child, contrary to the
literal reading of P3. That limitation is now executable (two failing-if-changed
assertions) rather than folklore. If the owner wants P3 to hold literally, the
fix is a rule change in the read path's ancestor ordering plus a tree-wide
coordinator index -- not a revival of the deleted helper.

## Not verified

- No live join was performed to observe JOIN-B / JOIN-C end to end; the evidence
  is the resolver's source plus these assertions.
- No real compaction ran in a live child session after lane 1; selection is
  proven at the spec boundary and by reading the reachability chain
  (plugin -> runCompaction -> service -> resolver -> `services.frameRuntime`),
  not by a real context overflow.
