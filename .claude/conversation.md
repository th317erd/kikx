# Inter-Agent Streaming + Multi-Coordinator Discussion Protocol

Planning conversation for streaming identity, cross-session relaying, and multi-coordinator discussion. User annotates inline with `<!-- comments -->`.

---

## Round 1 — Understanding Intent

**The idea in three sentences:**

When a session has two or more agents marked as "coordinators," incoming user messages trigger a round-robin
<!-- 
Comment: You say round-robin, which is fine, but is this really true? We will always be feeding all conversation history to all agents, by necessity of design and memory. This means anything any user say will go to BOTH agents, by default. Right?

Besides, even if I am wrong, this would still only be "pseudo random", in the sense that if an agent is busy "thinking", we would sent it to the "available" agent instead.
 -->
discussion protocol instead of the normal single-agent response — each coordinator takes turns producing visible "discussion" frames where they deliberate, and one eventually claims the right to deliver the final response. This sits on top of a streaming identity layer that tags every SSE event with the authoring agent's ID, so the client can show per-agent typing indicators and streaming bubbles even when multiple agents are active. There's also a cross-session relay that forwards streaming deltas back to the originating session when one agent delegates work to another session, so the user isn't staring at silence while something happens elsewhere.

<!-- 
Yes, this all sounds correct.
 -->

**Three capabilities:**

1. **Streaming identity** — the client knows *which* agent is talking
2. **Multi-coordinator discussion** — agents deliberate before one responds
3. **Cross-session relay** — streaming forwarded across session boundaries

### Questions Before Architecture

**Q1: Who is this for?**
Is this a "panel of experts" UX where the user *watches* agents deliberate? Or is the discussion more of an internal coordination mechanism that happens behind the scenes, with only the final response shown to the user?

<!--
This is more of the later:
"Or is the discussion more of an internal coordination mechanism that happens behind the scenes, with only the final response shown to the user?"

However, it might be _cool_ to watch them deliberate.
-->

**Q2: How does a coordinator differ from a member?**
Is a coordinator just "an agent that's allowed to respond to the user directly" while members only act when delegated to? Or is there a richer distinction you have in mind?

<!-- 
The "Coordinator" agent has a few special properties:
1. They get the final say in any debate or mismatch
2. They are instructed _not_ to do long-running or difficult tasks, but instead to simply coordinate other agents to do the work.
3. In a "debate" situation like this, they would be selected to be the one to respond to the user by default.
4. In a debate situation like this, if none of the involved parties is a Coordinator agent, then they could mutually agree upon who will respond. Or the system simply returns the last message.
-->

**Q3: Claim semantics**
When a coordinator "claims" the response, is that the agent's own decision (it decides it's best suited), or should the user have any say? Could two agents fight over a claim?

<!--
I think I already defined this above.
-->

**Q4: Scale**
Are we designing for 2 coordinators (the common case), or do you envision 3, 4, 5+ coordinators in a session? That changes how round-robin feels.

<!-- 
Honestly, I think getting more than one coordinator in any given session will likely be an accident, not a common occurance. I think you slightly misunderstood the idea behind this feature. The idea is pretty straight forward: Have agents (with different abilities and characters) argue and debate about something until they work it out. It is a problem-solving technique. There is no special reliance on "Coordinators".
-->

---

*Annotate each question above with your thoughts, then let me know when you're ready for Round 2.*

---
---
---

## Round 2 — Correcting My Mental Model

I had this backwards. Let me restate what I now understand, because if I'm still wrong I'd rather find out now than three files in.

### What This Feature Actually Is

It's not "a coordinator protocol." It's an **agent debate mechanism**. When a session has 2+ agents and a user message arrives, ALL of those agents see the message (they already do — that's how the scheduling works). The new behavior is: instead of each agent independently producing a response to the user, they first exchange perspectives with each other — debating, critiquing, building on each other's ideas — and then ONE of them delivers the final response.

The coordinator role is incidental to this. A coordinator happens to be the default tiebreaker for "who delivers the final response," but the feature itself works between any combination of agents. Two members debate? Fine — they agree who responds, or the system picks the last speaker.

### On "Round-Robin"

You're right to push back. All agents already receive the full conversation history — that's a given. And the current `SessionScheduler` already triggers all agents with pending refs. So the agents don't need to be "given turns" — they're all going to respond anyway.

The question is: what happens between "all agents see the user message" and "the user gets a response"? Right now, each agent independently responds, and the responses just pile up. The new behavior inserts a **deliberation phase** where agents talk to each other before anyone talks to the user.

But here's where I need your input. The current InteractionLoop runs one interaction per session at a time. So "all agents respond simultaneously" isn't what happens today — they're queued sequentially. The deliberation could work the same way: sequential turns, each agent seeing what the previous ones said. Or do you want actual parallelism (all agents think at the same time, merge perspectives after)?

<!-- 
I want the later: complete parallelism. This is what will happen at any Session level. Agents are essentially just "users"/actors in the same chat session. If a message is sent by an agent, user, or whatever actor, ALL parties in the session get it.

Now I am totally okay with building a "whisper" feature, where you direct a message ONLY at a certain participant (this could be useful for our "out-of-band" agent communication we were discussing in another feature). This would likely be a command, i.e. "/at @agent-name Only you can hear me..."

For now we would ignore who can read it (we might have better security in the future), and we just deliberately filter out such whispers to AI agents and their chat history (if it wasn't meant for them).

But ultimately, it a debate, they would go back and forth naturally, just because they were sending each other messages, and then responding (...and loop).

Keep in mind that a lot of the functionality of this app is by REQUESTING CERTAIN BEHAVIOR of the agent. So for example, we already have the hidden "Abilities" system we are working on, where an agent gets automatic and unseen prompt injections for instructions. We could do a similar thing when we start up the "debate". We could send instructions to both agents like: "You are both (all) here to figure out the following issue: X. I want you to debate this until you reach a conclusion, or have conclusively exhuasted all possible options. When you are done, please one of you respond with your result into the parent session (doing so would be automatically allowed in the permissions system FYI: this is cross-session posting, which is allowed by permission, but in this case we would preapprove the permission).
 -->

### Revised Understanding — Three Layers

1. **Streaming identity** (prerequisite) — SSE events carry agent identity so the client knows who's talking. This is useful regardless of whether deliberation exists.

2. **Agent deliberation** (the core feature) — When 2+ agents are in a session, user messages trigger a deliberation phase. Agents exchange `discussion` frames (visible or hidden, your call — you said "primarily internal but it'd be cool to watch"). After deliberation, one agent delivers the final response. Selection rules:
   - If a coordinator is present → coordinator responds (they're the tiebreaker)
   - If no coordinator → agents agree, or system picks last speaker
  
<!-- 
We don't need special frame types. All we are describing is a child session. It would be a child session "with insight" if we were able to "watch" the deliberation. It isn't anything special, with the possible exception of the initial instructions prompt we provide to all parties when it starts.
 -->

3. **Cross-session relay** (independent feature) — Forwarding streaming deltas when agents delegate across sessions. This doesn't depend on deliberation at all.

### Questions for Round 2

**Q5: Trigger condition**
When should deliberation activate? My original plan triggered on "2+ coordinators." Based on your feedback, should it trigger on "2+ agents (any role) in the session"? Or is there a threshold — maybe a session-level setting like `deliberationEnabled: true`?

<!-- 
It will start with a defined list of agents. It starts when they are all "present" (which would be instantly). In the future we might have the ability to have users or other actors join. For now, we won't worry about such complexities.
-->

**Q6: Deliberation visibility**
You said "primarily internal, but it'd be cool to watch." For V1, should discussion frames be:
- **Option A:** Hidden from the user (agents discuss internally, user only sees the final response)
- **Option B:** Visible but visually distinct (user sees a collapsible "Agents are deliberating..." section)
- **Option C:** Fully visible as regular messages (user watches the whole debate)

<!-- 
I'd like it to be both B and C. By default the message (special WebComponent for a child session, that is just a ChatView component inside a message bubble/as a frame [not a literal <frame>]) will be a simple "Agent Discussion..." type of message that is the collapsed state. The user can open this by tapping on it, and then see the discussion if they want to.
-->

**Q7: Deliberation mechanics**
Today, agents are invoked sequentially (one interaction at a time per session). During deliberation, should we:
- **Option A:** Keep sequential turns — Agent 1 speaks, Agent 2 sees what Agent 1 said and responds, Agent 1 sees Agent 2's response, etc. Natural conversation feel, but slower.
- **Option B:** Parallel first pass — All agents respond simultaneously to the user message, then a synthesis/merge step picks the best response. Faster, but agents don't build on each other's ideas.
- **Option C:** Something else you have in mind?

<!-- 
A wide open chat session, like any other session. Any agent can respond at any time. Any agents who are busy thinking simply have the response queued and fed to them when they are available next.
-->

**Q8: Termination**
How does deliberation end? Options I see:
- **Fixed round limit** (e.g., 3 rounds) — simple, predictable, but might cut off productive debate or waste rounds on a trivial question
- **Agent-initiated** — an agent signals "I'm satisfied, let's respond" (your original "claim" concept, but more like consensus)
- **Coordinator override** — if a coordinator is present, they decide when deliberation is done
- **Some combination?**

<!-- 
Agent satisfaction, or the inability to reach satisfaction (failure). We start the conversation with a set of instructions. We COULD also have a sane limit, so for example we might automatically shut it down after 100 correspondances (just to make sure we don't have an "Yes!", "No!", "Yes!", "No!" interaction eat all the user's tokens).
-->

**Q9: What about the user?**
Can the user intervene during deliberation? Send another message? Redirect the agents? Or is deliberation a "locked" phase where the user waits?

<!-- 
I'd like the user to be able to intervene, yes. Let me modify my original thoughts about the "collapsable view". Instead of a "collapsable view", let's have a "small" view, where the user can see the deliberation messages fly by, but only in a smallish chat bubble. If they tap on it, then they navigate to the child session directly, where they will then have their chat input field, and will be able to send a message. Pressing the "Back" button will properly go back to where the user was previously, as always.

Bonus points! 🌟: It would be really awesome if when this child session ChatView is tapped on inside the message bubble, if it would "expand" to fill the screen, as a dialog, but perfectly matching up with the layout of the parent session ChatView. When the user presses "Esc" or navigates Back, the ChatView will then shrink back down to be inside the message bubble again.
-->

---

*Annotate each question above, then let me know when you're ready for Round 3.*

---
---
---

## Round 3 — It's Just a Child Session

Your responses completely dismantled my mental model. And honestly? The thing you're describing is *simpler* than what I built. Let me state it plainly so you can tell me if I've finally got it.

### The Feature, Restated

**Agent deliberation = create a child session, invite the agents, inject instructions, let them chat.**

That's it. There is no orchestrator. There is no state machine. There is no "claim" mechanism. There is no special `discussion` frame type. There are no round-robin turns.

It's a child session. The same `session-link` frame we already built appears in the parent session. The agents are just participants in a regular chat session. They respond to each other naturally — message, response, counter-response — like any group chat.

<!--
Yes Silly! :P Do you see why it is important to plan, rather than just gallivant off?
 -->

The only "special" parts are:

1. **Initial instructions** — A system prompt injected when the session starts, telling agents what to debate and how to conclude (e.g., "When you reach consensus, post your result to the parent session using `postToSession`")
2. **Pre-approved permissions** — The `postToSession` permission for posting back to the parent is auto-approved, so agents can deliver results without a user permission prompt
3. **Safety limit** — A maximum exchange count (~100) to prevent runaway debates
<!-- 
We might also want a time-limit instead. We might want both. The idea of constraining sessions in meaningful ways is probably not one we should ignore, especially if sessions contain only agents.
 -->
4. **Inline preview** — The `session-link` bubble in the parent session shows a live mini-ChatView of the child session, with messages streaming by in real time. Tapping it navigates into the full child session where the user can participate.

### What's Already Built vs What's Needed

Here's where it gets interesting. A LOT of this already exists from our previous planning sessions:

**Already built:**
- Child sessions (`parentSessionID` + `session-link` frames) ✅
- Cross-session posting (`postToSession` tool) ✅
- `session-link` rendering in the parent chat ✅
- Navigation to child sessions ✅
- Streaming identity (SSE events carry `agentID`, `authorType`, `authorID`) ✅
- Cross-session stream relay (`StreamRelay` class) ✅
- Participant lifecycle (`addParticipant` with `participant-joined` frames) ✅

<!-- 
This feature is why I was moving in this direction! :P
 -->

**Needs building:**
1. **Parallel interactions** — This is the elephant. `InteractionLoop` currently runs ONE interaction per session at a time (`_active` Map keyed by `sessionID`). For agents to chat freely in a session, multiple agents need to be executing concurrently within the same session. This is a fundamental architectural change.
<!-- 
Yes, but PROBABLY not as much as you think. We still need an "InteractionLoop", it will simply live at the "agent" or "plugin/agent" level. I bet most of what you built is still valid. We just need to deliver messages to and from an interface of the InteractionLoop, and that interface will be the Session (FrameManager).
 -->
2. **Debate trigger mechanism** — Something (a command? a tool? an automatic detection?) that creates the child session, invites agents, injects the debate instructions, and kicks things off.
<!-- 
Why not the existing "createSession" tool we already have, with an "initialInstructions"/"initalMessage" property?
 -->
3. **Live inline mini-ChatView** — The `session-link` currently renders as a static clickable card. You want it to show a live miniature chat view of the child session with messages streaming in real time.
<!-- 
Yeah, why not? This would be fun, and we likely already have the FrameManager for it in memory... if it becomes a performance concern in the future, then we could always throw a boolean at it to disable this functionality.
 -->
4. **Pre-approved permission grants** — A way to programmatically approve a specific permission (e.g., "this agent can `postToSession` to session X") without prompting the user.
<!-- 
Yes, but there might be some issues with this. Based on our current design, there will be no "user signature" (maybe it would be the original permission for the agent to start a child-session?) for the system to sign. Also, when we say "programmatically approve" it means we need to add a session-permission record into the database, because it can't be memory-only.
 -->
5. **Session exchange limit** — A configurable cap on total messages in a session, with auto-shutdown.
<!-- 
Yes, I like the idea of a timestamp, and a max messages/interactions count.
 -->
6. **Expand/shrink animation** (bonus) — Tapping the inline ChatView expands it to fill the screen as a dialog, Esc/Back shrinks it back.
<!-- 
Yes, simply move the live element into different locations of the DOM, without ever destroying the element instance.
 -->

### The Big Problem: Parallel Interactions

Let me be honest about this one, because it's the hardest part by far.

Today, `InteractionLoop.startInteraction()` checks `this._active.get(sessionID)` — if there's already an active interaction for that session, the new one is effectively blocked. The scheduler queues agents and triggers them one at a time via `SessionScheduler._triggerNext()`.

For a debate session to work as you describe — agents responding freely, concurrently — we need one of:

**Option A: Per-agent interaction slots**
Change `_active` from `Map<sessionID, interaction>` to `Map<sessionID, Map<agentID, interaction>>`. Multiple agents can have active interactions in the same session simultaneously. Each agent's generator runs independently. When Agent A commits a frame, Agent B's next iteration picks it up via FrameManager.

**Concern:** Race conditions on frame ordering. Two agents committing simultaneously could interleave frames in unexpected ways. FrameManager uses `order` (monotonic per session) — concurrent commits need atomic order assignment.

**Option B: Message queue model**
Don't change InteractionLoop at all. Instead, agents in a debate session operate on a message queue: when a new frame arrives, all agents with pending refs get triggered sequentially (as today), but each agent only produces ONE response per trigger (not a full multi-turn interaction). This mimics "concurrent" chat without actual parallelism — it's just very fast sequential turns.

<!-- 
Why add the artificial complexity? If the agent is not available, queue the new message for sending when it is available. If the agent is available, deliver it the new message. Rinse and repeat for all agents.

We are essentially chaning WHERE the InteractionLoop lives: at the agent level, NOT at the Session level. This means each agent becomes and InteractionLoop, with the FrameManager living outside that loop.
 -->

**Concern:** Feels artificial. If Agent A is taking 30 seconds to think, Agent B can't respond to anything until A finishes. That's not how chat works.

**Option C: Separate InteractionLoop per session (or per agent)**
Each debate session gets its own InteractionLoop instance, allowing truly independent execution. The main InteractionLoop handles normal sessions; debate sessions spin up lightweight loops.

**Concern:** Resource management, complexity, event routing.

I lean toward **Option A** but I want your take. This is the architectural decision that shapes everything else.

### Questions for Round 3

**Q10: What triggers a debate?**
How does the user (or system) initiate a debate session? Options:
- A command: `/debate @agent1 @agent2 "Should we use Redis or Postgres for caching?"`
- A tool: An agent decides it needs to debate with another agent and creates the session itself
- Automatic: Any multi-agent session automatically becomes a debate session
- A UI button: User clicks "Start Discussion" in a multi-agent session

<!-- 
"createSession" tool we already have, with a new "intialMessage" property, and "participants".
-->

**Q11: Parallel interactions — which option?**
Option A (per-agent slots in existing InteractionLoop), Option B (fast sequential, fake parallelism), or Option C (separate loops)? Or something else?

<!-- 
Read my other messages above please.
-->

**Q12: What about the code I already wrote?**
I implemented a `DiscussionOrchestrator` with round-robin turns, claim semantics, and a coordinator-centric state machine. Based on this conversation, that's the wrong approach entirely. The right approach is child sessions with natural chat. Should I:
- **Rip it out** and start fresh based on what we plan here
- **Keep the streaming identity + relay pieces** (those are still correct) and only rip out the orchestrator
- **Leave it for now** and build the correct thing alongside it, cleaning up later

<!-- 
We will worry about this when our plan is fully complete. WE ARE NOT focused on code right now. We are focused on PLANS. Don't get distracted.
-->

**Q13: Scope for V1 of this feature**
You described a lot: live inline mini-ChatView, expand/shrink animation, user participation, whisper commands. For V1, what's the minimum that would make you happy? My suggestion for minimum viable:
1. Streaming identity (done)
2. Cross-session relay (done)
3. Debate trigger (command or tool)
4. Parallel interactions (the hard part) <!-- I doubt this is as difficult as you are making it out to be -->
5. Child session appears as existing `session-link` card (no live preview yet)
6. User navigates into child session to observe/participate

The live inline preview and expand/shrink animation would be Phase 2. Thoughts?

<!--
I agree.
 -->

---

*Annotate each question above, then let me know when you're ready for Round 4.*

---
---
---

## Round 4 — Per-Agent Interaction Loops and Session Constraints

Yes, I do see why planning matters. Lesson internalized. Moving on.

### The Architecture: InteractionLoop Is Per-Agent

Your inline comment cracked it open for me. The shift isn't "how do we make the InteractionLoop handle parallelism" — it's "the InteractionLoop was always conceptually per-agent, we just happened to key it by session."

**Current model:**
```
Session ←→ InteractionLoop (1:1, keyed by sessionID)
                ↓
            Agent generator
```

**Correct model:**
```
Session ←→ FrameManager (shared bus)
              ↑        ↑
         Agent A's    Agent B's
         loop         loop
```

Each agent runs its own interaction loop independently. The FrameManager is the communication surface — it's where frames land and where agents read from. When Agent A commits a frame, it goes into the FrameManager. Agent B's loop detects new frames (via its ref) and gets triggered. Agent A might still be "thinking" when B responds. Both loops run concurrently.

Practically, this means the `_active` map key changes from `sessionID` to `${sessionID}:${agentID}`. The InteractionLoop class itself mostly stays the same — the generator-based model, the event emission, the tool execution — all still valid. The scheduler just needs to allow concurrent triggers for different agents in the same session.

**One concern I want to flag:** Frame ordering. Today, `FrameManager.merge()` assigns monotonic `order` values. If two agents commit simultaneously, we need atomic order assignment so frames don't collide. SQLite serializes writes naturally (WAL mode, single-writer), so this might be a non-issue in practice. But if we ever move to a multi-process model, it matters. Worth a comment in the code, not worth engineering for now.

Does this match what you had in mind?

<!-- 
Good thinking. Our long-term vision is to use PostgreSQL... so this still won't be a problem.
-->

### Session Constraints

You mentioned both message count AND time limit. Let me flesh this out, because "constraining agent-only sessions" is a broadly useful concept.

**Session constraints model:**

```javascript
// On Session model (or a related config)
constraints: {
  maxMessages:     100,     // null = unlimited
  // Response from user: Yes, but let's be clear on what "message" means here. I am counting "interactions" as "messages"... we should probably name this "maxInteractions" so we don't cause confusion.
  maxDurationMs:   300000,  // 5 minutes, null = unlimited
  // Response from the user: No, I don't like this interface design. Let's do an "endsAt" timestamp.
}
```

When either limit is hit:
1. A system frame is created: `{ type: 'session-constrained', content: { reason: 'max_messages' | 'timeout', limit: 100 } }`
2. No further agent interactions are started in this session
3. Existing in-flight interactions are allowed to complete (don't kill a mid-response agent)
4. The session isn't archived or deleted — it's just "closed for new interactions"

<!-- 
Yes, and actually, our "archived" system does exactly this, flags it archived, and prevents further interaction.
 -->

**Where constraints are checked:**
- `SessionScheduler`, before triggering an agent: check message count and session age
- A background timer (or lazy check on next trigger) for the time limit

<!-- 
Probably at the commit level on the Session.
 -->

**Where constraints are set:**
- `createSession` tool gets a `constraints` parameter
- For debate sessions, sensible defaults are injected automatically (e.g., `maxMessages: 100, maxDurationMs: 300000`)
- Users could adjust via API or a future settings UI

**Question:** Should the agent be warned when it's approaching the limit? e.g., "You have 10 messages remaining in this session." Injected as a system prompt addition when count > 90% of max?

<!-- 
Yes, absolutely. I was just thinking of this myself. It would also show up for time: "You have 5 minutes remaining"
-->

### Pre-Approved Permissions

You raised a real issue. The permission system today works like this:
1. Agent requests a tool use → `permission-request` frame created
2. User approves → `permission-granted` frame created, signed by user's keystore
3. The signature proves the user authorized this specific action

For pre-approved permissions in a debate session, there's no user present to sign. Your suggestion of chaining from the original `createSession` permission is interesting:

**Approach: Permission inheritance from parent action**

When a user approves "Agent X can create a child session with agents Y and Z," that approval implicitly grants:
- Agents Y and Z can `postToSession` back to the parent session
- Agents Y and Z can `readFromSession` from the parent session

The child session's permission records are created at session creation time, signed with a **system signature** that references the parent permission ID. The chain is:

```
User approves "createSession" for Agent X (user-signed)
<!-- 
NOTE: This could be an auto-approval.
 -->
  → System creates child session
  → System creates permission records for Y and Z (system-signed, references parent permission)
```

This means the permission record in the DB has:
- `grantedBy: 'system'` (instead of a user ID)
- `parentPermissionID: <the createSession approval ID>`
- `scope: { tool: 'postToSession', sessionID: <parent session ID> }`

The audit trail is: "System granted this because the user approved the parent session creation."

<!-- 
Yes, exactly what I was thinking.
 -->

**Alternative: Session-scoped blanket permissions**

Simpler approach: when a session is created as a child, ALL agents in that session automatically get `postToSession` and `readFromSession` access to the parent. No individual permission records needed — the relationship itself (`parentSessionID`) IS the permission. The permission check simply asks: "Is the target session the parent of my current session? If yes, allowed."

This is less flexible but covers the debate use case perfectly and requires zero new permission records.

Which approach feels right to you?

<!--
I don't really like this approach, because it makes system boundaries implicit instead of explicit. I also want everything to flow through the permissions system, as that simplifies security, and adds power to the system to build useful features and extensions later on.
 -->

### `createSession` Tool Extension

The trigger is simple: extend the existing `createSession` tool with `initialMessage`. Here's the refined spec:

**`createSession(options)` — updated:**
- `options.title` — session name (required)
- `options.participants` — array of agent names to invite (required for debate)
- `options.parentSessionID` — if provided, creates a child session (existing)
- `options.initialMessage` — **NEW.** A message injected as the first frame in the new session. For debates, this contains the instructions: "Debate the following topic... When done, use postToSession to deliver your conclusion."
- `options.constraints` — **NEW.** `{ maxMessages, maxDurationMs }`. Defaults applied for child sessions if not specified.

The `initialMessage` is just a regular `user-message` frame authored by the system (or by the creating agent). Nothing special about it — it's how the conversation starts.

**Question:** Who is the `author` of the initial message? Options:
- The agent who called `createSession` (makes sense for agent-initiated debates)
- The user (makes sense for user-initiated `/debate` commands)
<!-- This would actually be "/sessions create parentID:{parentId|this} ... and we can add more arguments later -->
- `system` (neutral)

<!-- 
Yes, I agree, and it also makes sense to make the "author" agent the Coordinator for the child-session. 
-->

### V1 Scope — Consolidated

Based on your agreement, V1 is:

1. **Per-agent interaction loops** — Change `_active` key to `sessionID:agentID`, allow concurrent agent interactions in a session
2. **`createSession` extension** — Add `initialMessage` and `constraints` parameters
3. **Session constraints** — Message count limit + time limit, checked by scheduler
4. **Pre-approved permissions** — However we resolve the approach above
5. **Child session renders as existing `session-link` card** — User clicks to navigate in, full participation available
6. **Streaming identity + relay** — Already done

**V2 (future):**
- Live inline mini-ChatView in session-link bubble
- Expand/shrink animation (DOM reparenting)
- Whisper/`@` targeting feature

<!-- 
Yes, agreed.
 -->

### Questions for Round 4

**Q14: Permission approach**
Inheritance from parent action (explicit permission records, audit trail) vs session-scoped blanket (parentSessionID relationship = permission)? I lean toward the blanket approach for V1 — simpler, covers the case.

<!-- Answered above -->

**Q15: Initial message author**
Creating agent, user, or system?

<!-- Answered above -->

**Q16: Agent warning near limits?**
Should agents get a system prompt injection when they're approaching session constraints (e.g., "10 messages remaining")?

<!-- Answered above (yes) -->

**Q17: Does this V1 scope feel right?**
Anything missing? Anything that should be cut?

<!-- Yes, but please change your perspective here from "V1" and "V2" to instead be "Phase 1" and "Phase 2" -->

---

*Annotate each question above, then let me know when you're ready for Round 5.*

---
---
---

## Round 5 — Consolidated Design

All decisions are resolved. Let me lay out the complete picture with every correction incorporated, then we can move to implementation steps and tests.

### Design Decisions — Resolved

| # | Decision | Resolution |
|---|----------|------------|
| 1 | What triggers deliberation? | `createSession` tool with `initialMessage` + `participants` |
| 2 | Parallel interactions | Per-agent interaction loops. `_active` key: `sessionID:agentID`. FrameManager is the shared bus. |
| 3 | Deliberation visibility (Phase 1) | `session-link` card in parent. Click to navigate into child session. |
| 4 | Deliberation visibility (Phase 2) | Live inline mini-ChatView. Expand/shrink via DOM reparenting. |
| 5 | Termination | Agent-initiated (consensus or failure). Safety: `maxInteractions` + `endsAt` timestamp. |
| 6 | User intervention | User navigates into child session and participates directly. |
| 7 | Permissions for child session agents | Inheritance from parent action. System-signed permission records referencing the `createSession` approval. Persisted to DB. |
| 8 | Initial message author | The agent who calls `createSession`. That agent also becomes coordinator of the child session. |
| 9 | Constraint enforcement | At the commit level on the Session, not in the scheduler. |
| 10 | Agent warnings near limits | Yes. System prompt injection for both interaction count and time remaining. |

### Session Constraints — Refined Model

```javascript
// On Session model
constraints: {
  maxInteractions: 100,                    // null = unlimited
  endsAt:          '2026-03-10T15:30:00Z', // null = unlimited
}
```

- `maxInteractions` counts completed interactions (agent turns), not individual frames
- `endsAt` is an absolute timestamp, set at creation time (e.g., `now + 5 minutes`)
- Checked at commit level — when a commit is about to happen, the session checks its own constraints
- When a constraint is hit: session is archived (reuses existing archival mechanism — already prevents further interaction)
- A `session-constrained` system frame is created before archiving, explaining why
- In-flight interactions complete; no new ones start
- Agent warnings injected into system prompt when approaching limits (e.g., 90% of maxInteractions, 1 minute remaining)

### Permission Inheritance — Refined

When `createSession` is approved (user-signed or auto-approved):

1. System creates the child session
2. System creates permission records for each invited agent:
   - `grantedBy: 'system'`
   - `parentPermissionID: <the createSession approval ID>`
   - `scope: { tool: 'postToSession', targetSessionID: <parent session ID> }`
   - `scope: { tool: 'readFromSession', targetSessionID: <parent session ID> }`
3. These are real DB-persisted permission records, queryable, auditable
4. The chain is traceable: "Why does Agent Y have postToSession access? Because the user approved Agent X creating this child session (permission ID: xyz)."

**Open question:** Should child session agents also get auto-approved `postToSession` to the child session itself? Or does that flow naturally because they're already participants?

<!-- 
They should get auto approved to post to the parent session ONLY if they were already in the parent sessio as participants when the child session was created.
-->

### `createSession` Tool — Final Spec

```
createSession(options)
  options.title            — string, required
  options.participants     — string[], agent names to invite
  options.parentSessionID  — string, optional (makes it a child session)
  options.initialMessage   — string, optional (first frame in the new session)
  options.constraints      — object, optional
    .maxInteractions       — number, null = unlimited
    .endsAt                — ISO timestamp, null = unlimited
```

- The creating agent is `authorType: 'agent'`, `authorID: <creating agent ID>` on the initial message frame
- The creating agent is set as coordinator (`role: 'coordinator'`) in the child session
- All other invited agents are members (`role: 'member'`)
- User command equivalent: `/sessions create parentID:{parentId|this} title:"Discussion" participants:@agent1,@agent2`

### Per-Agent InteractionLoop — What Changes

**`_active` map:**
- Current: `Map<sessionID, interaction>`
- New: `Map<string, interaction>` where key is `${sessionID}:${agentID}`

**`startInteraction(sessionID, params)`:**
- Current: rejects if `_active.has(sessionID)`
- New: rejects if `_active.has(${sessionID}:${params.agent.id})`
- Same agent can't have two concurrent interactions in the same session, but different agents can

**`SessionScheduler`:**
- Current: `_triggerNext()` pops one agent, checks `_active` by session
- New: `_triggerNext()` can trigger multiple agents concurrently, checks `_active` by session+agent

**Event emission:**
- All events already carry `sessionID` and `agentID` (thanks to streaming identity work). No changes needed.

**FrameManager interaction:**
- Each agent's ref tracks what it has processed. Concurrent commits from different agents interleave naturally. Order is guaranteed by SQLite/PostgreSQL write serialization.

### Phase 1 Scope

1. **Per-agent interaction loops** — `_active` key change, scheduler allows concurrent triggers
2. **`createSession` extension** — `initialMessage`, `constraints`, coordinator role assignment
3. **Session constraints** — `maxInteractions` + `endsAt` on Session model, commit-level enforcement, archival on constraint hit, agent warning prompts
4. **Permission inheritance** — System-signed permission records for child session agents, chained from parent `createSession` approval
5. **Child session as `session-link` card** — Existing rendering, click to navigate, full participation
6. **Streaming identity + relay** — Already done

### Phase 2 Scope (Future)

- Live inline mini-ChatView in session-link bubble
- Expand/shrink animation (DOM reparenting without element destruction)
- Whisper/`@` targeting feature

### Questions for Round 5

**Q18: Auto-approve within child session?**
Do agents in a child session need explicit permission records to interact within that session itself (post messages, use tools)? Or does being a participant inherently grant that? Today, agents in a session interact freely — the permission system gates tool use, not basic messaging. I assume this stays the same?

<!-- 
We should have the permissions boundary extend within a child session. So if the user has approved a tool use in the parent session, it will be approved in the child session as well. I am okay with simply making this a fundamental check in the permissions system if you want. We aso need any tool requests inside the child frame to be approved by a user in the parent frame. I wonder how we will figure this one out... crawl all the way up to the nearest "user" participated session? Or maybe that would get lost if it was also a sub-session? Oh... so many problems to think about!
-->

**Q19: Constraint defaults for child sessions**
Should child sessions get automatic default constraints (e.g., `maxInteractions: 100`, `endsAt: now + 10min`) even if the `createSession` call doesn't specify them? This is a safety net for agent-created sessions. Or should unconstrained be the default, trusting the creating agent's instructions?

<!--
Only if an agent creates the child session. 
-->

**Q20: Are we ready for implementation planning?**
If the design above looks right, I'd like to move to Round 6 where I lay out the concrete implementation steps, file changes, and test strategy — still planning mode, no code. Then you approve and we execute.

<!--
Hhmmmm... I think we still have some concerns about permission boundaries and tool use to work out.
 -->

---

*Annotate each question above, then let me know when you're ready for Round 6.*

---
---
---

## Round 6 — The Permission Boundary Problem

You're right — this needs to be worked out before we plan implementation. The permission question is actually two problems:

### Problem 1: Permission Inheritance (Downward)

**Scenario:** User approves `shell:execute` for Agent X in the parent session. Agent X creates a child session. Agent Y in the child session also wants to use `shell:execute`. Should it be auto-approved?

Your answer was yes: "if the user has approved a tool use in the parent session, it will be approved in the child session as well."

**How this works mechanically:** When checking permissions in a session, the permission system walks up the session tree:

```
checkPermission(agentID, toolName, args, sessionID):
  1. Check if permission exists for THIS session → found? approved.
  2. Get session's parentSessionID
  3. Check if permission exists in parent session → found? approved.
  4. Repeat up the tree until root (parentSessionID is null)
  5. Not found anywhere → not approved, need to request
```

This is a simple recursive/iterative lookup. The session tree is shallow (usually 1-2 levels deep). The permission records don't need to change — we just change WHERE we look for them.

<!--
Isn't there a way we could bulk-load this from the database? Or be smarter about how we query? I really would like an incredible level of depth reached with just an inch more effort, if possible.
-->

**Important nuance from your response:** The `postToSession` auto-approval to the parent only applies to agents who were ALREADY participants in the parent session. So: Agent X (in parent) creates child with Agent Y (NOT in parent) and Agent Z (in parent). Only Agent Z gets the auto-approved `postToSession` to the parent. Agent Y doesn't — it wasn't in the parent.

### Problem 2: Permission Requests (Upward)

**Scenario:** Agent Y in a child session wants to use `shell:execute`. It hasn't been approved in the child OR parent session. A permission request needs to be created. But there's no user in the child session. Where does the request go?

**Your instinct:** "crawl all the way up to the nearest user-participated session."

I think that's right, but let me lay out the mechanics and edge cases.

**Approach: Permission Request Relay**

When an agent in a child session needs approval for a tool that isn't already inherited:

1. Permission system walks up the session tree looking for the nearest ancestor session with a human participant
2. The `permission-request` frame is created in THAT ancestor session (where the user can see it)
3. The request carries context: which child session, which agent, which tool, what arguments
4. User sees something like: *"Agent Y (in 'Redis vs Postgres Discussion') wants to execute: `ls -la`"*
5. User approves → permission record created. **Question: in which session?** Options below.
6. Approval is communicated back down to the child session, unblocking the agent

**Where does the approval record live?**

- **Option A: In the ancestor session where the user approved.** The child session inherits it via the walk-up mechanism. This means the same tool is now approved for ALL child sessions under that ancestor.
- **Option B: In the child session specifically.** Only that child session gets the approval. Other child sessions still need to ask.
- **Option C: User chooses.** The permission prompt offers both: "Approve for this discussion only" vs "Approve for all sessions."

I lean toward **Option A** as the default (approve in ancestor, inherited by all children), with Option C as a future enhancement. Rationale: if a user approves `shell:execute` once, they probably don't want to be asked again for every sub-session.

What do you think?

<!--
I'd like to go with Option C, User Chooses... and I want to take this even one step further (what I am about to describe can be a future-plan):
In the agent settings (I have since decided on my own that we need to have per-actor memory contexts that are persisted to the database), we add a new option: "Danger Level and store it in this "agent memory" (custom JSON context for the agent) - ..." Where "Danger Level" is one of "Low", "Medium", "I don't give a ...". Low will ask for EVERY session/agent/command|tool/arguments combo is a permanent permissions entity (approval or denial) key/id.
"Medium" will allow the tool itself, with any arguments, and will allow other premiscuity, such as child-sessions gain full inheritance of their parent's permissions. Lastly, the final "super danger mode" simply allows everything.  
-->

### Edge Cases

**No user in the ancestry at all:**
The session tree is: Parent (agents only) → Child (agents only). No human participant anywhere. What happens?

I'd say: **permission denied.** If no human is reachable in the session hierarchy, no one can approve. The agent gets a denial frame: "No user available to approve this action." This is a safety feature — agent-only session trees can't escalate their own permissions without human oversight.

Does that feel right?

<!--
Yes, it does, especially for now. We might allow this in the future, but I would have concerns, such as infinite recursion. 
-->

**Deep nesting:**
Session A (user + Agent X) → Session B (Agent X + Agent Y) → Session C (Agent Y + Agent Z). Agent Z wants `shell:execute`. Walk-up finds the user in Session A (two levels up). The request appears in Session A with full context about the chain.

**Performance concern:** Walking up on every permission check could be slow if the tree is deep. But you said depth is usually 1-2 levels, and we can cache the "nearest user ancestor" for a session.

**Multiple users in ancestry:**
Session A has User1 and User2. Both are ancestors. Who gets the permission request? I'd say: create the request in the nearest ancestor that has ANY user, and any user in that session can approve. First come, first served.

<!--
The permissions frame needs to be in the same session as the tool use request, because the permissions approval/denial frame is a commit to the original tool request frame.
However, the permissions-request frame could go on the closest parent that has a user participant (or maybe in more advanced future logic, the user who is actually permitted to give approval).
This makes sense I think.

All applicable users get the permissions request, and any applicable user may successfully grant or deny the request. "Applicable" is a permissions feature that hasn't yet been completed, and needs to go into a "future-plan".
 
-->

### Permission Inheritance for `createSession` Itself

One more layer: when Agent X in a child session wants to create a GRANDCHILD session (depth 2), does the user need to approve again?

<!--
Yes. I am tempted to disallow it for now, because I am concerned of infinite recursion. However, I guess I am not against it as long as it always results in a permissions request (unless in "super dangerous" mode).
-->

Depends on how the original `createSession` permission was stored. If the user approved `createSession` with `type: 'sub-session'` in the parent — does that inherit to child sessions? Under the walk-up model, yes: the child session checks its own permissions, doesn't find `createSession`, walks up to parent, finds it, approved.

So agents in child sessions can create grandchild sessions without re-prompting, as long as the original user approved sub-session creation somewhere in the ancestry. This seems correct — the user trusted the agents to create sub-sessions.

But it also means an agent could theoretically create an infinite chain of sub-sessions. The constraint system handles this: agent-created child sessions get default constraints (`maxInteractions: 100`, `endsAt: now + 10min`), so runaway nesting burns out.

<!--
Yes, I am also concerned about issues... I think always request permission to create sub-sessions (unless in "super dangerous" mode). 
-->

### Revised Permission Model Summary

<!--
Note from user:
The following is an example of a "Medium" Danger Level permissions interaction.
A "Low" level would stop at the session boundary.
-->

```
Permission check flow:
  1. Check THIS session's permissions
  2. Walk up parentSessionID chain, checking each ancestor
  3. First match → approved
  4. No match → find nearest ancestor with a user participant
     → Create permission-request there
     → User approves → record created in that ancestor
     → Inherited by all descendants
  5. No user in entire ancestry → denied
```

```
Auto-approved permissions at child session creation:
  For each invited agent:
    IF agent was a participant in the parent session:
      → Create postToSession(parentSessionID) permission
      → Create readFromSession(parentSessionID) permission
    ELSE:
      → No auto-approvals for the parent
    ALWAYS:
      → Inherit all existing permissions from the ancestry
```

### Questions for Round 6

**Q21: Approval record location**
Option A (in ancestor, inherited by all children), Option B (in child only), or Option C (user chooses)?

<!--
HHHhmmmm... I think it needs to go in:
```
def closestParentWithAblePermitter() {
  for session in each parent.next() {
    if session.hasAblePermitter() {
      // there is someone in this session that is able to approve of this request.
      // place the permission approval frame here.
    }
  }
}

// Obviously "Allow Once"/"Deny Once" would place the permission approval/denial at the requesting frame
```
-->

**Q22: No user in ancestry**
Permission denied as safety default — agree?

<!--
Yes. 
-->

**Q23: Is the permission model now complete enough to move forward?**
If so, I'd like to do one more round consolidating everything (design + permissions + constraints) into a concrete implementation plan with file changes and test strategy. Still planning, no code.

<!--
Let's go one more round just to make sure we capture everything. 
-->

---

*Annotate each question above, then let me know when you're ready for Round 7.*

---
---
---

## Round 7 — Full Consolidation

Let me pull everything together into one clean picture. Every decision, every nuance, every correction from the last six rounds.

### Bulk-Loading the Session Ancestry

You asked if we can be smarter than iterative walk-up queries. Yes — a recursive CTE handles any depth in a single query:

```sql
-- Get full ancestry chain for a session
WITH RECURSIVE ancestry AS (
  SELECT id, parentSessionID, 0 AS depth FROM sessions WHERE id = :sessionID
  UNION ALL
  SELECT s.id, s.parentSessionID, a.depth + 1
  FROM sessions s
  JOIN ancestry a ON s.id = a.parentSessionID
)
SELECT * FROM ancestry ORDER BY depth;
```

Then permission check becomes one query against all ancestors:

```sql
SELECT * FROM permissions
WHERE sessionID IN (SELECT id FROM ancestry)
  AND toolName = :toolName
  AND (agentID = :agentID OR agentID IS NULL)
ORDER BY depth ASC
LIMIT 1;
```

Closest match wins. One query, any depth. Works in SQLite and PostgreSQL. We cache the ancestry chain per session (it doesn't change during a session's lifetime) so subsequent checks are just a `WHERE IN` against cached IDs.

For finding the nearest user ancestor:

```sql
SELECT a.id FROM ancestry a
JOIN participants p ON p.sessionID = a.id
WHERE p.participantType = 'user'
ORDER BY a.depth ASC
LIMIT 1;
```

Also cacheable.

<!--
Fantastic! 
-->

### The Two-Location Permission Model

You made a critical correction that I want to make sure I have right:

**Permission-request frame** → goes in the nearest ancestor session that has an "able permitter" (for now: any user). This is for *visibility* — the user needs to see the request.

**Permission-approval/denial frame** → stays in the SAME session as the tool use request. This is for *commit integrity* — the approval is a commit against the original request frame.

So the flow is:

```
1. Agent Y in child session requests shell:execute
2. permission-request frame created in child session (local record)
3. permission-request ALSO relayed to nearest ancestor with a user
   (appears in user's session as a notification/request)
4. User approves in their session
5. permission-granted frame created in CHILD session
   (committed against the original request)
6. "Allow Once" → approval stays in child session only
   "Allow Always" → additional permission record created in the
   ancestor session where the user approved (for inheritance)
```

This means the user gets two choices on every approval:
- **Allow Once / Deny Once** — record stays in the requesting session, one-time use
- **Allow Always / Deny Always** — record goes in the closest ancestor with an able permitter, inherited by all descendants

Does this match your intent?

<!--
Yes, this is what I was thinking in concept... but I wonder if creating multiple records is required. We simply tie a "frameID" to the approval record, right? Why would we care which session it lives in?
Now we DO care which sesion the frame lives in that prompts the user for permission... the "prompt" frame needs to go in the correct session.
But does the "prompt" frame and "answer" frame have to go together on the same session? Why would it matter if it crossed session boundaries? 
-->

### Danger Level (Future Plan)

Your "Danger Level" concept is a per-agent configuration stored in agent memory (persisted JSON context). Three levels:

| Level | Permission Inheritance | Approval Granularity | createSession |
|-------|----------------------|---------------------|---------------|
| **Low** | No inheritance. Each session/agent/tool/args combo requires explicit approval. | Most restrictive. Every unique combo. | Always ask. |
| **Medium** | Child sessions inherit parent permissions. Walk-up enabled. | Tool-level (any args accepted once tool is approved). | Always ask. |
| **Yolo** | Everything auto-approved. | N/A | Auto-approved. |

For Phase 1, we implement the **Medium** behavior as the default (since that's what our permission model describes). The Danger Level selector and per-agent memory context go into a future plan YAML.

<!--
Yes. I don't want the permissions system to get in the way. I also want it to get in the way in specific circumstances, or to go away entirely with a high level of trust. For now we can stick to Medium as a sane default until we implement this. Or should we implement it now, as part of these permission system updates?
-->

`createSession` is special: always requires explicit permission regardless of danger level (except Yolo). Even if `createSession` was approved in a parent session, child sessions must re-ask. This prevents infinite nesting without user awareness.

<!--
Correct. We can get this functionality simply by overloading the permissions class in the plugin, like we do for the Shell plugin. 
-->

### Complete Design Summary

Here is every piece of this feature, consolidated:

#### 1. Per-Agent Interaction Loops

- `_active` key: `${sessionID}:${agentID}` (not just `sessionID`)
- Multiple agents can have concurrent interactions in the same session
- Each agent's generator runs independently
- FrameManager is the shared communication bus
- Frame ordering guaranteed by database write serialization (SQLite WAL, PostgreSQL)
- SessionScheduler triggers multiple agents concurrently

#### 2. `createSession` Tool Extension

- New params: `initialMessage` (string), `constraints` (object)
- Creating agent becomes coordinator (`role: 'coordinator'`) of the child session
- All other invited agents are members (`role: 'member'`)
- `initialMessage` creates a `user-message` frame authored by the creating agent
- Agent-created child sessions get default constraints if none specified
- User command: `/sessions create parentID:{parentId|this} title:"..." participants:@a,@b`

#### 3. Session Constraints

- Session model gains: `maxInteractions` (integer, nullable), `endsAt` (timestamp, nullable)
- Checked at commit level on the Session
- When hit: session archived, `session-constrained` system frame created, in-flight interactions complete
- Agent warnings injected into system prompt at 90% of maxInteractions or 1 minute remaining
- Default constraints for agent-created child sessions: `maxInteractions: 100`, `endsAt: now + 10min`

#### 4. Permission Inheritance

- Permission checks walk up the session ancestry (bulk via recursive CTE)
- Ancestry chain cached per session
- `permission-request` frame: created locally AND relayed to nearest ancestor with an able permitter
- `permission-granted/denied` frame: created in the requesting session (commit integrity)
- "Allow Always": additional record in ancestor session (for inheritance)
- "Allow Once": record only in requesting session
- No user in ancestry → denied
- `createSession` always requires explicit permission (no inheritance)

#### 5. Auto-Approved Permissions at Child Session Creation

- For each invited agent that WAS a participant in the parent session:
  - `postToSession(parentSessionID)` — auto-approved
  - `readFromSession(parentSessionID)` — auto-approved
- System-signed, references parent `createSession` permission ID
- Agents NOT in the parent session get no auto-approvals for the parent

#### 6. Streaming Identity + Relay (Already Done)

- SSE events carry `agentID`, `authorType`, `authorID`
- `StreamRelay` forwards deltas across session boundaries
- Client supports per-agent typing indicators and streaming bubbles

#### Phase 1 Deliverables

| # | Feature | Status |
|---|---------|--------|
| 1 | Per-agent interaction loops | To build |
| 2 | `createSession` extension (initialMessage, constraints) | To build |
| 3 | Session constraints (maxInteractions, endsAt) | To build |
| 4 | Permission ancestry walk-up (recursive CTE) | To build |
| 5 | Permission request relay to nearest user ancestor | To build |
| 6 | Auto-approved permissions for child session agents | To build |
| 7 | Child session renders as `session-link` card | Already built |
| 8 | Streaming identity + relay | Already built |

#### Phase 2 (Future)

- Live inline mini-ChatView in session-link bubble
- Expand/shrink animation (DOM reparenting)
- Whisper/`@` targeting
- Danger Level selector (Low/Medium/Yolo)
- Per-agent memory context (persisted JSON)
- "Applicable permitter" logic (who specifically can approve)

#### Future Plans to Create

- `danger-level-permissions.yaml` — Danger Level selector, per-agent config
- `agent-memory-context.yaml` — Per-actor persisted JSON context
- `applicable-permitters.yaml` — Who can approve what, role-based approval

### Questions for Round 7

**Q24: Does this complete summary accurately capture everything?**
I want to make sure nothing was lost or misrepresented across six rounds of iteration.

<!--
I think we might still need a round or two. We are getting quite close though. 
-->

**Q25: Are we ready for implementation planning?**
Next round would be: concrete file changes, implementation order, and test strategy. Still planning mode.

<!-- Another round please -->

---

*Annotate above, then let me know when you're ready for Round 8 (implementation plan).*

---
---
---

## Round 8 — Simplifying Cross-Session Permissions + Danger Level Decision

Three open threads from your Round 7 annotations. Let me address each.

### Thread 1: Do Prompt and Answer Frames Need to Be in the Same Session?

Short answer: **No, they don't.** And your instinct points to a simpler design.

I went and read the current permissions implementation. Here's what actually happens today:

1. Agent calls a tool → `PermissionEngine.checkPermission()` runs (at `permission-engine.mjs:49-115`)
2. If approval needed → `PermissionHandler.hardBreak()` creates a `permission-request` frame AND a `pending-action` frame, both in the current session
3. InteractionLoop pauses (generator yields)
4. User sees the request, approves → `PermissionHandler.approve()` creates a `tool-result` frame, creates a permission rule record
5. InteractionLoop resumes

The key insight: **the permission rule record is NOT a frame.** It's a row in the permission rules table (managed by `PermissionEngine`). It has `scope`, `featureName`, `effect`, and `expiresAt`. The frames (`permission-request`, `pending-action`, `tool-result`) are just the interaction UX — they're how the agent and user communicate about the permission.

So for cross-session, the flow simplifies to:

```
1. Agent Y in child session calls shell:execute
2. PermissionEngine checks rules — walks up ancestry — no match
3. permission-request frame created in ANCESTOR session
   (where the user can see it)
4. pending-action frame stays in CHILD session
   (where the InteractionLoop is paused)
5. User approves in ancestor session
6. Permission rule record created in DB:
   - "Allow Once": scope = frame-level, tied to child session
   - "Allow Always": scope = session-level, sessionID = ancestor's
7. tool-result frame created in CHILD session
   (unblocks the paused InteractionLoop)
```

The "prompt" frame lives in the ancestor. The "answer" effect (the rule record) is just a database row — it doesn't "live" in any session. The `tool-result` frame lives in the child session where it's needed. No frame needs to cross session boundaries. Only the **notification** of the approval needs to travel back down — which is just an event or callback, not a frame.

This means:
- We do NOT need to create multiple records
- We do NOT need the answer frame in the requesting session
- The `permission-request` frame has a `pendingFrameID` pointing to the `pending-action` in the child session — that cross-session reference is just an ID in the content, which is fine
- The rule record has a `frameID` reference (your suggestion) — one record, references one frame

The only new thing we need is: **a way to relay the approval notification back to the child session's PermissionHandler** so it can create the `tool-result` frame locally and resume the generator. This is an event relay — similar to how `StreamRelay` works. When the user approves in the ancestor session, an event fires, the permission system in the child session picks it up, creates the local `tool-result` frame, and resumes the interaction.

Does this match what you were getting at?

<!--
You appear to be confused, and thinking about our old implementation of the code. Now that we have greatly improved the frame manager, this just becomes a commit, and everything else happens through the router automatically.
Are you saying something else that I don't understand?
-->

### Thread 2: Danger Level — Now or Later?

Here's my honest assessment:

**What we're building IS Medium behavior.** The permission walk-up, the ancestry inheritance, the "Allow Always propagates down" — that's Medium. We don't need to label it that way or add a selector to get the behavior.

**Low and Yolo are behavioral modifiers on top of Medium's infrastructure:**
- **Low**: Same infrastructure, but `checkPermission()` doesn't walk up. It only checks the current session's rules. Every session is its own island.
- **Yolo**: Same infrastructure, but `checkPermission()` returns `false` (no approval needed) immediately for everything.

So Low and Yolo are each ~5 lines of code in `PermissionEngine.checkPermission()`:

```javascript
// Pseudocode
if (dangerLevel === 'yolo')
  return false; // auto-approve everything

let ancestorIDs = (dangerLevel === 'low')
  ? [sessionID]                   // don't walk up
  : await getAncestryChain(sessionID); // Medium: walk up
```

**The real blocker for Danger Level isn't the permission logic — it's where to store the setting.** You mentioned per-agent memory context (persisted JSON). That's a separate feature (`agent-memory-context.yaml`). Without it, where does the Danger Level live? Options:

1. **On the Agent model** — add a `dangerLevel` column. Simple, but it's a global setting per agent, not per-session.
2. **On the Participant record** — `role` is already there, we could add `dangerLevel`. Per-session, per-agent. But it's coupling unrelated concerns.
3. **On the Session model** — a session-wide danger level. All agents in the session share it. Simplest for Phase 1.
4. **Defer** — build Medium as the only behavior, add the selector when per-agent memory context exists.

My recommendation: **Option 4 (defer).** The infrastructure we're building supports all three levels with minimal changes later. The actual differentiation is ~10 lines of code once we have somewhere to store the setting. Implementing it now means we need to also solve the storage problem, which drags in agent-memory-context — and that's scope creep.

But I recognize you might disagree. If you want it now, Option 3 (session-level) is the cheapest path.

<!--
Add an "agent.getConfig()" function that just returns a static obect for now. This object will contain a "riskLevel" key, with a "medium" value. At all call sites, we can throw an error for anything but "medium". This enables us to easily update it in the future, without the need for a full implementation right now.
-->

### Thread 3: `createSession` Permission via Plugin Overload

You're right — this is clean. The `ShellPermissions` class already demonstrates the pattern perfectly (at `shell/shell-permissions.mjs:19-51`). It extends the base `Permissions` class and overrides `matchesRule()`.

For `createSession`, the cross-session plugin would:

```javascript
// CrossSessionPermissions extends Permissions
matchesRule(rule, args, metadata) {
  // createSession ALWAYS requires explicit permission
  // No inheritance, no walk-up, always ask
  if (args.toolName === 'createSession')
    return false; // rule doesn't match → falls through to "needs approval"

  return super.matchesRule(rule, args, metadata);
}
```

Wait, actually — re-reading the `PermissionEngine` flow, the approach is even simpler. The tool itself can declare `riskLevel: 'critical'` which makes it ALWAYS require approval (line 56-57 in `permission-engine.mjs`). But that doesn't distinguish between "always ask" and "no inheritance" — `critical` still allows existing rules to match.

So the plugin overload is the right approach. The `CrossSessionPermissions.matchesRule()` would specifically prevent any existing `createSession` rules from matching via inheritance, forcing a new approval each time. This is exactly what you described.

### Updated Permission Flow — Complete

```
Permission check (Medium behavior):
  1. Tool riskLevel check (none → skip, critical → always ask)
  2. Load ancestry chain (recursive CTE, cached)
  3. Query rules across all ancestor sessions
  4. Plugin's matchesRule() filters (e.g., ShellPermissions for exact-match,
     CrossSessionPermissions for createSession-always-ask)
  5. First match → apply (allow/deny)
  6. No match → needs approval:
     a. Find nearest ancestor with user participant (cached)
     b. Create permission-request frame in that ancestor
     c. Create pending-action frame in requesting session
     d. InteractionLoop pauses
  7. User approves:
     a. Permission rule created (scope per Allow Once/Always)
     b. Approval event relayed to requesting session
     c. tool-result frame created in requesting session
     d. InteractionLoop resumes
  8. No user in ancestry → denied immediately
```

### Remaining Open Items

I think we're getting close. Here's what I believe is still unresolved:

1. **The approval relay mechanism** — how does the ancestor session's approval event reach the child session's PermissionHandler? Event bus? Direct callback? A "watcher" that polls?
2. **Auto-approved permissions at child creation** — we said agents already in the parent get `postToSession` access. Does this go through the same `matchesRule()` path, or is it a separate check?
<!--
I guess there isn't any reason we can't just overload the Permissions class in this plugin too. That way we could get this behavior as logic, instead of database records. I wonder which way would be more secure though...
-->
3. **Warning injection near constraints** — where exactly does the 90% / 1-minute-remaining check happen? In the context builder before each interaction? In the system prompt assembly?

<!--
We have already talked fairly extensively about "Abilities", and how we need a system to inject dynamic prompts into the message stream at the bot. This is to request the bot have certain behaviors.
We should be able to use such a system for exactly this purpose. We could always defer this nice-to-have to the future-plan when we have the underlying injection support we need.
-->

### Questions for Round 8

**Q26: Does the simplified permission frame model make sense?**
Prompt frame in ancestor, pending-action in child, tool-result in child, rule record in DB. No frames cross session boundaries — only a notification event does.

**Q27: Danger Level — defer to Phase 2 or implement now?**
I recommend deferring. The infrastructure supports it, the differentiation is minimal code, and the storage question drags in agent-memory-context.

**Q28: Approval relay mechanism**
How should the ancestor session's approval reach the child session? I'm leaning toward an event on the InteractionLoop (or a shared event bus) — similar pattern to StreamRelay. The PermissionHandler in the child session subscribes, waits for the event, then resumes.

<!--
I agree with all of these. Let me know what you think about my comments.
-->

---

*Annotate each question above, then let me know when you're ready for Round 9 or implementation planning.*

---
---
---

## Round 9 — Corrections, Resolved Threads, and Pre-Implementation Inventory

### Correction: The Approval Relay Is Just a Commit

You're absolutely right, and I was overcomplicating this. Let me restate it clearly so we're aligned.

When a user approves a permission in the ancestor session, `PermissionHandler.approve()` runs server-side. It already knows where the `pending-action` lives (via `pendingFrameID` in the permission-request's content). It executes the tool, then commits the `tool-result` frame into the **child session's FrameManager**. The child session's FrameRouter picks up the commit automatically, the SchedulingPlugin sees new unprocessed frames for the agent, and the InteractionLoop resumes.

No event relay. No special bus. No watcher. Just a commit to the right FrameManager, and the existing routing infrastructure handles the rest. Same mechanism that handles every other frame in the system.

The only new behavior is that `PermissionHandler.approve()` needs to commit to a **different session's FrameManager** than the one where the approval UI lives. Today it always commits to the same session. For cross-session permissions, it commits to the child session's FrameManager instead. That's a one-line change in where it resolves the FrameManager from.

### Resolved: `agent.getConfig()` Stub

Smart approach. Instead of deferring Danger Level entirely OR implementing it fully, we plant the interface:

```javascript
// On Agent model or a utility
getConfig() {
  return { riskLevel: 'medium' };
}
```

At every call site in the permission system where behavior would diverge by risk level:

```javascript
let config    = agent.getConfig();
let riskLevel = config.riskLevel;

if (riskLevel !== 'medium')
  throw new Error(`Unsupported risk level: ${riskLevel}`);

// ... Medium behavior (walk-up, inheritance, etc.)
```

This gives us:
- A documented extension point for future Danger Level support
- Zero storage question to solve now
- Every call site is marked and ready
- If someone tries to use Low or Yolo before it's implemented, they get a clear error instead of silent wrong behavior

### Resolved: Auto-Approved Permissions — Logic vs Records

You asked which is more secure: a Permissions class override (logic-based) vs DB records.

**Logic-based** (`CrossSessionPermissions.matchesRule()` checks "is this agent a participant in the parent session?"):
- Automatically revokes access if the agent is removed from the parent session — no stale records
- The participant record IS the authorization — it's the source of truth
- No records to manage, create, or clean up
- Not independently auditable (but the participant record serves as audit)

**DB records** (permission rule rows created at child session creation):
- Explicitly auditable — you can query "what permissions were granted and why"
- Can be individually revoked without removing the participant
- Can become stale — agent removed from parent but permission record lingers
- More moving parts, more cleanup needed

I lean toward **logic-based for the auto-approval check**, because:
1. The authorization is intrinsically tied to participant status — if you're in the parent, you can post back. If you're not, you can't. There's no scenario where you'd want one without the other.
2. Stale records are a real security risk. Logic-based checks can't go stale.
3. The `matchesRule()` override in `CrossSessionPermissions` would look something like:

```javascript
matchesRule(rule, args, metadata) {
  let { toolName, targetSessionID } = args;

  // Auto-approve postToSession to parent if agent is a parent participant
  if (toolName === 'postToSession' && targetSessionID) {
    let session         = metadata.session;
    let parentSessionID = session?.parentSessionID;

    if (targetSessionID === parentSessionID && metadata.isParentParticipant)
      return true; // rule matches → allowed
  }

  // createSession always requires explicit permission
  if (toolName === 'createSession')
    return false; // never match existing rules → forces new approval

  return super.matchesRule(rule, args, metadata);
}
```

Both the `createSession` always-ask AND the `postToSession` auto-approval live in the same Permissions class override. Clean, testable, no DB records.

The downside — no independent revocation — doesn't matter here because the action IS the relationship. Revoking "Agent Y can post to parent" without removing Agent Y from the parent session is a contradiction.

### Resolved: Warning Injection Deferred

Constraint warnings ("you have 10 interactions remaining", "1 minute left") depend on the Abilities system for dynamic prompt injection. We haven't built that yet. For Phase 1:

- **Constraints enforce**: session archived when `maxInteractions` or `endsAt` is hit ✅
- **Warnings deferred**: no "approaching limit" prompts until Abilities system exists

This goes into a future plan note.

### Pre-Implementation Inventory — What's Actually Changing

Let me lay out everything one more time, but now as a **concrete inventory of changes**, not design philosophy. Every item here is something we'll build.

#### New Code

| Item | Description |
|------|-------------|
| `agent.getConfig()` | Static stub returning `{ riskLevel: 'medium' }`. Extension point. |
| `CrossSessionPermissions` | Permissions class override in cross-session plugin. Handles `createSession` always-ask and `postToSession` parent-participant auto-approval. |
| Ancestry CTE query | Bulk-load session ancestry chain. Cached per session. Used by permission walk-up. |
| Nearest-user-ancestor query | Find closest ancestor with a user participant. Cached. Used for permission-request relay. |
| Permission walk-up in `PermissionEngine` | `checkPermission()` queries rules across all ancestor sessions (via cached ancestry), not just current session. |
| Cross-session `PermissionHandler.approve()` | Resolve FrameManager from `pendingFrameID`'s session, not the approval session. Commit tool-result to the correct (child) session. |
| `maxInteractions` + `endsAt` on Session | Two nullable columns. Checked at commit level (commitValidator). Archive on hit. |
| Per-agent `_active` key | Change from `sessionID` to `${sessionID}:${agentID}`. Allow concurrent agent interactions in same session. |
| `createSession` extension | Add `initialMessage` and `constraints` parameters. Creating agent → coordinator. |

#### Modified Code

| File | Change |
|------|--------|
| `permission-engine.mjs` | Walk-up ancestry chain, guard on `agent.getConfig().riskLevel` |
| `permission-handler.mjs` | Cross-session FrameManager resolution for approve/deny |
| `session/index.mjs` | Ancestry query methods, caching |
| `interaction/index.mjs` | `_active` key change to `sessionID:agentID` |
| `session-scheduler.mjs` | Allow concurrent triggers for different agents in same session |
| `cross-session/index.mjs` | `CrossSessionPermissions` class, `createSession` extension |
| Session model | `maxInteractions`, `endsAt` columns, commit validator |

#### NOT Changing (Phase 2 / Future)

| Item | Reason |
|------|--------|
| Live inline mini-ChatView | Phase 2 |
| Expand/shrink animation | Phase 2 |
| Whisper/`@` targeting | Phase 2 |
| Danger Level selector UI | Needs agent-memory-context |
| Low/Yolo risk level behavior | Behind `getConfig()` stub |
| Constraint warnings | Needs Abilities system |
| "Applicable permitter" logic | Future plan |

### Questions for Round 9

**Q29: Logic-based auto-approval for postToSession — does the security argument hold?**
My case: participant status IS the authorization, so logic-based can't go stale. Any concerns I'm missing?

<!--
I agree with you. Let's go logic based.
-->

**Q30: Is this inventory complete?**
I want to make sure I haven't dropped anything from the previous 8 rounds. If this list is right, the next step is implementation order and test strategy.

<!--
This all looks correct to me.
-->

**Q31: Ready for implementation planning?**
Next round would be: ordered implementation steps, test-first strategy, file-by-file changes. Still planning mode, no code.

<!--
Yes!
-->

---

*Annotate above, then let me know if we need another round or are ready for the implementation plan.*

---
---
---

## Round 10 — Implementation Plan

All design decisions are resolved. Here's the concrete implementation plan: ordered steps, file changes, test strategy. TDD throughout — tests first, then implementation.

### Step 0: Cleanup Wrong-Approach Code

Before building the right thing, remove the wrong-approach code from the earlier session. This is a targeted cleanup, not a rewrite.

**Remove:**
- `src/core/scheduling/discussion-orchestrator.mjs` — Delete entirely
- `spec/core/scheduling/discussion-orchestrator-spec.mjs` — Delete entirely
- `spec/core/scheduling/discussion-integration-spec.mjs` — Delete entirely (the `buildMessages` discussion-frame tests test dead code)

**Revert changes in:**
- `src/core/interaction/message-history.mjs` — Remove the `} else if (type === 'discussion') {` branch from `buildMessages()`. Discussion frames don't exist in the new design.
- `src/core/internal-plugins/scheduling/index.mjs` — Remove the coordinator-detection block that delegates to DiscussionOrchestrator.
- `src/client/components/kikx-session-page/kikx-session-page.mjs` — Remove the `if (frame.type === 'discussion')` rendering branch.

**Keep:**
- All streaming identity changes (Phase 1A-1C from original plan) ✅
- StreamRelay class and wiring ✅
- Participant `role` field ✅
- Multi-agent streaming display ✅

**Test:** Full suite pass after cleanup.

---

### Step 1: `agent.getConfig()` Stub

**Purpose:** Plant the interface for Danger Level without solving storage.

**File:** `src/core/models/agent-model.mjs`

Add instance method to `Agent`:

```javascript
getConfig() {
  return { riskLevel: 'medium' };
}
```

**Tests:** `spec/core/models/agent-config-spec.mjs`
- `getConfig()` returns object with `riskLevel: 'medium'`
- Return value is a fresh object each call (no shared mutation)

**Test:** Step 1 tests pass.

---

### Step 2: Session Constraints (`maxInteractions`, `endsAt`)

**Purpose:** Add constraint fields to Session model and enforce them at the commit level.

**File:** `src/core/models/session-model.mjs`

Add fields, bump version to 2:

```javascript
static version = 2;

// ... existing fields ...

maxInteractions: {
  type:         Types.INTEGER,
  allowNull:    true,
  defaultValue: null,
},
endsAt: {
  type:         Types.DATETIME,
  allowNull:    true,
  defaultValue: null,
},
```

**File:** `src/core/session/index.mjs`

In the commit validator (or wherever FrameManagers are created with validators):
- Before allowing a commit, check `session.maxInteractions` against current interaction count
- Before allowing a commit, check `session.endsAt` against `Date.now()`
- If constraint hit: create a `session-constrained` system frame, archive the session, reject the commit
- Only count agent-authored commits as "interactions" toward `maxInteractions`

**Tests:** `spec/core/models/session-constraints-spec.mjs`
- Session model accepts `maxInteractions` and `endsAt` fields
- Defaults are null (unconstrained)
- `maxInteractions: 0` is a valid constraint (immediate archive)
- `endsAt` in the past is a valid constraint (immediate archive)

**Tests:** `spec/core/session/constraint-enforcement-spec.mjs`
- Commit succeeds when under `maxInteractions` limit
- Commit rejected and session archived when `maxInteractions` hit
- Commit succeeds when before `endsAt`
- Commit rejected and session archived when past `endsAt`
- `session-constrained` frame created with reason
- User-authored commits don't count toward `maxInteractions`
- System-authored commits don't count toward `maxInteractions`
- Only agent-authored commits count
- Both constraints checked simultaneously — first hit wins
- Null constraints mean unconstrained (no check)
- In-flight interaction completes even after constraint hit (next commit rejected, not current)

**Test:** Step 2 tests pass + full suite regression.

---

### Step 3: Per-Agent Interaction Loops

**Purpose:** Change `InteractionLoop._active` key from `sessionID` to `${sessionID}:${agentID}`, enabling concurrent agent interactions in the same session.

**File:** `src/core/interaction/index.mjs`

Changes:
- Line 39: `this._active = new Map()` — no change (it's just a Map)
- Line 122: `if (this._active.has(sessionID))` → `if (this._active.has(${sessionID}:${agentID}))`
  - Need to extract `agentID` from `params.agent.id`
  - If no agent (user-initiated, no agent context), fall back to `sessionID` as key
- Line 233: `this._active.set(sessionID, ...)` → same key change
- Line 436: `this._active.delete(sessionID)` → same key change
- Line 451: `this._active.get(sessionID)` → same key change
- Line 464: `this._active.delete(sessionID)` → same key change
- Line 574: `this._active.has(sessionID)` → needs to check if ANY interaction exists for this session, or specifically for an agent. This is the `isActive(sessionID)` method — might need an `isActive(sessionID, agentID)` variant.

**File:** `src/core/scheduling/session-scheduler.mjs`

The scheduler already keys `_activeAgents` by `${sessionID}:${agentID}` (line 116). But `_triggerNext()` likely still triggers one at a time. Change to allow concurrent triggers — trigger ALL agents with pending refs, not just one.

**Tests:** `spec/core/interaction/per-agent-loop-spec.mjs`
- Two agents can have concurrent interactions in the same session
- Same agent cannot have two concurrent interactions in the same session
- Agent A's frames are visible to Agent B's next iteration
- `isActive(sessionID)` returns true if ANY agent is active
- `isActive(sessionID, agentID)` returns true only for that agent
- Cancelling one agent doesn't affect the other
- Interaction end for one agent doesn't block the other

**Tests:** `spec/core/scheduling/concurrent-trigger-spec.mjs`
- `onCommit` schedules multiple agents in a single call
- Each scheduled agent gets its own trigger
- Agent that authored the commit is still skipped
- Already-active agent is still skipped
- Multiple agents triggered concurrently reach their generators

**Test:** Step 3 tests pass + full suite regression.

---

### Step 4: Session Ancestry Queries + Caching

**Purpose:** Enable permission walk-up by bulk-loading the session ancestry chain.

**File:** `src/core/session/index.mjs`

New methods on `SessionManager`:

```javascript
async getAncestryChain(sessionID)
// Returns array of session IDs from self to root: [sessionID, parentID, grandparentID, ...]
// Uses recursive query via Mythix ORM (or iterative if ORM doesn't support CTE)
// Results cached per sessionID (ancestry doesn't change during a session's lifetime)

async getNearestUserAncestor(sessionID)
// Returns the closest ancestor session ID that has a user participant
// Uses ancestry chain + participant check
// Results cached per sessionID
```

Cache: simple `Map<sessionID, ancestorIDs[]>` on `SessionManager`. Cleared when session is created or deleted. No TTL needed — ancestry is immutable.

**Tests:** `spec/core/session/ancestry-spec.mjs`
- Root session returns `[self]`
- Child session returns `[self, parent]`
- Grandchild returns `[self, parent, grandparent]`
- Deep chain (5 levels) returns correct order
- Cache returns same result on second call without re-querying
- Cache invalidation on session creation/deletion
- Session with no parent returns `[self]`
- Non-existent session throws

**Tests:** `spec/core/session/nearest-user-ancestor-spec.mjs`
- Session with user participant returns self
- Child session with no user returns parent (which has user)
- Deep chain finds user 3 levels up
- No user in entire chain returns null
- Multiple users — returns nearest ancestor, not deepest
- Cache hit on second call

**Test:** Step 4 tests pass + full suite regression.

---

### Step 5: Permission Walk-Up in PermissionEngine

**Purpose:** `checkPermission()` queries rules across all ancestor sessions, not just the current session.

**File:** `src/core/permissions/permission-engine.mjs`

Changes to `checkPermission()` (line 49-115):

1. After existing `riskLevel` checks (lines 54-59), add:
   ```javascript
   let agent  = options.agent;
   let config = (agent && typeof agent.getConfig === 'function') ? agent.getConfig() : { riskLevel: 'medium' };

   if (config.riskLevel !== 'medium')
     throw new Error(`Unsupported risk level: ${config.riskLevel}`);
   ```

2. Replace the current single-session query (lines 62-66) with ancestry-aware query:
   ```javascript
   let sessionManager = this._context.getProperty('sessionManager');
   let sessionID      = options.scopeID;
   let ancestorIDs    = (sessionManager && sessionID)
     ? await sessionManager.getAncestryChain(sessionID)
     : [];

   // Query rules across all ancestor sessions
   let query = PermissionRule.where
     .organizationID.EQ(organizationID)
     .featureName.EQ(featureName)
     .scope.EQ('session')
     .scopeID.IN(ancestorIDs);
   ```

3. Add proximity ordering — rules from closer ancestors win over distant ones.

**Tests:** `spec/core/permissions/permission-walkup-spec.mjs`
- Rule in current session matches
- No rule in current session, rule in parent matches (walk-up)
- No rule in current or parent, rule in grandparent matches
- Closer ancestor's rule wins over distant ancestor's rule
- `deny` rule in closer ancestor overrides `allow` in distant ancestor
- `allow` rule in closer ancestor overrides `deny` in distant ancestor
- No rules in any ancestor → needs approval
- Unsupported risk level throws error
- Agent without `getConfig()` defaults to medium
- Walk-up disabled when no sessionManager available (graceful fallback)

**Test:** Step 5 tests pass + full suite regression.

---

### Step 6: `CrossSessionPermissions` Class

**Purpose:** Two behaviors in one Permissions override:
1. `createSession` always requires explicit approval (no rule matching)
2. `postToSession` to parent auto-approved if agent is a participant in the parent

**File:** `src/core/internal-plugins/cross-session/cross-session-permissions.mjs` (NEW)

```javascript
export class CrossSessionPermissions extends Permissions {
  matchesRule(rule, args, metadata) {
    // createSession: never match existing rules → always forces new approval
    if (args.toolName === 'createSession')
      return { matches: false };

    // postToSession to parent: auto-approve if agent is parent participant
    if (args.toolName === 'postToSession' && args.targetSessionID) {
      let session         = metadata.session;
      let parentSessionID = session?.parentSessionID;

      if (args.targetSessionID === parentSessionID && metadata.isParentParticipant)
        return { matches: true, effect: 'allow' };
    }

    return super.matchesRule(rule, args, metadata);
  }
}
```

**File:** `src/core/internal-plugins/cross-session/index.mjs`

- `CreateSessionTool.getPermissionsClass()` returns `CrossSessionPermissions`
- `PostToSessionTool.getPermissionsClass()` returns `CrossSessionPermissions`
- Wire `metadata.isParentParticipant` into the permission check context

**Tests:** `spec/core/internal-plugins/cross-session/cross-session-permissions-spec.mjs`
- `createSession` never matches any existing rule (always asks)
- `createSession` with exact matching rule still doesn't match
- `postToSession` to parent auto-approved when agent is parent participant
- `postToSession` to parent NOT auto-approved when agent is NOT parent participant
- `postToSession` to non-parent session falls through to normal matching
- `readFromSession` falls through to normal matching
- Other tools fall through to `super.matchesRule()`

**Test:** Step 6 tests pass + full suite regression.

---

### Step 7: Cross-Session Permission Approval

**Purpose:** When a permission request originates in a child session but the user approves in an ancestor, `PermissionHandler.approve()` needs to resolve the correct FrameManager.

**File:** `src/core/interaction/permission-handler.mjs`

Changes to `approve()` (line 106-171):
- Currently `waiting.frameManager` is the FrameManager from the session where the request originated — this is already correct for the child session.
- The `permission-request` frame needs to be created in the ancestor session (nearest user ancestor), not the current session.

Changes to `hardBreak()`:
- When creating `permission-request` frame: look up nearest user ancestor via `sessionManager.getNearestUserAncestor(sessionID)`
- If found: create permission-request in THAT session's FrameManager
- If not found: deny immediately (no user in ancestry)
- The `pending-action` frame stays in the current (child) session's FrameManager

**Tests:** `spec/core/interaction/cross-session-permission-spec.mjs`
- Permission request in child session creates request frame in parent session (where user is)
- Pending-action frame stays in child session
- Approval creates tool-result in child session (not parent)
- Approval restarts interaction in child session
- No user in ancestry → permission denied immediately
- Permission request in root session (with user) → normal behavior (unchanged)
- Denial creates permission-denied frame in child session
- Multiple pending permissions across different child sessions don't interfere

**Test:** Step 7 tests pass + full suite regression.

---

### Step 8: `createSession` Tool Extension

**Purpose:** Add `initialMessage` and `constraints` to `createSession`, making it the trigger for agent deliberation.

**File:** `src/core/internal-plugins/cross-session/index.mjs`

Changes to `CreateSessionTool`:

1. Add to `inputSchema.properties`:
   ```javascript
   initialMessage:  { type: 'string' },
   constraints:     {
     type: 'object',
     properties: {
       maxInteractions: { type: 'number' },
       endsAt:          { type: 'string' }, // ISO timestamp
     },
   },
   ```

2. In `_execute()`:
   - Pass `constraints` to `sessionManager.createSession()` (which persists them on the Session model)
   - Set creating agent as coordinator: `addParticipant(sessionID, agentID, { role: 'coordinator' })`
   - Other participants added as members: `addParticipant(sessionID, agentID, { role: 'member' })`
   - If `initialMessage` provided: create a `user-message` frame authored by the creating agent as the first frame in the new session
   - If agent-created child session and no constraints specified: apply defaults (`maxInteractions: 100`, `endsAt: now + 10min`)

3. Auto-approval logic for parent participants:
   - Check which invited agents are participants in the parent session
   - For those agents: the `CrossSessionPermissions.matchesRule()` logic-based check handles the auto-approval (Step 6)

**Tests:** `spec/core/internal-plugins/cross-session/create-session-extended-spec.mjs`
- `initialMessage` creates first frame in new session
- `initialMessage` frame authored by creating agent
- `constraints.maxInteractions` persisted on session model
- `constraints.endsAt` persisted on session model
- Creating agent becomes coordinator in child session
- Other participants become members
- Agent-created child with no constraints gets defaults
- User-created child with no constraints stays unconstrained
- Session-link frame created in parent session (existing behavior preserved)
- Participants resolved by agent name (existing behavior preserved)
- Invalid participant name throws error (existing behavior preserved)

**Test:** Step 8 tests pass + full suite regression.

---

### Step 9: Integration Test + Full Suite

**Purpose:** End-to-end validation that all pieces work together.

**Tests:** `spec/core/integration/child-session-deliberation-spec.mjs`
- Agent creates child session with `initialMessage` and two participants
- Both agents receive the initial message and can respond concurrently (per-agent loops)
- Agent in child session posts result to parent session via `postToSession` (auto-approved)
- `createSession` requires user approval (always-ask)
- Session archives when `maxInteractions` hit
- Session archives when `endsAt` passed
- Permission request in child session appears in ancestor session with user
- Full test suite pass (all existing tests + all new tests)

---

### Implementation Order Summary

| Step | Description | Dependencies | New Tests |
|------|-------------|-------------|-----------|
| 0 | Cleanup wrong-approach code | None | 0 (removing tests) |
| 1 | `agent.getConfig()` stub | None | ~3 |
| 2 | Session constraints | None | ~15 |
| 3 | Per-agent interaction loops | None | ~12 |
| 4 | Ancestry queries + caching | None | ~12 |
| 5 | Permission walk-up | Step 1, 4 | ~10 |
| 6 | CrossSessionPermissions | Step 5 | ~8 |
| 7 | Cross-session permission approval | Step 4, 6 | ~10 |
| 8 | `createSession` extension | Step 2, 3, 6 | ~12 |
| 9 | Integration test | All | ~8 |
| | **Total new tests** | | **~90** |

Steps 1-4 have no interdependencies and can be implemented in any order (or in parallel by sub-agents). Steps 5-8 have dependencies as noted. Step 9 is last.

### Future Plan YAMLs to Create

After implementation, create:
- `bot-docs/future-plans/danger-level-permissions.yaml` — Low/Medium/Yolo selector, storage in agent-memory-context
- `bot-docs/future-plans/agent-memory-context.yaml` — Per-actor persisted JSON context (replaces `getConfig()` stub)
- `bot-docs/future-plans/applicable-permitters.yaml` — Role-based approval (who can approve what)
- `bot-docs/future-plans/constraint-warnings.yaml` — Agent prompt injection for approaching limits (depends on Abilities system)
- Update `bot-docs/future-plans/inter-agent-streaming.yaml` — Mark Phase 1 items as done
- Update `bot-docs/future-plans/multi-coordinator-protocol.yaml` — Rewrite to reflect child-session design

### Questions for Round 10

**Q32: Does this implementation order make sense?**
Steps 1-4 are independent foundations, 5-8 build on them, 9 validates everything.

**Q33: Test count and coverage — anything missing?**
~90 new tests across 10 spec files. Each step has its own spec targeting specific behaviors.

**Q34: Ready to execute?**
If this plan looks right, I'll update TODO.md with these steps and start implementing (Step 0 first). Still in planning mode until you say go.

<!--
Before this plan is complete, don't we actually need to update the plan YAML file?

This all looks really good. I agree with all of it. Good job focusing on tests this time. :)
-->

---

*Annotate above. If the plan looks right, tell me to execute and I'll start building.*

---
---
---

## Round 10B — Plan YAMLs

You're right — the YAMLs are part of the plan. The current `multi-coordinator-protocol.yaml` describes the wrong design (orchestrator, round-robin, claims). It needs a full rewrite. The `inter-agent-streaming.yaml` is accurate for the streaming parts but needs a note about what's coming next.

I also need to draft the new future-plan YAMLs we identified during planning.

### Rewrite: `multi-coordinator-protocol.yaml`

The filename itself is wrong — it's not a "multi-coordinator protocol" anymore. It's "agent deliberation via child sessions." I'd rename it to `agent-deliberation.yaml`.

```yaml
# Agent Deliberation via Child Sessions
# Status: PLANNED (Phase 1)
# Priority: High
# Complexity: High

summary: >
  Agents debate and deliberate by chatting freely in a child session.
  An agent creates a child session with participants and initial instructions,
  agents interact concurrently via per-agent interaction loops, and results
  are posted back to the parent session. No orchestrator, no state machine —
  just a regular session with constraints and permission inheritance.

prerequisites:
  streaming_identity:
    status: IMPLEMENTED
    description: >
      SSE events carry agentID, authorType, authorID. Per-agent typing
      indicators and streaming bubbles on the client.
    yaml: inter-agent-streaming.yaml

  participant_roles:
    status: IMPLEMENTED
    description: >
      Participant model has role field (coordinator/member). Creating
      agent becomes coordinator of child session.
    files:
      - src/core/models/participant-model.mjs

  cross_session_tools:
    status: IMPLEMENTED
    description: >
      createSession and postToSession tools exist in cross-session plugin.
      StreamRelay forwards deltas across session boundaries.
    files:
      - src/core/internal-plugins/cross-session/index.mjs
      - src/core/scheduling/stream-relay.mjs

phase_1:
  agent_config_stub:
    description: >
      agent.getConfig() returns static { riskLevel: 'medium' }.
      Extension point for future Danger Level support. All call sites
      guard with throw on non-medium.
    files:
      - src/core/models/agent-model.mjs

  session_constraints:
    description: >
      Session model gains maxInteractions (integer, nullable) and endsAt
      (timestamp, nullable). Checked at commit level. Session archived
      when constraint hit. Agent-created child sessions get defaults
      (maxInteractions: 100, endsAt: now + 10min) if none specified.
    files:
      - src/core/models/session-model.mjs
      - src/core/session/index.mjs

  per_agent_interaction_loops:
    description: >
      InteractionLoop._active key changes from sessionID to
      sessionID:agentID. Multiple agents can have concurrent interactions
      in the same session. SessionScheduler triggers all agents with
      pending refs, not just one at a time.
    files:
      - src/core/interaction/index.mjs
      - src/core/scheduling/session-scheduler.mjs

  ancestry_queries:
    description: >
      SessionManager gains getAncestryChain(sessionID) and
      getNearestUserAncestor(sessionID). Bulk-loads via recursive query.
      Results cached per session (ancestry is immutable).
    files:
      - src/core/session/index.mjs

  permission_walkup:
    description: >
      PermissionEngine.checkPermission() queries rules across all
      ancestor sessions via cached ancestry chain. Closest match wins.
      Guards on agent.getConfig().riskLevel (Medium behavior only).
    files:
      - src/core/permissions/permission-engine.mjs

  cross_session_permissions:
    description: >
      CrossSessionPermissions extends Permissions base class.
      createSession always requires explicit approval (no rule matching).
      postToSession to parent auto-approved if agent is a participant
      in the parent session (logic-based, not DB records).
    files:
      - src/core/internal-plugins/cross-session/cross-session-permissions.mjs  # NEW
      - src/core/internal-plugins/cross-session/index.mjs

  cross_session_permission_approval:
    description: >
      PermissionHandler.hardBreak() creates permission-request frame in
      nearest ancestor session with a user participant. Pending-action
      stays in requesting session. Approval commits tool-result to
      requesting session's FrameManager. Router handles the rest.
    files:
      - src/core/interaction/permission-handler.mjs

  create_session_extension:
    description: >
      createSession tool gains initialMessage (string) and constraints
      (object with maxInteractions, endsAt). Creating agent becomes
      coordinator. initialMessage creates first frame authored by
      creating agent. Agent-created child sessions get default
      constraints if none specified.
    files:
      - src/core/internal-plugins/cross-session/index.mjs

phase_2:
  - Live inline mini-ChatView in session-link bubble
  - Expand/shrink animation (DOM reparenting without element destruction)
  - Whisper/@mention targeting
  - Constraint warning injection (depends on Abilities system)

tests:
  - spec/core/models/agent-config-spec.mjs
  - spec/core/models/session-constraints-spec.mjs
  - spec/core/session/constraint-enforcement-spec.mjs
  - spec/core/interaction/per-agent-loop-spec.mjs
  - spec/core/scheduling/concurrent-trigger-spec.mjs
  - spec/core/session/ancestry-spec.mjs
  - spec/core/session/nearest-user-ancestor-spec.mjs
  - spec/core/permissions/permission-walkup-spec.mjs
  - spec/core/internal-plugins/cross-session/cross-session-permissions-spec.mjs
  - spec/core/interaction/cross-session-permission-spec.mjs
  - spec/core/internal-plugins/cross-session/create-session-extended-spec.mjs
  - spec/core/integration/child-session-deliberation-spec.mjs

cleanup:
  remove:
    - src/core/scheduling/discussion-orchestrator.mjs
    - spec/core/scheduling/discussion-orchestrator-spec.mjs
    - spec/core/scheduling/discussion-integration-spec.mjs
  revert:
    - src/core/interaction/message-history.mjs        # remove discussion frame branch
    - src/core/internal-plugins/scheduling/index.mjs  # remove coordinator detection
    - src/client/components/kikx-session-page/kikx-session-page.mjs  # remove discussion rendering
```

### Update: `inter-agent-streaming.yaml`

Minor update — the streaming work is correctly marked as implemented. Just add a note linking to the deliberation plan:

```yaml
# Inter-Agent Streaming
# Status: IMPLEMENTED
# Implemented: 2026-03-10
# Priority: Medium
# Complexity: High

# ... (existing content stays the same) ...

related:
  - agent-deliberation.yaml  # Uses streaming identity + relay as prerequisites
```

### New: `danger-level-permissions.yaml`

```yaml
# Danger Level Permissions
# Status: PLANNED
# Priority: Medium
# Complexity: Medium

summary: >
  Per-agent risk tolerance configuration that controls permission inheritance
  behavior. Three levels: Low (no inheritance, every combo explicit),
  Medium (walk-up inheritance, tool-level approval), Yolo (auto-approve all).

depends_on:
  - agent-memory-context.yaml  # Storage for per-agent config

levels:
  low:
    description: >
      No permission inheritance across session boundaries. Each
      session/agent/tool/arguments combo requires explicit approval.
      Most restrictive.
    inheritance: false
    granularity: session + agent + tool + arguments

  medium:
    description: >
      Child sessions inherit parent permissions via walk-up.
      Tool-level approval (any arguments accepted once tool approved).
      Default behavior. Already implemented as the only behavior.
    inheritance: true
    granularity: tool-level

  yolo:
    description: >
      Everything auto-approved. No permission prompts. Use with caution.
    inheritance: true
    granularity: N/A (all auto-approved)

implementation:
  - agent.getConfig().riskLevel returns the level (stub returns 'medium')
  - PermissionEngine.checkPermission() branches on riskLevel
  - Low: ancestorIDs = [currentSessionID] (don't walk up)
  - Yolo: return false immediately (no approval needed)
  - UI: dropdown in agent settings panel
  - Storage: per-agent memory context (JSON)

special_cases:
  createSession: >
    Always requires explicit permission regardless of danger level
    (except Yolo). Enforced via CrossSessionPermissions plugin overload.
```

### New: `agent-memory-context.yaml`

```yaml
# Agent Memory Context
# Status: PLANNED
# Priority: Medium
# Complexity: Medium

summary: >
  Per-actor persisted JSON context stored in the database. Provides
  agent-specific configuration, preferences, and memory that persists
  across sessions. Replaces the static agent.getConfig() stub.

design:
  storage: >
    JSON column on Agent model (or separate AgentConfig table).
    Accessed via agent.getConfig() / agent.setConfig().

  contents:
    riskLevel: 'medium'        # Danger Level setting
    # Future: agent-specific preferences, learned behaviors, etc.

  access_pattern: >
    Read on interaction start (cached for interaction lifetime).
    Written via agent settings UI or API.
```

### New: `applicable-permitters.yaml`

```yaml
# Applicable Permitters
# Status: PLANNED
# Priority: Low
# Complexity: Medium

summary: >
  Role-based permission approval: not just "any user in the session"
  but "which specific users are authorized to approve this request."
  Currently all users in a session can approve any permission request.

design:
  current: >
    Any user participant in the nearest ancestor session can approve
    any permission request. First come, first served.

  future: >
    Permission requests carry metadata about what kind of approval is
    needed. Users have approval scopes (e.g., "can approve shell commands"
    vs "can approve session creation"). Only users with the matching
    scope see the request.
```

### New: `constraint-warnings.yaml`

```yaml
# Session Constraint Warnings
# Status: PLANNED
# Priority: Low
# Complexity: Low
# Depends on: Abilities system (dynamic prompt injection)

summary: >
  Inject warnings into agent system prompts when approaching session
  constraints. "You have 10 interactions remaining" or "1 minute left."
  Requires the Abilities system for dynamic prompt injection.

design:
  triggers:
    - 90% of maxInteractions reached
    - 1 minute before endsAt
  injection: >
    Via Abilities system — dynamic system prompt additions injected
    before each agent interaction. No frame creation, just prompt context.
```

### Step 0 Updated

Step 0 now includes:
1. Delete wrong-approach files
2. Revert wrong-approach changes in existing files
3. Rename `multi-coordinator-protocol.yaml` → `agent-deliberation.yaml` with new content
4. Update `inter-agent-streaming.yaml` with `related` link
5. Create 4 new future-plan YAMLs

### Questions for Round 10B

**Q35: Rename `multi-coordinator-protocol.yaml` → `agent-deliberation.yaml`?**
The old name describes the wrong feature. The new name matches the actual design.

<!--
Good thinking!
-->

**Q36: Do the future-plan YAMLs capture everything we deferred?**
Danger Level, agent memory context, applicable permitters, constraint warnings. Anything else?

<!--
I think we got it.
-->

**Q37: Now ready to execute?**

<!--
Yes Claude. Thank you for being so patient! Please commit and push before you start. I also want you to remain the Coordinator. Have sub-agents do the heavy lifting.
-->

---

*Annotate above. If the YAMLs look right and the plan is complete, tell me to execute.*
