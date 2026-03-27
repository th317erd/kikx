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

## ⚠️ Server Management

**ALWAYS run `npm run check_server` BEFORE starting or restarting the server.**

- If the server is already running and you haven't changed server code → **do NOT restart it**
- Only stop/restart the server if you made code changes that require it
- The server runs on **port 8089**
- Start: `npm start` (runs in foreground — use `&` or background agent)
- Stop: `npm run stop`
- Restart: `npm run restart`
- Check: `npm run check_server`

**Another developer or bot may have started the server.** Don't kill their process unless you need to reload code changes.

---

## ⚠️ Puppeteer / Chrome Cleanup — MANDATORY

**After EVERY Puppeteer session, you MUST kill leftover Chrome processes.**

Puppeteer launches headless Chrome instances that persist after your test. They consume 100-300% CPU and make the user's fans spin. **This has happened repeatedly and the user is tired of it.**

**After finishing Puppeteer work, ALWAYS run:**
```bash
pkill -f "chrome.*puppeteer" 2>/dev/null; pkill -f "chrome.*headless.*no-sandbox" 2>/dev/null; echo "Chrome cleanup done"
```

**Then verify:**
```bash
ps aux | grep "puppeteer.*chrome\|chrome.*headless\|chrome.*no-sandbox" | grep -v grep | wc -l
# Should be 0
```

**No exceptions. Every time. Even if you think you closed the browser.**

---

## ⚠️ FrameManager — The Single Source of Truth ⚠️

**ALL frame mutations MUST go through FrameManager.merge().** No exceptions. No "quick fixes". No "it's simpler this way".

### NEVER do this:
```javascript
// ❌ WRONG — bypasses FrameManager, breaks SSE + Router
frame.hidden = true;
await frame.save();

// ❌ WRONG — bypasses FrameManager
frame.content = JSON.stringify(newContent);
await frame.save();

// ❌ WRONG — fabricated commit, not from FrameManager
interactionLoop.emit('commit', { sessionID, commit: { ... } });

// ❌ WRONG — direct DB update
framePersistence.updateFrameState(frameID, newState);
```

### ALWAYS do this:
```javascript
// ✅ CORRECT — use InteractionLoop.updateFrame()
let interactionLoop = context.getProperty('interactionLoop');
await interactionLoop.updateFrame(sessionID, {
  id: frameID,
  hidden: true,
  content: newContent,
});
```

`updateFrame()` is the ONLY blessed path for frame mutations outside of `InteractionLoop._createFrame()`. It handles: hydration of partial updates, `FrameManager.merge()`, persistence, SSE broadcast, and commit event emission. **Do NOT roll your own version.**

The chain: `updateFrame()` → `merge()` → commit event → SSE broadcast → FrameRouter → DB

### Why this matters:
- SSE won't broadcast if you bypass FrameManager
- FrameRouter won't fire plugins if you bypass FrameManager
- Commit history is lost if you bypass FrameManager
- Client and server state diverge if you bypass FrameManager

### Context:
Kikx is an agentic, encrypted, asynchronous, fully plugin-capable messaging system. **Stability, recoverability, and security are the goals. NOT performance.** Do not make "performance" decisions that compromise the FrameManager's architectural integrity.

We have documented plans. We have mandates. **FOLLOW THEM.** Do not deviate from plans and discussions unless mutual agreement dictates you do. Every shortcut creates more work. Every bypass creates a new bug.

**TEST YOUR WORK.** Unit tests AND E2E verification. Every time. "It looks right" is not proof. Tests that pass are proof. Never say "done" without evidence.

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
