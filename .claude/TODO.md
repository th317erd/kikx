# TODO: Prompt Caching, Token Tracking & Per-Message Metadata

## Task 1: Enable Anthropic Prompt Caching
- [x] Add `cache_control` to system prompt in `_createStream()` requestParams in plugin
- [x] Capture `cache_read_input_tokens` and `cache_creation_input_tokens` in `message_start` handler
- [x] Include cache stats in final `done` yield usage object

## Task 2: Token Tracking & Spend Calculators
- [x] Capture `done` block in `_iterateGenerator()` — emit `interaction:usage` event
- [x] Add `usage` SSE event listener in StreamController
- [x] Handle `usage` SSE event in session page client
- [x] Create `src/client/lib/cost.mjs` — cost estimation from token counts
- [x] Update store costs on each usage event (global, service, session)
- [x] Set `token-count` attribute on interaction elements from usage data
- [x] Reset session cost on session navigation

## Task 3: Human-Friendly Timestamps
- [x] Replace `formatTimestamp()` with relative time formatter ("just now", "Xm ago")
- [x] Add timestamp locale strings to `en.mjs`
- [x] Fix frame timestamp — accept epoch ms numbers and ISO strings

## Tests
- [x] Interaction loop `done` handling / `interaction:usage` event test (2 tests)
- [x] Stream controller `usage` SSE test (2 tests — matching + non-matching session)
- [x] Cost calculation unit tests (8 tests)
- [x] Relative timestamp formatting tests (9 tests)
- [x] All 1059 tests pass (Node 24) — 0 failures
