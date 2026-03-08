# Phase C1: Frame Event Router Foundation

## Status: COMPLETE

## Overview
Build the core routing engine, selector compiler, silent commit mode,
BasePluginClass with middleware chain, and wire into KikxCore.

## Steps

### Step 1: SelectorCompiler
- [x] Create `src/core/routing/selector-compiler.mjs`
- [x] Parse `type:user-message` → matcher function
- [x] Parse `type:tool-call[toolName=shell:execute]` → property matcher
- [x] Parse `type:*` → catch-all
- [x] Parse `author:agent` → authorType matcher
- [x] Support function predicates (pass through)
- [x] Invalid selector → throws at compile time
- [x] Create `spec/core/routing/selector-compiler-spec.mjs` with full test suite (28 tests)

### Step 2: BasePluginClass
- [x] Create `src/core/routing/base-plugin-class.mjs`
- [x] Constructor stores context on `this.context`
- [x] `this.logger` getter from context
- [x] `processChanges()` iterates `context.changes`, calls `onChange()` per entry
- [x] `onChange(propName, previousValue, newValue)` — override point
- [x] `checkPermission()` stub (full impl in Phase C3)
- [x] Create `spec/core/routing/base-plugin-class-spec.mjs` with full test suite (33 tests)

### Step 3: Silent commit flag on FrameManager
- [x] Add `silent` option to `merge()` in `src/shared/frame-manager/frame-manager.mjs`
- [x] Silent flag stored on commit object
- [x] Silent commits are real commits (in log, refs advance)
- [x] Add tests to existing frame-manager spec or new spec file (11 tests)

### Step 4: FrameRouter
- [x] Create `src/core/routing/frame-router.mjs`
- [x] Accept selector registrations
- [x] On non-silent commit: match selectors, build context, dispatch chain
- [x] `_executeChain()` — middleware chain with next()/done()
- [x] `_invokePlugin()` — try/catch/finally safety net
- [x] Re-entrant safety: queue-based iterative processing
- [x] context.changes computed via diff before dispatch
- [x] Create `spec/core/routing/frame-router-spec.mjs` with full test suite (27 tests)

### Step 5: registerSelector on PluginRegistry + PluginLoader
- [x] Add `_selectors` registry to `src/core/plugin-loader/registry.mjs`
- [x] Add `registerSelector()` method
- [x] Add `getSelectors()` method
- [x] Add `registerSelector` to plugin context in `src/core/plugin-loader/index.mjs`

### Step 6: Wire Router into KikxCore
- [x] Create FrameRouter in `src/core/kikx-core.mjs` after plugins load
- [x] Store on context
- [x] Router loads selectors from PluginRegistry

### Step 7: Integration tests
- [x] Full round-trip: frame → selector match → process() → new frame → second routing
- [x] Multiple plugins matching same frame
- [x] Silent commit not triggering routing
- [x] Registry integration
- [x] Context correctness
- [x] Error isolation
- [x] processChanges() integration (9 integration tests)

### Step 8: Run all tests, commit
- [x] All new tests pass (99 new tests)
- [x] All 1530 total tests pass (0 failures)
- [ ] Commit with descriptive message
