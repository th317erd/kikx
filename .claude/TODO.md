# Hero → Kikx Migration

## Phase 0: Pre-flight
- [x] 0.1 Set Node 24 as nvm default
- [x] 0.2 Change git remote to kikx

## Phase 1: Extract ClaudeAgent to Standalone Repo
- [x] 1.1 Add AgentInterface to plugin context in plugin-loader
- [x] 1.2 Refactor in-tree claude-agent to use injected AgentInterface
- [x] 1.3 Write standalone plugin into ~/Projects/kikx-workspace/kikx-plugin-claude/
- [x] 1.4 npm install + run tests in standalone repo (32 tests, 0 failures)
- [x] 1.5 Commit standalone repo (not pushed yet)
- [x] 1.6 Remove plugin from main project, verify tests (602 tests), commit

## Phase 2: Move Project Directory
- [x] 2.1 mv ~/Projects/hero → ~/Projects/kikx-workspace/kikx
- [x] 2.2 Verify tests pass in new location (602 tests, 0 failures)

## Phase 3: Rename hero → kikx
- [x] 3.1 Write rename script (scripts/rename.mjs)
- [x] 3.2 Dry-run rename script (267 content, 112 files, 50 dirs)
- [x] 3.3 Execute rename script
- [x] 3.4 Post-rename grep for stragglers, fix manually (12 fixed)
- [x] 3.5 Update .claude/ meta files
- [ ] 3.6 Run full test suite
- [ ] 3.7 Commit (ask before push)
