# Phase D: Streaming — Implementation Plan

## Steps

- [ ] **D1: Shared EventEmitter** — `src/shared/lib/event-emitter.mjs` + tests
- [ ] **D2: FrameManager → Shared EventEmitter** — swap import, verify 0 regressions
- [ ] **D3: Commit Streaming over SSE** — enrich commit in InteractionLoop, forward in StreamController
- [ ] **D4: Client-side FrameManager** — session page owns FrameManager, commit-driven rendering
- [ ] **D5: Viewport Management** — scroll-based windowed loading, eviction
- [ ] **D6: Comprehensive Tests** — integration tests, E2E verification

## Commit Points

- After D2 (browser compat)
- After D4 (client integration)
- After D5 (viewport)

## Baseline

- 1634 tests, 0 failures
- Branch: v2
