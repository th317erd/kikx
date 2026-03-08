# Phase C4: Migrate Hook System to Router

## Status: COMPLETE

## Overview
Replace HookRunner with routing-plugin-based HookService. Hook handlers
become BasePluginClass subclasses registered via registerSelector() with
hook:* selectors. HookService runs legacy handlers and routing plugins
in a combined pipeline with block/modify/redirect/pass semantics.

## Steps

### Step 1: Create HookService
- [x] `src/core/hooks/hook-service.mjs` — routing-plugin-based replacement
- [x] Same `run(hookName, payload)` interface as HookRunner
- [x] Supports legacy function handlers (backward compat)
- [x] Supports routing plugin handlers (BasePluginClass)
- [x] Selector mapping: `hook:user-to-agent`, `hook:agent-to-user`, etc.
- [x] Pipeline semantics: block/modify/redirect/pass
- [x] Mixed handler chains (legacy first, then plugins)

### Step 2: Create hook infrastructure plugin
- [x] `src/core/internal-plugins/hooks/index.mjs` — documents pattern
- [x] Hook selector conventions defined

### Step 3: Wire into InteractionLoop
- [x] InteractionLoop prefers HookService over HookRunner
- [x] Backward compatible (falls back to HookRunner)

### Step 4: Wire into KikxCore
- [x] HookService created alongside HookRunner
- [x] Stored on context as 'hookService'

### Step 5: Tests
- [x] 21 tests for HookService
- [x] All 1595 tests pass (0 failures)

### Step 6: Commit
- [x] Committed
