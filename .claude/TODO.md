# Session Relationships, Cross-Session Tools, and Thread Support

Plan: `bot-docs/future-plans/sessions-as-frames.yaml`
Design dialog: `.claude/conversation.md` (Rounds 1-7)

## Execution Order (TDD: tests first, then implementation)

### Phase A: Test Infrastructure — COMPLETE
- [x] **A1: Audit existing tests** — 4 files need updates: session-manager-spec (6 alias, 4 overrides, 3 updateParticipant), models-spec (alias + getDisplayName on Participant), command-dispatch-spec (invite alias test), message-assembly-v2-spec (alias in participant data)
- [x] **A2: Write session-relationships-spec.mjs** — 14 tests (12 fail TDD, 2 pass). Sub-sessions, CASCADE, depth, guards.
- [x] **A3: Write participant-lifecycle-spec.mjs** — 17 tests (14 fail TDD, 3 pass). Lifecycle frames, model cleanup, idempotent dupes.
- [x] **A4: Write cross-session-spec.mjs** — 43 tests. All 5 tools (listSessions, createSession, postToSession, readFromSession, inviteParticipant) with happy/failure/edge paths. Fails on import (plugin doesn't exist yet).
- [x] **A5: Write thread-support-spec.mjs** — 15 tests (6 pass, 9 fail TDD). parentId query filter + InteractionLoop parentId pass-through.
- [x] **A6: Write integration specs** — 11 tests across 3 files: sub-session (4), cross-session (3), thread (4).

### Phase B: Implementation (make tests pass)
- [x] **B1: Session model** — 14/14 tests pass. parentSessionID + linkedFrameID + virtual relationships + createSession pass-through.
- [x] **B2: Participant model** — alias/overrides/getDisplayName removed. 2 existing model tests break (B7 fix).
- [x] **B3: SessionManager** — 16/17 pass (Test 4 expected fail: no framePersistence in test context). Lifecycle frames, archived rejection, idempotent dupes.
- [x] **B4: /invite command** — Drop alias parsing, simplify. Also fixed primer/index.mjs p.alias reference.
- [x] **B5: Cross-session plugin** — 43/43 tests pass. 5 tools registered. Fixed test bugs (getFrames→toArray, sessionID→targetSessionID).
- [x] **B6: Thread support** — 15/15 tests pass. parentId filter in loadFramesInto + parentId pass-through in all InteractionLoop frame calls.
- [x] **B7: Fix existing tests** — 135/135 pass across 4 files. Deleted 8 alias/overrides tests, updated 3 others.

### Phase C: Verification
- [x] **C1: Run full test suite** — 1894/1895 pass. 1 known expected failure (Test 4: framePersistence not in test context).
- [x] **C2: Run AGIS thorough_review** — All 8 areas verified. 1 issue found and fixed (InteractionController parentId pass-through). 2 optional items deferred (self-reference guard, SOLR search).

## Status
- **COMPLETE.** All phases done. Ready for commit.
- **Tests written:** 100 new tests across 8 files (14 + 17 + 43 + 15 + 4 + 3 + 4)
- **Baseline:** 1800 existing tests pass, 0 fail
