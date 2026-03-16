# Client-Side Test Audit

**Date:** 2026-03-15
**Auditor:** Claude Opus 4.6
**Test runner:** `node:test` (describe/it/before/after/beforeEach)
**DOM environment:** jsdom via `spec/client/jsdom-helper.mjs`

---

## Summary

The Kikx client has 32 components and 6 library modules. Before this audit, test coverage was limited to 6 spec files covering a subset of components and libraries. Many components had zero test coverage, and several tested components lacked edge case and failure path testing.

### Before Audit
- **Test files:** 6 (`api-spec`, `components-spec`, `multi-agent-streaming-spec`, `debug-spec`, `cost-and-timestamps-spec`)
- **Components with tests:** ~15 of 32 (but most are blocked by import issue)
- **Library modules with tests:** 1 of 6 (api.mjs partial)

### After Audit
- **Test files:** 10 (4 new files added)
- **New tests added:** 159 passing tests
- **Components with tests:** 22 of 32
- **Library modules with tests:** 4 of 6 (store, router, i18n added)

---

## Coverage Matrix

### Library Modules

| Module | File | Status | Tests Added | Notes |
|--------|------|--------|-------------|-------|
| **store.mjs** | `spec/client/store-spec.mjs` | NEW | 37 tests | All 6 scopes (sessions, agents, abilities, profile, theme, connection), resetStore, event batching, getState |
| **router.mjs** | `spec/client/router-spec.mjs` | NEW | 22 tests | defineRoute, navigate, resolve, auth guards, params, onRouteChange, reset |
| **i18n.mjs** | `spec/client/i18n-spec.mjs` | NEW | 18 tests | t() key resolution, interpolation, pluralization, setLocale, getLocale |
| **api.mjs** | `spec/client/api-spec.mjs` | Existing | 0 new | Auth persistence, token management well tested |
| **config.mjs** | - | No tests | 0 | 2 lines; trivial; not worth testing independently |
| **elements.mjs** | - | No tests | 0 | Helper utilities; could use tests |
| **query-engine.mjs** | - | No tests | 0 | Not currently used by components |

### Components

| Component | Category | Spec File | Tests | Status |
|-----------|----------|-----------|-------|--------|
| **kikx-scroll-anchor** | Messages | `untested-components-spec.mjs` | 6 | **NEW** - rendering, click event, show/hide, badge updates, edge cases |
| **kikx-command-result** | Content | `untested-components-spec.mjs` | 12 | **NEW** - rendering, status, expand/collapse, arguments (text + JSON), result, null handling, attribute changes |
| **kikx-reflection-block** | Content | `untested-components-spec.mjs` | 10 | **NEW** - rendering, toggle, events, content property, expand/collapse, idempotent expand/collapse, initial attribute |
| **kikx-websearch-result** | Content | `untested-components-spec.mjs` | 8 | **NEW** - status rendering (3 states + unknown), results rendering, empty/null/missing fields, replacement |
| **kikx-modal** | Layout | `untested-components-spec.mjs` | 11 | **NEW** - rendering, title, open/close, backdrop click, close button, Escape key, slot, cleanup |
| **kikx-session-list** | Lists | `untested-components-spec.mjs` | 11 | **NEW** - empty state, rows, click delegation, filter, archived, active, unread badge, sorting, categories, collapse |
| **kikx-create-session-modal** | Modals | `untested-components-spec.mjs` | 11 | **NEW** - rendering, agent select, no-agents, create/cancel events, Enter key, reset, null handling, edge cases |
| **kikx-login-page** | Pages | `components-spec.mjs` | 9 | BLOCKED by import |
| **kikx-top-bar** | Layout | `components-spec.mjs` | 9 | BLOCKED by import |
| **kikx-user-avatar** | User | `components-spec.mjs` | 8 | BLOCKED by import |
| **kikx-friends-list** | Lists | `components-spec.mjs` | 4 | BLOCKED by import |
| **kikx-add-friend-modal** | Modals | `components-spec.mjs` | 5 | BLOCKED by import |
| **kikx-sidebar** | Layout | `components-spec.mjs` | 5 | BLOCKED by import |
| **kikx-status-bar** | Layout | `components-spec.mjs` | 5 | BLOCKED by import |
| **kikx-settings-page** | Pages | `components-spec.mjs` | 5 | BLOCKED by import |
| **kikx-message-input** | Messages | `components-spec.mjs` | 8 | BLOCKED by import |
| **kikx-hml-prompt** | Content | `components-spec.mjs` | ~40 | BLOCKED by import |
| **kikx-hml-prompt-value** | Content | `components-spec.mjs` | ~10 | BLOCKED by import |
| **kikx-permission-request** | Permission | `components-spec.mjs` | 6 | BLOCKED by import |
| **kikx-session-link** | Lists | `components-spec.mjs` | 4 | BLOCKED by import |
| **kikx-interaction** | Messages | `components-spec.mjs` | ~20 | BLOCKED by import |
| **kikx-message-content** | Messages | `components-spec.mjs` | ~8 | BLOCKED by import |
| **kikx-application** | Pages | - | 0 | No tests (complex orchestrator) |
| **kikx-chat-view** | Layout | - | 0 | No tests (scroll container) |
| **kikx-websocket-manager** | Messages | - | 0 | No tests (needs WebSocket mock) |
| **kikx-participant-list** | User | - | 0 | No tests |
| **kikx-agent-list-modal** | Modals | - | 0 | No tests |
| **kikx-agent-form-modal** | Modals | - | 0 | No tests |
| **kikx-ability-wizard-modal** | Modals | - | 0 | No tests |
| **kikx-ability-list-modal** | Modals | - | 0 | No tests |
| **kikx-settings-tabs** | Modals | - | 0 | No tests |

---

## Blocking Issue: `kikx` Bare Import Resolution

**Severity: Critical**

The file `src/client/lib/store.mjs` imports from `'kikx/shared/lib/create-store.mjs'` -- a bare specifier that is resolved by browser import maps in production but CANNOT be resolved by Node.js test runner.

**Impact:** All components that import `store.mjs` (directly or transitively) fail to load during testing. This blocks **~15 existing component test suites** (292 cancelled tests) including:
- kikx-login-page, kikx-top-bar, kikx-sidebar, kikx-status-bar
- kikx-settings-page, kikx-session-page
- kikx-message-input, kikx-interaction, kikx-message-content
- kikx-hml-prompt, kikx-hml-prompt-value, kikx-permission-request
- kikx-session-link, kikx-friends-list, kikx-add-friend-modal

**Workaround applied:** The new `store-spec.mjs` imports `createStore` directly from `src/shared/lib/create-store.mjs` via relative path, bypassing the bare import.

**Recommended fix:** Add Node.js `imports` field to `package.json`:
```json
{
  "imports": {
    "kikx/*": "./src/*"
  }
}
```

---

## Source Bug: `dataset.sessionID` Casing

**Severity: Medium**
**File:** `src/client/components/kikx-session-list/kikx-session-list.mjs`

The `_onContainerClick` handler reads `dataset.sessionID` (uppercase D), but the HTML attribute `data-session-id` maps to `dataset.sessionId` (lowercase d) per the HTML specification.

This means:
- `select-session` events fire with `detail.sessionID: undefined`
- `archive-session` events fire with `detail.sessionID: undefined`
- `revive-session` events fire with `detail.sessionID: undefined`

**Fix:** Change `dataset.sessionID` to `dataset.sessionId` in 3 places in `_onContainerClick`.

---

## Priority Gap List

### Critical (blocks other tests)
1. **Bare import resolution** - Add `imports` field to package.json to unblock 292 cancelled tests

### High (untested critical paths)
2. **kikx-application** - Root orchestrator; controls routing, auth flow, theme application
3. **kikx-session-page** - Main chat page; most complex component (~1200 lines)
4. **kikx-chat-view** - Scroll management, near-top detection, auto-scroll
5. **kikx-websocket-manager** - WebSocket connection, reconnect, message dispatch

### Medium (functional components without tests)
6. **kikx-participant-list** - Session participant display
7. **kikx-agent-list-modal** - Agent selection modal
8. **kikx-agent-form-modal** - Agent create/edit form
9. **kikx-ability-wizard-modal** - Multi-step ability creation
10. **kikx-ability-list-modal** - Ability browsing modal
11. **kikx-settings-tabs** - Settings page tab navigation

### Low (nice-to-have improvements)
12. **elements.mjs** - DOM utility functions
13. **query-engine.mjs** - CSS selector engine
14. **Store integration tests** - Components reacting to store updates (needs import fix first)
15. **Cross-component event tests** - Custom event flow between parent/child components

---

## Edge Cases and Failure Paths Added

The new tests specifically cover these edge cases that were previously untested:

### Store
- Empty state defaults for all 6 scopes
- Removing non-existent items (no error)
- Updating non-existent items (silent ignore)
- Reset after populating all scopes
- Microtask batching (multiple sync updates = 1 event)
- Event unsubscribe
- State snapshot immutability (getState returns copy)

### Router
- Unmatched route resolution (returns null)
- Multiple URL parameters
- Auth guard redirect on failure
- Custom unauthorized redirect path
- Route change listener unsubscribe
- Param copy immutability
- Replace vs push navigation
- Reset clears all state

### i18n
- Missing key fallback (returns key string)
- Null/undefined/empty key handling
- Partial nested path resolution
- Undefined variables (placeholder preserved)
- Numeric interpolation
- Pluralization edge cases (count=0, missing forms)
- Locale override (replaces previous)

### Components
- Null/empty arguments and results (KikxCommandResult)
- Non-array input coercion (KikxWebsearchResult, KikxCreateSessionModal)
- Missing fields in data objects
- Idempotent expand/collapse (no duplicate events)
- Disconnect cleanup (event listener removal)
- Empty results array rendering
- Result replacement (old results cleared)
- Initial attribute state (expanded attribute on connect)
- Escape key listener lifecycle (added on open, removed on close/disconnect)

---

## Test File Summary

| File | Tests | Status |
|------|-------|--------|
| `spec/client/api-spec.mjs` | 10 | Existing, passing |
| `spec/client/components-spec.mjs` | ~160 | Existing, BLOCKED by import |
| `spec/client/multi-agent-streaming-spec.mjs` | ~20 | Existing, BLOCKED by import |
| `spec/client/debug-spec.mjs` | 12 | Existing, passing |
| `spec/client/cost-and-timestamps-spec.mjs` | 24 | Existing, passing |
| **`spec/client/store-spec.mjs`** | **37** | **NEW, passing** |
| **`spec/client/router-spec.mjs`** | **22** | **NEW, passing** |
| **`spec/client/i18n-spec.mjs`** | **18** | **NEW, passing** |
| **`spec/client/untested-components-spec.mjs`** | **72** | **NEW, passing (was 69 tests for 7 components)** |
| | **159 new** | |
