# Server Plan — Conversation Round 5

## Round 4 Resolved
- Async generator pattern for interaction loop: APPROVED
- Streaming format: type-specific HML tags with JSON bodies. Work with the bot, not against it.
- Agent identity: org-level agents with session aliasing. REST CRUD at org level.
- Abilities: reimagined as DM/PM conversations with the agent (instruction set = chat history)
- Primer: small, dynamic, "HOW to be" not "HERE is everything." Plugins export __onstart + help manuals.
- Frame schema: needs `order` + `group_id`/`group_type`. CTE query needs efficiency work.

---

## Continuing the Threads

### Q1: The Streaming Format — HML Tags Revisited

Your insight about embracing the bot's tendencies is key. Let me propose a concrete approach.

**The idea:** Agent output is regular text (streamable) with embedded HML tags for structured content. Each HML tag type maps to a frame type. JSON payload goes in the tag body.

```html
<hml-reflection>
Let me think about what weather data sources are available...
</hml-reflection>

The weather in Denver is currently sunny and 72°F. Let me search for more details.

<hml-websearch>{"query": "Denver Colorado weather forecast"}</hml-websearch>

<hml-prompt>{"fields": [{"name": "units", "type": "select", "options": ["Fahrenheit", "Celsius"]}]}</hml-prompt>
```

**How the streaming parser works:**
1. Text outside tags streams as `message` type phantom frames (real-time to client)
2. When an opening `<hml-*>` tag is detected, the parser switches to buffering
3. `<hml-reflection>` and `<hml-message>` tags: their body IS text, so it can still stream incrementally
4. `<hml-websearch>`, `<hml-bash>`, `<hml-prompt>`, etc.: buffer until closing tag, then parse JSON body and yield as a complete block
5. Each complete block becomes a yield from the async generator

**Why type-specific tags help the bot:**
- `<hml-websearch>` is more intuitive than `<hml-interaction type="tool" name="websearch">`
- The bot is less likely to mangle a simple self-contained tag
- If the bot puts attributes on the tag instead of a JSON body (its V1 tendency), we can handle BOTH: parse attributes as a fallback, JSON body as preferred
- Per-type tags are easier to validate (we know what shape the payload should be)

**Handling bot mistakes:**
- Mismatched close tags: match on the opening tag's type, ignore close tag name
- Attributes instead of body: parse attributes as key-value pairs, treat as payload
- Missing closing tag: on next `<hml-*>` opening or end-of-stream, close the current block
- Malformed JSON: try to repair (strip trailing commas, etc.) or emit as error frame

**Plugin-registered tag types:**
Each plugin registers its HML tag name(s). The parser doesn't hardcode types — it discovers them from the session's tool registry. Unknown `<hml-*>` tags are silently captured and yielded as `unknown` type blocks for debugging.

Does this approach address the V1 problems while keeping the streaming benefits?

### Q2: Abilities as DM/PM — Fleshing This Out

This is a breakthrough idea. Let me think through how it works mechanically.

**The mental model:** A "Direct Message" with your agent is a special session where the conversation history becomes the agent's instruction set.

When you say things like:
- "Always consider testing before proceeding with a task"
- "When someone asks about code, always check for security vulnerabilities"
- "Never run destructive commands without asking first"
- "You prefer concise responses over verbose ones"

...these become behavioral rules that the agent carries into all other sessions.

**How it works technically:**

1. **DM Session**: A special session type (or flag) — `{ type: 'dm' }` or `{ isDM: true }`. Just you and one agent. The session is tied to the agent definition.

2. **Instruction Extraction**: The DM conversation is the raw source. But we don't dump the entire chat history into the primer (that would be "HERE is everything" not "HOW to be"). Instead:
   - The agent ITSELF maintains a summary of its instructions. Like a "self-awareness" document.
   - After each DM exchange, the agent updates its own instruction summary: "Based on our conversation, here are my standing orders: ..."
   - This summary is what gets injected into the primer for other sessions.

3. **The Summary Frame**: A special frame type (maybe `type: 'instructions'`) that the agent writes to its own DM session. This is the compressed, up-to-date instruction set. The agent rewrites this after each meaningful DM exchange.

4. **Primer Injection**: When the agent joins any session, the primer includes:
   - Plugin-contributed __onstart instructions (tools, format, how-to)
   - The agent's self-maintained instruction summary from its DM session
   - Session-specific overrides (alias, role, etc.)

**Why this is powerful:**
- Natural language configuration — no forms, no wizards
- The agent understands context better than a structured editor ever could
- Instruction quality improves over time (the agent refines its own summary)
- Users can say "forget that rule" or "modify the testing rule to only apply to Python"
- It's just chat — the core competency of the entire application

**Potential concern:** What if the agent misinterprets an instruction? Or its summary drifts from what the user intended?
- Mitigation: The user can always say "Show me your current instructions" in the DM, and the agent displays its summary. The user corrects as needed.
- The summary frame is viewable/editable through the UI too (not JUST through chat).

What do you think? Am I capturing the vision correctly?

### Q3: Plugin Help System & Queryability

You want plugins to be queryable and to write help manuals. Here's my proposal:

**Each plugin exports a `help` descriptor:**
```javascript
// In plugin setup
context.registerHelp({
  name: 'websearch',
  summary: 'Search the web for information',
  usage: '/websearch <query>',
  description: 'Performs a web search using a headless browser...',
  examples: [
    { input: '/websearch Denver weather', output: 'Searches for Denver weather...' },
  ],
  permissions: ['tool:websearch'],
  tags: ['search', 'web', 'tool'],
});
```

**The help command aggregates all registered help entries:**
- `/help` — list all available commands/tools with summaries
- `/help websearch` — detailed help for a specific item
- `/help --tag search` — filter by tag
- `/help --type tool` — filter by type (tool, command, ability)

**Agent queryability:**
The agent can "call" the help system as a tool:
```json
<hml-help>{"filter": "tools", "tag": "search"}</hml-help>
```

This returns a formatted list of available tools matching the filter. The agent uses this to discover what's available to it — the "HOW to be" approach.

**The primer instruction for this would be minimal:**
> "You have access to a help system. To discover available tools, commands, and capabilities, use `<hml-help>` with a filter. Start by querying what's available to you."

Instead of listing every tool in the primer, the agent discovers them dynamically. This keeps the primer small and means plugins can be added/removed without regenerating the primer.

### Q4: Frame Persistence — More Efficient Approach

You said the CTE isn't very efficient. Here's a better approach:

**Add a denormalized `interaction_id` column.** Every frame stores its root ancestor ID directly.

```sql
frames (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  interaction_id  TEXT NOT NULL,     -- root ancestor (self if top-level)
  parent_id       TEXT,              -- immediate parent (NULL if top-level)
  "order"         INTEGER NOT NULL,  -- monotonic counter per session
  group_id        TEXT,              -- phantom frame grouping
  group_type      TEXT,              -- phantom group type
  type            TEXT NOT NULL,
  content         TEXT,              -- JSON payload
  targets         TEXT,              -- JSON array of frame IDs
  author_type     TEXT,
  author_id       TEXT,
  hidden          INTEGER DEFAULT 1,
  deleted         INTEGER DEFAULT 0,
  processed       INTEGER DEFAULT 0,
  processed_at    TEXT,
  timestamp       INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT
)

-- Key indexes
CREATE INDEX idx_frames_session_order ON frames(session_id, "order");
CREATE INDEX idx_frames_interaction ON frames(interaction_id);
CREATE INDEX idx_frames_session_interaction ON frames(session_id, interaction_id, "order");
```

**Loading last N interactions — single query, no CTE:**
```sql
SELECT f.* FROM frames f
WHERE f.session_id = ?
  AND f.interaction_id IN (
    SELECT DISTINCT interaction_id FROM frames
    WHERE session_id = ? AND parent_id IS NULL AND deleted = 0
    ORDER BY "order" DESC
    LIMIT 20
  )
ORDER BY f."order" ASC
```

**Why this is better:**
- One query, one pass. The subquery gets the 20 most recent top-level IDs, then we grab everything with those interaction_ids.
- The composite index `(session_id, interaction_id, order)` makes both the subquery and outer query fast.
- No CTE, no OR conditions, no IN on two different columns.
- Backward pagination is just `AND "order" < ?` in the subquery.

**The `order` column:**
- Server-side monotonic counter per session (stored in the session record or computed from MAX + 1)
- Maps directly to FrameManager's `_orderCounter`
- When hydrating from DB, the FrameManager's counter is set to MAX(order) + 1

**The `group_id` / `group_type` columns:**
- For phantom frame composition. Phantom frames with the same `group_id` merge into a single composed frame.
- `group_type` determines merge behavior.
- These map directly to FrameManager's phantom/live-frame system.

Does this address your efficiency concern?

### Q5: Remaining Architecture Questions

Before we start turning this into a formal plan, a few loose ends:

**WebSocket events — what does the server broadcast?**
I'm thinking the server broadcasts frame events, and the client's FrameManager processes them:
- `frame:new` — a new frame was created (includes the full frame data)
- `frame:updated` — a frame was composed/updated
- `typing:start` / `typing:stop` — participant typing indicators

Is that sufficient, or are there other real-time events the client needs?

**Permissions system — where does it hook in?**
The permissions kernel checks during:
1. `prepareMessage(agent→system)` — before tool execution (the granular command decomposition)
2. Frame creation — can this user/agent create this type of frame?
3. Session actions — can this user archive, invite, etc.?

Is there anywhere else permissions need to check?

**Error handling philosophy:**
In V1 you wanted silent rejection in FrameManager but fail-fast elsewhere. For the server:
- Plugin errors: caught by execute() wrapper, logged, error frame created (visible to user)
- Kernel errors: fail fast, HTTP 500
- Permission denials: frame with `type: 'permission-denied'` (visible explanation)
- Agent API errors: retry once, then error frame

Sound right?

---

### Q6: Core Library Split (CRITICAL — from user, pre-Round 6)

**User's note:** "We need to discuss splitting out all the core features into a 'lib' folder. I want the server wrapped around a 'lib'. The program we are building will be a core module, that could be imported and used in headless code / Node code. The server just wraps around this functionality. Most of what we have been discussing is currently 'lib'."

**What this means:** The kernel components we've been designing (plugin loader, session manager, frame persistence, permissions, interaction loop, prepareMessage pipeline, cascading context, etc.) are NOT server code — they're a standalone library. The Mythix server is a thin shell that maps HTTP routes and WebSocket events onto this library.

**Implications we need to discuss:**
- Where does the lib live? `src/lib/`? `src/core/`? Alongside the existing `src/shared/frame-manager/`?
- What's the boundary? Everything below the HTTP/WS layer goes in lib. Routes, controllers, SSE handlers stay in server.
- Can the lib run without Mythix? (i.e., no Express dependency, no HTTP concepts)
- Does this change where plugins live? (lib-level, not server-level?)
- Testing: lib tests are pure unit/integration tests with no HTTP. Server tests are route-level.
- The FrameManager at `src/shared/frame-manager/` is already this pattern. The lib would be the next layer up.

**This needs to be a Round 6 topic before we write the formal plan.**

---

*Answer inline and we'll keep refining.*
