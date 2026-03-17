# TODO: Rename "abilities" → "behaviors"

## Scope
Rename the "abilities" system to "behaviors" across all V2 code. Drop the
ability-list-modal component (behavior updates happen through the agent).
Do NOT touch `old-app/`.

## Steps

- [x] 1. Core: Agent model methods (`getAbilities`→`getBehaviors`, etc.)
- [x] 2. Core: Primer assembler — delimiters, section text, mandate
- [x] 3. Core: Rename `abilities-reinjection.mjs` → `behaviors-reinjection.mjs`
- [x] 4. Core: InteractionLoop import + call site
- [x] 5. Core: AgentResolver convenience method preservation
- [x] 6. Server: InteractionController convenience method preservation
- [x] 7. Delete old `abilities-reinjection.mjs`
- [x] 8. Client: Drop ability API endpoints from api.mjs
- [x] 9. Client: Drop abilities scope from store.mjs
- [x] 10. Client: Drop ability i18n strings
- [x] 11. Client: Drop kikx-ability-list-modal + kikx-ability-wizard-modal components
- [x] 12. Client: Drop ability specs
- [x] 13. Tests: Update primer-assembler-spec
- [x] 14. Tests: Rename + update reinjection spec
- [x] 15. Tests: Rename + update integration spec
- [x] 16. Tests: Update agent-resolver-spec, agent-config-spec, agent-config-migration-spec
- [x] 17. Docs: Update abilities-system.yaml → behaviors-system.yaml
- [x] 18. Docs: Update data-models.md, future-plans.yaml, client-architecture.md, etc.
- [x] 19. DETAILS.md update
- [x] 20. Run full test suite — 0 regressions (23 pre-existing failures, same as baseline 33 minus deleted tests)

## Status: COMPLETE
## Ready to commit
