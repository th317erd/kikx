# Lane 2 decision: `applyJoinCoordinatorOverride` stays unwired

Session: `edebed2f` (child of `cb551b14`). Coordinator: Zav (`99129d53`).
Executor of lane 1: Kikx-Runtime-Eng (`e5403bc7`). Repo: `kikx2`.

## What was asked

The worker escalated a binary: *wire* `applyJoinCoordinatorOverride` at the
invite/join path, or *delete* it and record that JOIN-B / JOIN-C are knowingly
unsupported. It declined to decide, correctly, because both branches change
contracts it does not own.

## Decision

**Neither.** Keep the function unwired, and do not delete it. Record the gap here
as a known limit with a named owner ruling behind it.

## Why deleting is falsified

The delete rests on "it is redundant with the read path". Its own spec disproves
that for two of three join shapes, measured:

- JOIN-A (joiner coordinates C's parent) -> `source: 'inherited'`, covered.
- JOIN-B (joiner from an unrelated branch) -> `source: 'promoted'` to `p1`;
  `hasCoordinatorAuthority({agentID:'X', targetSessionID:'C'})` is
  `{allowed:false, reason:'not-coordinator'}`. Not covered.
- JOIN-C (joiner unrelated, C also inherits) -> ancestor `Z` wins; joiner `X`
  has no authority over C at all. Not covered.

Deleting would erase the only executable statement of owner ruling P3 for two of
three shapes. It is unwired; it is not redundant.

## Why wiring is not a small edit (the real blocker)

An implementation of `isCoordinatorOfSomeSession` **does not exist anywhere in
`src`**: `grep -rn isCoordinatorOfSomeSession src/` returns only the doc comment
at `coordinator-scope.mjs:480` and the function's own internal use at
`:487-504`. Wiring therefore requires inventing an oracle, not connecting one.

That oracle must answer "is this bot the coordinator of *some* session in the
tree", which needs either a tree-wide index (none exists) or a full session scan
per join, and it must include sessions outside the current subtree.

There is also a design conflict the worker did not name:

- The coordinator design deliberately **derives** rather than stores. JOIN-A's
  own assertion `resolved.persisted === false` is commented as "the 'resolve
  instead of store' rule".
- `applyJoinCoordinatorOverride` only *returns* `{ coordinatorAgentID, changed }`
  and its spec says applying it "is the caller's job", which means the join path
  would have to **write** `coordinatorAgentID`.

So wiring converts a derived property into a persisted one, at a path
(`agent-tools.mjs:138`) that currently only appends to `participantAgentIDs`.
That is a semantic change to coordinator ownership for every future join, which
is an owner-level decision, not an implementer's cleanup.

## What is actually true today

- `applyJoinCoordinatorOverride` is unwired: one hit in `src/`, its definition.
- 8/8 of its spec passes, and two of those tests exist to *document* the gap
  rather than to demand a fix.
- No session in practice has exercised JOIN-B / JOIN-C through a join, because
  the override never runs; the read path simply resolves inheritance or
  promotion and nobody is misled about who owns the run.

## Consequence, stated plainly

JOIN-B and JOIN-C remain **unsupported**. A bot that coordinates an unrelated
branch and then joins a child does not take over that child, contrary to the
literal reading of P3. This is now recorded rather than latent.

## Owner options if P3 should hold literally

1. Build a coordinator index and implement the oracle, then wire the write path
   and accept a persisted `coordinatorAgentID` on join.
2. Change the read path so an unrelated-branch joiner outranks inheritance,
   keeping everything derived (no write, but a rule change in rule 2/3 ordering).
3. Leave as-is: P3 applies to joins into a child whose parent the joiner already
   coordinates (JOIN-A), which the read path covers.

Recommendation: option 3 until a real multi-branch join is observed to matter,
because options 1 and 2 both change ownership semantics and neither is
currently exercised in production.

## Not verified

- No live join was performed to observe JOIN-B/JOIN-C behaviour end to end; the
  evidence is the spec's assertions plus the read path's source.
- No real compaction ran in a live child session after lane 1; selection is
  proven at the spec and reachability-by-reading boundary, not by wall-clock
  expiry of a real context.
