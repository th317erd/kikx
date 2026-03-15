# Claude Code Instructions

## ⚠️ TEST CREDENTIALS - READ THIS FIRST ⚠️

```
Email:    test-bot@kikx.com
Password: securePass123
```

**MEMORIZE THESE.** Use for ALL browser testing and Puppeteer automation.

The `test-bot` user has agents:
- `test-claude` (agt_d6k1n1wpe7dy5tq17hcg) — valid Anthropic API key
- `test-claude-2` (agt_d6n3g30pe7dwfan9erdg) — same API key

---

## ⚠️ Testing Safeguards

### Agent Protection Rule

**NEVER create or edit an agent unless its name starts with `test-`** (case-insensitive).

Examples:
- ✅ `test-claude` - OK to create/edit
- ✅ `Test-Agent` - OK to create/edit
- ✅ `TEST-foo` - OK to create/edit
- ❌ `Claude` - DO NOT touch
- ❌ `My Agent` - DO NOT touch
- ❌ `Test Agent` - DO NOT touch (no hyphen!)

**Why:** During Puppeteer/browser testing, writes go to the real database. This rule prevents accidentally overwriting real API keys with test placeholders.

**Before any agent operation:** Verify the agent name matches `/^test-/i`. If it doesn't, STOP and ask the user.

### For Real Interaction Testing

Use the `test-bot` user's `test-claude` agent which has a valid API key.

- Login as `test-bot@kikx.com` / `securePass123`
- Create a new **session** (sessions are safe to create freely)
- Select `test-claude` as the agent
- Send test messages to verify functionality

**DO NOT** create new agents for interaction testing - use `test-claude`.

---

## Project Documentation

For a comprehensive understanding of the Kikx project — architecture, data models, plugin system, client, and more — see the **[Documentation Index](./bot-docs/docs/README.md)**.

---

## !!!MANDATORY FIRST ACTION!!!

**STOP. Before responding to the user, ask yourself: "Do I have the contents of `~/.claude-config/startup.md` in my current context?"**

If NO → Use the Read tool to read `~/.claude-config/startup.md` RIGHT NOW, before doing anything else.
If YES → Proceed normally.

This applies after every `/compact`, session start, or context reset. The file contains critical workflow rules and preferences.

---
