# Bot Documentation — START HERE

**Read this file first.** It tells you how this documentation is structured and how to navigate it.

---

## What Is This?

`bot-docs/` is a structured knowledge base designed for AI agents working on the Kikx repository. All documentation here uses **compact YAML conventions** where appropriate to minimize token usage.

## Development Process

**READ THIS BEFORE DOING ANY WORK:** Follow the 5-phase process: Research > Architecture > Test Specs > Implementation > Review. Tests are written BEFORE implementation begins — the tests ARE the plan.

## Directory Structure

```
bot-docs/
  START.md              <- You are here. Read first.

  docs/                 <- Documentation of existing and planned systems
    kikx/
      architecture.yaml <- System architecture, data flow, key abstractions
      status.yaml       <- Current implementation status, what's done, what's broken
      known-issues.yaml <- Current bugs, code smells, and gotchas
      components.yaml   <- Frontend component registry
      concept-art.yaml  <- Visual direction from concept art references

  plan/                 <- Architecture plans and design documents
    kikx/
      v1-plan.yaml      <- Full V1 plan (8 phases) converted from master plan
      message-store.yaml <- MessageStore interface design (state unification)
      plan-updates.yaml <- Critical observations and plan drift analysis

  test/                 <- TDD plan tests — the tests ARE the plan
    kikx/
      unit.yaml         <- Unit test specs per module
      coverage.yaml     <- Coverage requirements
```

## Three-Part Organization

| Part | Purpose | Who writes it |
|------|---------|---------------|
| `docs/` | Documents what EXISTS and what we've LEARNED | Research agents |
| `plan/` | Describes what we WILL BUILD and HOW | Architecture agents |
| `test/` | Defines WHAT MUST PASS for the plan to be "done" (TDD) | Planning agents |

## Quick Reference

| I need to... | Read this |
|--------------|-----------|
| Understand the system architecture | `docs/kikx/architecture.yaml` |
| Know what's done and what's pending | `docs/kikx/status.yaml` |
| Know what's broken or risky | `docs/kikx/known-issues.yaml` |
| See the V1 plan | `plan/kikx/v1-plan.yaml` |
| See critical plan observations | `plan/kikx/plan-updates.yaml` |
| See the MessageStore design | `plan/kikx/message-store.yaml` |
| See test requirements | `test/kikx/unit.yaml` |
