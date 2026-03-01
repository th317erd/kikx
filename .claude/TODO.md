# Hero → Kikx Migration

## Phase 0: Pre-flight
- [ ] 0.1 Set Node 24 as nvm default
- [ ] 0.2 Change git remote to kikx

## Phase 1: Extract ClaudeAgent to Standalone Repo
- [ ] 1.1 Add AgentInterface to plugin context in plugin-loader
- [ ] 1.2 Refactor in-tree claude-agent to use injected AgentInterface
- [ ] 1.3 Write standalone plugin into ~/Projects/kikx-workspace/kikx-plugin-claude/
- [ ] 1.4 npm install + run tests in standalone repo
- [ ] 1.5 Commit + push standalone repo
- [ ] 1.6 Remove plugin from main project, verify tests, commit

## Phase 2: Move Project Directory
- [ ] 2.1 mv ~/Projects/hero → ~/Projects/kikx-workspace/kikx
- [ ] 2.2 Verify tests pass in new location

## Phase 3: Rename hero → kikx
- [ ] 3.1 Write rename script (scripts/rename.mjs)
- [ ] 3.2 Dry-run rename script, review output
- [ ] 3.3 Execute rename script
- [ ] 3.4 Post-rename grep for stragglers, fix manually
- [ ] 3.5 Update .claude/ meta files
- [ ] 3.6 Run full test suite
- [ ] 3.7 Commit (ask before push)
