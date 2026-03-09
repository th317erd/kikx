# Agent-less Message Posting — COMPLETE

## Steps

- [x] **Step 1: Add `InteractionLoop.postMessage()`** — Persist a user-message frame + broadcast via SSE without starting an agent interaction
- [x] **Step 2: Update `InteractionController.sendMessage`** — Make `agentId` optional; when absent, call `postMessage()` instead of `startInteraction()`
- [x] **Step 3: Update client `api.mjs`** — Make `agentId` optional in `sendMessage()`
- [x] **Step 4: Update client `_onSendMessage`** — Remove early return + system error for no agent; always send the message
- [x] **Step 5: Tests** — 12 new tests for `postMessage()` + updated route test (1792 total, 0 failures)
- [x] **Step 6: Verify** — curl API test + Puppeteer E2E confirms messages persist and render in agent-less sessions

## Files Changed

| File | Change |
|------|--------|
| `src/core/interaction/index.mjs` | Added `postMessage()` method |
| `src/server/controllers/interaction-controller.mjs` | `agentId` now optional; no-agent path calls `postMessage()` |
| `src/client/lib/api.mjs` | `sendMessage()` omits `agentId` from body when falsy |
| `src/client/components/kikx-session-page/kikx-session-page.mjs` | Removed early return + system error for no agent |
| `src/client/components/kikx-create-session-modal/kikx-create-session-modal.mjs` | Create button always enabled; agent optional |
| `spec/core/interaction-post-message-spec.mjs` | NEW — 12 tests |
| `spec/server/routes-spec.mjs` | Updated test to expect 201 instead of 400 |
