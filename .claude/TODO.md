# Abilities System

## Step 1: Agent Abilities Convenience Methods (TDD) — COMPLETE

- [x] 1A. Write tests in `spec/core/models/agent-config-spec.mjs` (8 tests)
- [x] 1B. Implement `getAbilities()`, `setAbilities()`, `hasAbilities()` in `agent-model.mjs`
- [x] 1C. Run tests, verify green

## Step 2: PrimerAssembler — Abilities Injection (TDD)

- [ ] 2A. Fix existing tests in `spec/core/primer-assembler-spec.mjs`:
  - Remove 6 DM-specific tests (isDM references)
  - Keep 8 non-DM abilities tests
  - Add ~2 tests for always-present management instructions
- [ ] 2B. Implement abilities section in `PrimerAssembler.assemble()`:
  - If `agent.hasAbilities()`: append `--- ABILITIES ---` delimited section
  - If `agent.hasAbilities()`: append reminder line
  - Always: include brief management instruction re: `memory:updateAgentConfig`
  - No `isDM` parameter, no signature change
  - Ordering: [instructions] → [abilities] → [management note] → [reminder]
- [ ] 2C. Run tests, verify green

## Step 3: Post-Truncation Abilities Re-injection (TDD)

- [ ] 3A. Write tests in `spec/core/interaction/abilities-reinjection-spec.mjs`:
  - Truncation + abilities → re-injected
  - Truncation + no abilities → nothing
  - No truncation → nothing
  - Primer already injected this turn → no double-injection
  - Uses same `--- ABILITIES ---` delimiters
- [ ] 3B. Implement `reinjectAbilities()` in interaction pipeline:
  - Called after `truncateContent()` + `truncateConversation()` in `_prepareMessages()`
  - Gated on: truncation occurred, agent has abilities, primer NOT injected this turn
  - Mechanism: concatenate onto first user message (same as `injectPrimer`)
  - Private, ephemeral, not a frame
- [ ] 3C. Run tests, verify green

## Step 4: Integration Test + Full Suite

- [ ] 4A. Write integration test in `spec/core/integration/abilities-integration-spec.mjs`:
  - Full round-trip: create agent → set abilities → assemble primer → verify
  - Truncation round-trip: set abilities → long history → truncate → verify re-injected
- [ ] 4B. Full test suite run — all existing + new tests pass
- [ ] 4C. Update `bot-docs/future-plans/abilities-system.yaml` to reflect completed state
