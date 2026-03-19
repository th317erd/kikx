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

## Phase 2: Claude Plugin
- [ ] shouldCompact, getMaxCompactionTokens, _createSingleTurn

## Phase 3: Client UI
- [ ] kikx-compaction-frame web component
- [ ] Register in createFrameElement()

## Phase 4: Integration (git pull first!)
- [ ] InteractionLoop trigger + message filter
- [ ] /compact command

## Phase 5: Wrap-up
- [ ] Poll for tool-log bot completion
- [ ] Full test suite green
