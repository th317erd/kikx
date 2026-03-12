# Abilities System

## Step 1: Agent Abilities Convenience Methods (TDD) — COMPLETE

- [x] 1A. Write tests in `spec/core/models/agent-config-spec.mjs` (8 tests)
- [x] 1B. Implement `getAbilities()`, `setAbilities()`, `hasAbilities()` in `agent-model.mjs`
- [x] 1C. Run tests, verify green

## Step 2: PrimerAssembler — Abilities Injection (TDD) — COMPLETE

- [x] 2A. Fix existing tests in `spec/core/primer-assembler-spec.mjs`:
  - Removed 6 DM-specific tests (isDM references)
  - Kept 8 non-DM abilities tests
  - Added 2 tests for always-present management instructions
- [x] 2B. Implement abilities section in `PrimerAssembler.assemble()`:
  - If `agent.hasAbilities()`: append `--- ABILITIES ---` delimited section
  - If `agent.hasAbilities()`: append reminder line
  - Always: include brief management instruction re: `memory:updateAgentConfig`
  - No `isDM` parameter, no signature change
  - Ordering: [instructions] → [abilities] → [management note] → [reminder]
- [x] 2C. Run tests, verify green (57 primer tests + 32 agent-config tests, all pass)

## Step 3: Post-Truncation Abilities Re-injection (TDD) — COMPLETE

- [x] 3A. Write tests in `spec/core/interaction/abilities-reinjection-spec.mjs` (25 tests):
  - Truncation + abilities: 5 tests (concatenation, delimiters, reminder, format, marker skip)
  - Truncation + no abilities: 1 test (unchanged)
  - No truncation: 2 tests (unchanged with various message counts)
  - Primer already injected: 3 tests (primerInjected true/false/missing)
  - Null/undefined/plain agent: 3 tests
  - Immutability: 2 tests (no mutation, new array reference)
  - Edge cases: 9 tests (empty/null/undefined messages, no user msg, null content, empty content, empty abilities string, only-first injection, varied marker text)
- [x] 3B. Implement `reinjectAbilities()` in `src/core/interaction/abilities-reinjection.mjs`:
  - Pure function: `reinjectAbilities(messages, agent, options = {})`
  - Guards: primerInjected, null agent, missing hasAbilities method, no abilities, no truncation marker
  - Detects truncation via `[Earlier conversation history was truncated` prefix
  - Injects into first non-marker user message (same pattern as `injectPrimer`)
  - Returns new array, does not mutate input
- [x] 3C. Wire into InteractionLoop (`src/core/interaction/index.mjs`):
  - Import `reinjectAbilities` from new module
  - Call after primer injection block with `{ primerInjected: needsPrimer }`
- [x] 3D. Run tests, verify green (2340 tests, 0 failures)

## Step 4: Integration Test + Full Suite

- [ ] 4A. Write integration test in `spec/core/integration/abilities-integration-spec.mjs`:
  - Full round-trip: create agent → set abilities → assemble primer → verify
  - Truncation round-trip: set abilities → long history → truncate → verify re-injected
- [ ] 4B. Full test suite run — all existing + new tests pass
- [ ] 4C. Update `bot-docs/future-plans/abilities-system.yaml` to reflect completed state
