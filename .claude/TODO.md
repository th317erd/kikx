# TODO: Parallel Implementation — Tool-Log + Compaction

## Tool-Log Bot (other bot)
See `bot-docs/future-plans/tool-log.yaml`

## Compaction Bot (this bot)
See `bot-docs/future-plans/compaction.yaml`

---

# Rolling Compaction — Implementation TODO

## Phase 1: Core Infrastructure — COMPLETE
- [x] Plugin interface on base-plugin-class.mjs (20/20 tests)
- [x] CompactionRunner module (41/41 tests)
- [x] Frame list API null-out (7/7 tests)

## Phase 2: Claude Plugin — COMPLETE
- [x] shouldCompact, getMaxCompactionTokens, _createSingleTurn (24/24 tests)

## Phase 3: Client UI — COMPLETE
- [x] Create kikx-compaction-frame directory
- [x] Create kikx-compaction-frame web component
- [x] Add `getFrame()` to api.mjs
- [x] Add GET /sessions/:sessionID/frames/:frameID endpoint (controller + route)
- [x] Register 'compaction' in RENDERABLE_TYPES
- [x] Add compaction handler in createFrameElement()
- [x] Handle compaction frame:updated in session-page
- [x] Add i18n strings for compaction
- [x] Write tests (spec/client/compaction-frame-spec.mjs) — 59/59 pass
- [x] Existing createFrameElement tests still pass — 65/65 pass

## Phase 4: Integration (git pull first!)
- [x] InteractionLoop trigger — add CompactionRunner, fire-and-forget in startInteraction()
- [x] Message filter — buildMessages() compaction-aware filtering via options.activeCompaction
- [x] Pass activeCompaction state from startInteraction() to buildMessages()
- [x] Startup cleanup — cleanupStaleCompactions() delegation method
- [x] Integration tests — 17/17 pass (trigger, filter, cleanup, fire-and-forget error handling)
- [x] /compact command — 19/19 tests pass
  - [x] Fix CompactionRunner to pass agent.apiKey to _createSingleTurn
  - [x] Create compaction command plugin (registerCapability pattern)
  - [x] Write tests (spec/core/compaction/compact-command-spec.mjs)

## Phase 5: Wrap-up
- [ ] Poll for tool-log bot completion
- [ ] Full test suite green
