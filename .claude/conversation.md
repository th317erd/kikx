Good afternoon! Ha! I asked you this message, and then walked away. I then went to bed, because I was sick and feeling terrible. But I first put a lot of thought into this, and now I come back, and you have had very similar
thoughts! I'd like to just drop into dialog for a moment, if we may.

First, I was thinking about "everything is a message". Let's strip the world back to a single fact: if everything were a message, and we left it that way (at its fundamental core), then we are building a brain-dead chat
application, where the only thing that can happen is "mail": you get a message, you send a message... you work on a conversation, you write a book... at the end of the day, it is just words, visable messages, a compilation, a
book... nothing more.

But, obviously we WANT something more. We want interactions. We want _reactions_. We want to do work, and _report back on the work done_. So, really, the question becomes "how do you turn messages into useful work?"

I think I might have an answer after thinking about this for nearly 24 hours now. I am going to use an analogy, and I wince just thinking about it, but it is a good analogy, and it flows well: React. First, I _hate_ React. I
think it is a terrible library, developed by stupid engineers, and I feel that it has very much negetively impacted our world (including adding thousands of tons of CO2 to the atmosphere through wasted CPU cycles). However, the
idea of a "declarative state machine" is our product in a nut-shell, and it has some really good fundamental parallels.

For example, let's think of every message itself as a React component: React components display things (i.e. just like messages), but they can also _do work_. They can accomplish something. They do this through the process of a
"state machine". Sure, that state machine is for updating visuals, but it is more than this: the visuals update when an AJAX request completes, when the user interacts with something, when "something happens". This is exactly
what we are doing: we have "visuals" (messages), which "have things happen". When those things happen, more things happen, including the generation of more messages.

So, now let's continue with this fundamental understanding. First, let's talk about the elephant in the room: the "hard break" of the permissions system. You mentioned it many times, and it also has me on the fence too. However,
I find confidence in my thoughts when I "draw contrast". I do this all the time in life. If you were thinking of an image editor, and the image was life, then I am constantly opening the "Brightness and Contrast" dialog, and I
am jacking the contrast to +100%. For example, if I jack the contrast on our permissions system, "removing" the process altogether (hypothetically, and just for the thinking process), then you have a NOOP permissions system: Agent
requests tool use -> permissions NOOP -> tool use continues. No problems. But, obviously, _this_ doesn't actually describe our permissions "system" very well. If we take the contrast down just one step, then this becomes Agent
requests tool use -> await -> tool use continues. This is better, but we still don't have a "permissions system"... we ARE however getting closer to understanding our "messages as a state machine" system. So, let's focus on the
next step, that is our problem (or at least a big part of it): HOW do we VERIFY permissions BEFORE we allow that "await" to proceed?

For example, that hypothetical chain of events could just be: agent posts a tool use request message -> a message is posted approving this tool use -> this posted message is the "event" that initiates the tool use -> the tool use
response is turned into a message -> a new message is "received" and fed to all interested parties (the agent in this case). NOW we have described the entire process with messages. However, the gotcha here is the AUTHORITY. We
can't just have ANYONE post a "tool use approved" message. We need _specific_ people to post the approval message.

Let's ignore that for just a moment however, and look at the fundamental pattern here:
user types a message (something happens, an event) -> agent thinks about message -> agent responds (something happens, an event) -> user thinks about message -> user responds (something happens, an event), agent thinks -> agent uses a tool (event) -> permissions request (responds, event) -> user answers permissions request (responds, event) -> ??? was this really the correct user??? -> tool fires (event) -> agent thinks -> agent responds (event)...

Everything is really event driven. Nothing happens without there first being an "event", even if that event is a timer firing, motion detected on a camera, a certain audio freqency played, etc...

But we have STATIC MESSAGES, how are we supposed to make those fire events? And how do we keep this whole thing secure, such that only certain people can answer a permissions prompt for example (the agent is not allow to answer its own prompt)?

Well, the key to the first problem is in events: everything happens at a time. This is where the React metaphor comes in. We just have all frame updates be an "event". They can even call "on{PropertyName}Changed" in the server, which would be routed to the plugins. If we have an "onChange" event, then the action was authorized and permitted by the server. The other thing we could do that would be cool might be to have signatures. We could move to a pub/private key, and any given user that acts ("events") will not only be authenticated by the server, but will also sign their change/frame. In the permissions example, the authorizing actor (agent, user, or other user) would sign their frame. Doing so, the server and all other parties can verify the truth with the public key. This is an interesting idea all on its own: essentially your key pair becomes your authentication and authority. But this is just me daydreaming that it could be a protocol that would work on any network, even the block chain (though that might be slow enough to make you want to cry).

In any case, the pattern now is very clear: we have a messaging system, that sends frames, and does a darn good job at tracking and merging them. The 'messages' or 'interactions' would then emmit events, when iteracted with. This might be true if an hml-prompt is in use for example. The user "submits" the form, and a new, signed frame is created, the "parent_id" is the "parent_id" of the "hml-prompt" interaction/message, and this frame provides the "value"s to the hml-prompt for the submitted fields. This is a "onChange" event, which causes the field (who are listening) to update themselves, and turn to a "success" green. Since this happened on the "interaction" (parent frame), the "Ignore / Submit" button container can also subscribe to this event, and hide itself when there is at least one value recorded.

Take another example, I tool use: the agent posts a message of type "tool". The only thing this type/name/content does is get matched via a router to the correct listeners. When the correct plugin gets matched (which might be plural) the plugin will generate output. This output will be collected, and will be turned into a message "Tool use in progress. Result will be posted later, with ID TOOL_AF8B23D98BC304." The request is wrapped in a permissions system gate, and the permissions system launches a dialog/inline prompts to ask the user if they wish to proceed. Now, the user responds with a signed frame, the server permits the change, and the "permit" goes from "false" to "true", and "onPermitChange" is fired (or `onChange(key, previousValue, newValue)`), the tool continues execution, and a response message (the output of the tool) is posted into the message stream/queue, like "Tool ID TOOL_AF8B23D98BC304 Run Complete, Response: ..." The agent then picks this up, and now successfully ran a tool, with a permissions prompt in-between, and no hard break (or rather, ALWAYS hard break).

Now, we DO have one problem. We don't necessarily want to hold "event bindings" in memory. This would be a nightmare for a number of reasons. We do want the system to remain stateless (which is a funny thing to say about a "state machine" :joy:). For this reason I was thinking the plugin system happens via routing. In the example above, the tool executing would have happened from a plugin, and so the plugin could have put routing properties on the message, for example a "TOOL_" prefix. It could even be stamped with a plugin id, or a category of plugins, or whatever. The point is that the message is fed through at least one plugin handler via routing when it is updated. Part of the routing can be which properties the plugin is listening for.

This keeps the state machine "stateless". When a frame is modified, the whole thing is loaded, the diff is applied, and "onChange" event(s) fired. These "events" fire along a "router" that runs the appropriate plugin methods (which might then supply output and post another message).

There are many things which is interesting with this concept, but one of the most interesting is that is is entirely multi-party and asynchronous (and stateless) from the get-go. Another interesting thing is that it can use pretty much any underlying network, you can have intermingled messages which are invisible to one party or another, you could have cross-channel posting (i.e. a DM bot posting into a channel, or visa-versa). So many things are possible with such a system! There are only a few key implementation details that we MUST get correct: frame state, changes and event routing, and publishing with identity and authority.

This also makes for an AMAZING way to implement the "Abilities" system I have been considering for so long. The Abilities have always been verbal guides for the agent(s). i.e The user says "I want you to do this task for me", the Abilities prompt then follows that up immediately by concatenating onto the message:

```
I want you to do this task for me

If this is a coding related request, then questions to ask yourself:
1. Have you thought about unit testing?
2. Have you fulled planned this out yet?
3. Do you need to stop and ask any clarifying questions?
```

The last part that is tacked on there is an "Ability". These are what come from the DM with the agent. Previous to this encounter, the user would have had a DM with the agent:

U: Hey, Claude, what I ask you a question related to code, I want you to conside the following questions?
1. Have you thought about unit testing?
2. Have you fulled planned this out yet?
3. Do you need to stop and ask any clarifying questions?

A: Got it! Updating my Abilities list ->
```
ABILITES:
U: Hey, Claude, what I ask you a question related to code, I want you to conside the following questions?
1. Have you thought about unit testing?
2. Have you fulled planned this out yet?
3. Do you need to stop and ask any clarifying questions?

... ability 2

... ability 3
```

We could also spin up a "meeting" session between agents, and they could talk to other without the user ever seeing anything (if we _wanted_ to hide it). The agent could invite another agent into the channel, the user approves the request, the agent enters the channel, the first agent (A) then sends a message to the second agent (B). We could have this interaction visible (certainly during debugging), or we could had it by having user visibility flags (or even encryption that can only be broken by the receiving party). In any case, B gets a message from A (event), A thinks, and responds (event), B receives response from A, and talks back, etc... until they both decide they have figured the problem out, and then they finally respond to the Coordinator Agent, who then responds to the user (or uses the response to make a decision, or run a tool).

If the system has the following features written really well, then I think we will have a rockstar system:
1. A frame/commit engine for reconstrucing exact historical states.
2. This frame/commit engine then BECOMES a queue. As we spoke before, each use knows which messages they having yet read by their respective "HEAD" commit for their personal "branch". They simply diff their HEAD and "current". That is the queue.
3. A really good event system, that routes frames through plugins, and on those plugins fires "onChange" methods, that recieve the entire frame, and can write messages (or parts of messages, as multiple plugins might match on any given frame/event).
4. A really solid authentication system, with signatures, and the ability to prove identity. We can in the future improve this with ACLs, for all sorts of things, to ensure only exactly what we want to have happen happens.


We can still have "phantom frames" for things we don't want to store (i.e. "agent is typing..."), or "thinking" messages.

We can have any type of GUI we want inside any message, as we support HTML, and our frame manager event engine will allow for anything a plugin supports.

BOOM! 💥 We have gold.

Thoughts?

---

<!-- ═══════════════════════════════════════════════════════════════════════════ -->
<!-- CONVERSATION BOUNDARY — 2026-03-06 — Claude's Response                    -->
<!-- ═══════════════════════════════════════════════════════════════════════════ -->

---

Alright. This is a lot, and it's *good*. Let me actually engage with it rather than just nodding along.

---

First — the uncomfortable thing I have to say: **we've already built most of this, we just didn't realize it yet.**

The frame/commit engine? Built. Agent refs as HEAD pointers for the "unread queue"? Built. The diff mechanism for "what hasn't this agent seen"? Built. Multi-agent sequential triggering via the orchestrator? Built. Frames as the persistence layer that survives process restarts? Built.

What we *haven't* built is the thing your entire vision hinges on: **the event layer on frame mutations**.

Right now, frames go into the commit log and... sit there. The interaction loop manually orchestrates everything — it's procedural. "Execute tool, create result frame, feed back to generator." Your vision flips this: frame mutations *are* the events. The system reacts to frame changes, not to procedure calls. The interaction loop stops being an orchestrator and becomes a *router*.

That's the paradigm shift. And it's a big one.

---

Let me push back on a few things, because you told me to act like a peer:

**1. The "stateless state machine" tension is real, not just funny.**

You wave this off with a joke, but it's actually the hardest design problem in your vision. When you say "load the frame, apply the diff, fire onChange, route to plugins" — that *is* state. The question is: where does the *continuation* live? When a tool starts executing (could take 30 seconds), what tracks that it's in-progress? The frame itself, sure — you'd have a status field that goes from `pending` → `executing` → `complete`. But what *process* is watching for the `pending → executing` transition? If the server restarts mid-execution, who picks it up?

The current system "solves" this poorly (generator in memory, hard-break on interruption). Your vision solves it *better* (frame state is persistent, events are derived from state transitions), but you'll still need a **recovery mechanism** — something that scans for frames stuck in `executing` status on startup and re-triggers them. This is solvable, but don't underestimate it.

<!-- 
Good thinking... the answer I think is quite simple: the plugins pick it up.

Now I immediately hear you saying "Whoa whoa whoa! You want to take THOUSANDS of frames and pump them back through this engine on every load?!"

And the answer, to your astonishment, is "YES!"... kinda

Really, the missing pieces is to send the LOADED frames back through the router. If the frame engine doesn't have a parent, it already silently drops the frame. So if we load at any boundary (even partial child frames), the engine still corrects itself.

So we load the "last 20 messages" when someone opens the Session in the browser. These 20 get fed back through the router. If a frame is done, it can deliberately mark a "done" property on the frame that get's saved. When this goes back through the router, the router could have a default short-circuit to ignore and stop processing "done" frames. However, this is just ONE filter, or property the router could use... plugins could handle other properties, and if they (for example) KNOW the frame is complete, even without a "done" property, the plugin could halt the routing, and cease processing.

So really, as I said, the answer to your "omg" question is "yes", but only on a very limited, and filtered level (a rejection at the router level is not much difference then a "continue" in a loop).

So the state is always the successfully commited state. Anything that is mid-flight simply get's picked up by a plugin, and treated as a brand new "onChange" event. Now the plugin ITSELF might store mid-flight properties, such as a progress for a file download (this makes me think we might want instant-write commits that don't fire events, or even ANY commit is allowed to bypass routing). This way, the plugin itself can optionally pick up on mid-flight frames, by storing its own data that it needs to do so.
 -->

**2. The React analogy is better than you think (and worse than you think).**

Better: the "declarative state machine" framing is exactly right. Frames declare state, plugins react to state changes, reactions produce new state. That's React's model. It's proven at scale.

Worse: React's biggest problem is *unnecessary re-renders* — cascading state changes that trigger more state changes that trigger more state changes. Your system will have the same problem. Agent posts tool-use frame → onChange fires → plugin creates permission-request frame → onChange fires → ... → user approves → onChange fires → tool executes → onChange fires → result frame created → onChange fires → agent picks it up → onChange fires → agent responds → onChange fires. That's a LOT of event cascading. You need circuit breakers, or you'll get infinite loops that make the ping-pong problem look quaint.

The `authorType !== 'user'` filter we just debugged? That's the *baby version* of this problem. In a fully event-driven system, you'll need a much more sophisticated model for "which frame mutations should trigger which plugins."

<!-- 
This is true. However, we have one difference going for us that React rarely (if ever) has: we have a full history of all changes committed. This means IF we have an event loop, we can easily debug it. This means we can also fairly easily detect such loops or other issues, and interject, or correct them, if needed.

To counter your claim here: Our current system isn't exactly very easily to debug and maintain either.
 -->

**3. The routing/matching model is where the real design work lives.**

You mention "routing properties" and "plugin matching" almost casually, but this is the core of the architecture. How does a plugin declare what it's interested in? Options:

- **By frame type** (`tool-call`, `permission-response`, etc.) — simple, but rigid
- **By properties** (any frame with `toolName` matching `shell:*`) — flexible, but complex matching
- **By lineage** (any frame whose parent is a `permission-request`) — powerful for the permission flow, but requires graph traversal
- **By subscription** (plugin explicitly subscribes to specific frame IDs) — stateful, violates "stateless" goal

You'll probably need a combination. And the routing engine needs to be *fast* — it fires on every frame mutation.

<!-- 
"By subscription" is not stateless. Plugins are always loaded into memory. They could register listener "selectors". Think of it like reverse CSS... the selector matches the event.

There are an infinite number of ways, but honestly, a Sizzle engine isn't a bad idea:
```
on(#frame-id) {
}

on(.permissions-request) {
}

on(.permissions-request [type=Shell]) {
}
```

This could fairly easily be optimized to be blazing fast.
 -->

**4. The signature/authority model is gorgeous but might be premature.**

Public/private key pairs for identity and authority is a beautiful idea. It makes the system trust-minimized — you don't need to trust the server, you verify the signature. But right now, you have a single server with a single database. The crypto adds complexity without solving a real problem *yet*. I'd mark this as "design for, but don't implement until multi-server or federation is on the roadmap." The important thing is that your frame schema has a `signature` field ready to be populated.

<!-- 
Fair point. As long as the server controls all input sources, and authenticates those sources, this really shouldn't be a problem on a federated server. We might still need a hard-wired set of properties, or a schema for frames, to let us know which "federated fields" are not to be touched. This also hints at a universal frame "merging" system that is security aware. Maybe?

I do agree with you however.
 -->

---

Now, the parts I'm genuinely excited about:

**The frame/commit engine AS the queue is brilliant.** We already have this. Agent refs are HEAD pointers. Diff from HEAD to current = unread messages. This means the "event system" doesn't need a separate queue infrastructure (Redis, RabbitMQ, etc.) — the commit log IS the queue. Each consumer (agent, plugin, UI) has its own cursor into the same log. This is essentially the Kafka model, but using your git-like commit system. It's elegant and it's already built.

**The Abilities system via DM sessions is clever.** It turns agent customization into a conversation rather than a configuration form. The agent summarizes its own abilities from natural language instructions. This is already partially implemented via `dmSummary` and `instructions` on the agent model. Formalizing it as an "Abilities" concept that gets injected into conversations is the natural next step.

**Multi-agent side-channels are powerful.** Agents inviting other agents into sub-conversations, working out a problem, and reporting back to a coordinator — this is genuinely novel for a chat system. And your architecture supports it naturally: it's just more sessions with more participants posting more frames. The visibility/encryption layer is the interesting part — you could have frames that are readable only by certain participants (encrypted to their public keys), creating genuine private channels within a shared session.

<!-- 
This could also be a "child session", if we decide we want to give Sessions a nullable "parent_id"... which is an interesting idea.

Either that or sessions are just top-level frames, and "interactions" are child-frames...

...now there is a mind-bending idea!
 -->

---

So where does this leave us concretely?

The system we have today is **the storage and scheduling layer** of your vision. What's missing is **the event routing layer** — the thing that turns frame mutations into plugin invocations. If we build that, the interaction loop simplifies dramatically:

1. Agent yields a tool-call → creates a `tool-call` frame
2. Frame creation triggers `onChange` → routes to tool plugin
3. Tool plugin checks permissions (creates `permission-request` frame if needed)
4. Permission frame mutation triggers `onChange` → routes to UI/notification
5. User response creates `permission-response` frame
6. Frame creation triggers `onChange` → routes back to tool plugin
7. Tool executes, creates `tool-result` frame
8. Frame creation triggers `onChange` → routes to agent (via its ref/queue)
9. Agent processes result, continues

No hard break. No generator destruction. No replay. Just frames and events.

The interaction loop becomes: "run the agent generator, and for each thing it yields, create a frame. When the frame system triggers events that produce results, feed them back to the generator."

That's... dramatically simpler than what we have.

<!--
Great! Let's keep discussing this.

Please, also keep in mind, that we have yet to launch this, and it is a pet project. If we need big refactors, that is not a big deal. Yes, I do know that "perfect" is always on the horizon... but I want to feel excited about my design, not unsure... and THIS design feels exciting!

I do greatly appreciate you pushing back... and those are some really good counter arguments you provide! Keep it coming!
 -->

---

<!-- ═══════════════════════════════════════════════════════════════════════════ -->
<!-- CONVERSATION BOUNDARY — 2026-03-06 — Claude's Response to Annotations     -->
<!-- ═══════════════════════════════════════════════════════════════════════════ -->

---

I see what you've done — annotated my response with inline counterarguments via HTML comments. That's a great format for async dialog. Let me respond to each one.

---

**On the recovery problem (your "YES, kinda" answer):**

You're right, and I was overthinking it. Re-feeding loaded frames through the router on startup is elegant precisely *because* of the property you described: a "done" frame hits the router, the router sees it's done, skips it. A stuck-in-progress frame hits the router, the plugin picks it up and resumes. The router doesn't need to know the difference — the *plugin* knows.

And your point about "instant-write commits that don't fire events" is important. You're describing two commit modes:
- **Reactive commits** — frame mutation triggers routing (the normal path)
- **Silent commits** — frame mutation persists state but doesn't trigger routing (progress updates, intermediate state, bookkeeping)

That's actually critical for preventing the cascading problem I warned about. A tool updating its progress 50 times during execution shouldn't fire 50 onChange events. Silent commits let plugins track their own state without creating noise.

**On debugging cascading events:**

Touché. "Our current system isn't exactly very easy to debug and maintain either." You're absolutely right. I was holding the proposed system to a higher standard than the current one. The commit history giving you a full audit trail of every event cascade is a *massive* advantage over the current system, where if a generator breaks mid-stream you're debugging in-memory state with console.logs — which is literally what we just did for three hours with the orchestrator.

**On the CSS selector routing — this is actually brilliant:**

I initially listed "by subscription" as violating statelessness, but you corrected me: plugins registering selectors at load time isn't stateful in the problematic sense. The selectors are static declarations, not runtime subscriptions. They're more like Express route definitions than WebSocket subscriptions.

The Sizzle-like syntax is genuinely clever:

```
on(#frame-id) { }                        // specific frame
on(.permissions-request) { }              // by type/class
on(.permissions-request [type=Shell]) { } // type + property match
```

This gives you all four of my proposed matching strategies in a single, familiar syntax:
- `#frame-id` = by subscription (specific frame)
- `.permissions-request` = by type
- `[toolName^=shell]` = by property
- `.permissions-request > .response` = by lineage

And it *is* optimizable. CSS selector engines are some of the most optimized matching code in existence. You could index by type (like a hash lookup on the "class"), then refine with property checks. The common case — matching by frame type — becomes an O(1) map lookup.

The question I'd push on: does the selector match against the *frame itself*, or against the *change event*? Because `on(.tool-call)` matching any tool-call frame is different from `on(.tool-call:created)` vs `on(.tool-call:modified)`. You probably want both — "this frame exists" vs "this frame just changed." Maybe pseudo-selectors: `:created`, `:modified`, `:deleted`?

<!-- 
Here I think you are conflating "events" in the common sense with "frame routing". 

"create" isn't meaningful -> onChange.previousValue == null for frame ID
"modify" isn't meaningful -> "onChange" already IS this.
"deleted" isn't meaningful -> onChange.newValue == null for frame ID
 -->

**On "sessions are just top-level frames, and interactions are child-frames":**

This IS mind-bending, and I want to sit with it for a moment. If sessions are top-level frames, then:

- Creating a session = creating a root frame
- A message in the session = a child frame
- A sub-conversation between agents = a child frame of the session frame, which itself has child frames (the agent messages)
- A tool call and its result = child frames of the agent message frame

Everything becomes a tree. The commit log tracks the tree. Refs point into the tree. The router matches anywhere in the tree.

This unifies session management and frame management into a single system. You wouldn't need a separate `sessions` table — sessions ARE frames with no parent. The `SessionManager` and `FrameManager` merge into one thing.

The implication is fractal: a "session" at one level is a "message" at a higher level. An agent's internal tool-call conversation is a session *within* a message *within* a session. You get nesting for free.

The scary part: tree traversal for routing becomes important. `on(.permissions-request)` needs to know whether to match globally or scoped to the current session-frame subtree. Probably scoped by default, global with a modifier.

<!-- 
I don't think this is exactly accurate here. A frame update is a frame update. All frames have ids. A plugin will always get exactly one "event" from one frame update. All loaded plugins CAN subscribe to this update, but that is N-plugins worst case, not N*N-frames. A plugin COULD decide to do whatever it wants with the "event", but this won't impact the router.

Did I misunderstand you? Or does this make sense?
 -->

But honestly? This is the kind of unification that makes architectures sing. One data structure. One engine. One routing system. Everything else is just plugins declaring what they care about.

---

I share your excitement. This design has the feeling of convergence — where multiple separate concerns (sessions, frames, events, plugins, permissions, multi-agent) collapse into a single unified model. That's usually a sign you've found the right abstraction.

The four pillars you identified are exactly right:
1. Frame/commit engine (built)
2. Frame-as-queue via refs (built)
3. Event routing through plugins (THE missing piece)
4. Authentication/authority (server-controlled for now, signature-ready for later)

<!--
What are your thoughts on what I've said so far?
 -->

---

<!-- ═══════════════════════════════════════════════════════════════════════════ -->
<!-- CONVERSATION BOUNDARY — 2026-03-06 — Claude's Response to Round 2         -->
<!-- ═══════════════════════════════════════════════════════════════════════════ -->

---

Your annotations cut right through my over-engineering on two points:

**On pseudo-selectors — you're completely right, I was conflating two things.**

The onChange signature already carries the creation/modification/deletion semantics implicitly:
- `previousValue === null` → it's a creation
- `newValue === null` → it's a deletion
- Both non-null → it's a modification

The selector matches the *frame*. The *handler* receives the change context. A plugin that cares whether it's a creation vs modification checks the onChange arguments, not the selector. That's a cleaner separation of concerns than baking lifecycle semantics into the matching language. The selector is "what do I care about?" The handler logic is "what happened to it?"

**On tree traversal — yes, I misunderstood, and you're right.**

I was imagining the router needing to walk the frame tree to evaluate selectors. But that's not what you're describing. One frame mutates → one event fires → the router checks that event against N registered selectors. That's it. If a plugin's selector matches, the plugin gets the frame. If the plugin *wants* to look up the parent frame for context, that's the plugin's business — not the router's.

The cost is O(N-plugins) per frame mutation, not O(N-plugins * N-frames). And N-plugins is small — maybe 10-20 even in a rich system. That's basically free.

I was projecting complexity from the tree structure onto the routing engine, but they're independent. The tree is the *data model*. The router is a flat event dispatcher with pattern matching. A plugin could register `on([parentType=permissions-request])` if it wanted lineage-aware matching, and the router just checks that property on the frame — no traversal needed, because the frame already *knows* its parent.

**On "what are your thoughts on what I've said so far":**

Honestly? You've talked me out of most of my reservations. Let me be specific about where I've landed:

1. **Recovery via re-feeding frames through the router** — Convinced. The "done" short-circuit makes this cheap, and it's self-healing. No separate recovery mechanism needed.

2. **Silent commits** — Important design detail you introduced. Two commit modes (reactive vs silent) solve the cascading problem elegantly.

3. **CSS-selector routing with onChange(previousValue, newValue)** — Convinced this is the right model. Selectors match frames, handlers receive change context. Simple, familiar, optimizable.

4. **Sessions as top-level frames** — Still mind-bending, but I can't find a reason it wouldn't work. It eliminates an entire layer of abstraction (SessionManager) and gives you fractal nesting for free.

<!-- 
This also BECOMES our DM/PM messages. A DM IS a top-level frame with only two participants. That is how we define DM.

I don't think we would want ALL frames to be `id: MD5(...partipants.ids)` for identity. I think we have many cases where we would want all the same parties, but a different conversation. However, DMs _could_ be an exception case, where `participants.ids.length === 2`. The other cool thing about this is that you could have a "Self" channel. I LOVE "Self" channels. Who cares? A "Self" channel is a top-level frame with one participant.

This could also be an interesting "play ground" for agents later on, if we found a use for such a thing.
 -->

5. **Signatures** — Agreed, defer but design for it.

The one thing I'd still push on: **ordering guarantees**. When multiple plugins match the same frame mutation, what order do they fire in? Does it matter? In most cases probably not — each plugin reads the frame, does its thing, and writes new frames. But if two plugins both want to *modify* the same frame in response to a change, you have a conflict. The commit engine's merge semantics handle this at the data level, but logically you might want priority ordering on selectors (like CSS specificity, or explicit priority numbers on plugin registrations). Something to think about, but not a blocker.

The design is solid. I'm genuinely excited about it too.

<!-- 
Yes, we will have to have a specifity engine... probably nothing as complicated as in the DOM. Honestly, I'd prefer a user driven order. The owner of the Organization decides on plugin order (with order defaulting to installation order).
 -->

 <!-- 
 I'd like to drop into AGIS planning mode to design this thing. However, when you do drop into this mode, I want to try something new. I want you to be the Coordinator, and I want you to spin up a sub-agent, and I want you to talk back and forth with them until you figure out the plan between yourselves. I want you to use AGIS skills between both of you (all that seem helpful, which is probably at least a few), and try and see if you can work this out from every angle, first by planning the actual plan, what is important, what needs to get cut or pushed to the future, what is wrong, what is right, what could be done better, what testing will be required to confirm "done", etc... Then, after the plan (vision) is 100% complete, overview it with PLAN TESTS. Ask amongst yourselves "What is wrong with this plan? What are we forgetting? What could be better? What's the best way to implement it?" etc... Next, after this is all done, and the plan has been fully reviewed, I want you to then understand the current state of the code base, and to plan what needs to change (the change diff). Once the plan is fully complete, including current code analysis and the changes needed, dump a detailed summary of it here, including and open questions or concerns you might have, and we will keep this dialog going. This conversation.md becomes the pre-planning, the dialog, and the boostrap for the plan itself.

 I trust you. I bet you and an agent can do a really good job. If you forgot what the AGIS skills are, or the "bot-docs" plans we have designed, then let me know, and I'll direct you. I am excited to see what you come up with!
  -->

---

<!-- ═══════════════════════════════════════════════════════════════════════════ -->
<!-- CONVERSATION BOUNDARY — 2026-03-06 — AGIS Planning: Coordinator + Agent   -->
<!-- ═══════════════════════════════════════════════════════════════════════════ -->

---

### Coordinator's Note

I spun up a sub-agent and gave it the full context: our conversation, the existing reactive-frame-engine.yaml plan, the architecture docs, and instructions to use AGIS multi-perspective thinking (engineer, cynic, minimalist, qa_tester, security_officer, devil's advocate) plus the Question Gauntlet on every component.

The agent read all 8 key source files (~4,000+ lines of code), analyzed them, and produced the plan below. I agree with most of its conclusions — especially the pragmatic deferrals. Here are my Coordinator notes on where the agent's recommendations diverge from our original vision:

**Where the agent pushed back on us (and I think it's right):**
- **DEFER sessions-as-frames.** The cynic and minimalist won. The router doesn't need this, the current SessionManager works, and coupling two big changes is a recipe for a two-front war. Build the router first, unify later.
- **DEFER generator suspension.** Keep the hard-break for now, but express it through the router (move permission logic out of InteractionLoop into a plugin). Suspension requires a generator lifecycle manager and crash recovery — too much to couple with the router MVP.
- **DEFER general re-feed.** Do targeted recovery for known stuck states instead. General re-feed needs handler idempotency guarantees we don't have yet.

<!-- 
I think these are all good ideas. But let's make sure we capture them in "future-plans" in "bot-docs".
 -->

**Where I'd push back on the agent:**
- The selector MVP (`type:foo` only) might be *too* minimal. Property selectors (`type:tool-call[toolName=shell:execute]`) are needed for the permission plugin to distinguish shell tool calls from websearch tool calls. I'd include property selectors in MVP.
- The agent suggests keeping `registerHook` during migration (Phase C4). I'd deprecate it sooner — maintaining two systems for hooks is confusing.

<!-- 
Again, I agree with you. Good assessment.
 -->

**What I particularly liked:**
- The queue-based re-entrant processing (iterative, not recursive) is the right solution for the cascading problem we discussed.
- Error frames as silent commits is elegant — prevents the error-cascade loop we worried about.
- The incremental migration plan (C1→C2→C3→C4→C5) where each phase has its own test suite AND must pass all existing tests before proceeding.

The full plan follows. Please read it, annotate with HTML comments as you've been doing, and we'll continue the dialog.

---

# Reactive Frame Engine: Event Routing Layer — Architecture Plan

**Date:** 2026-03-06
**Phase:** C (Event Routing Layer)
**Prerequisites:** Phase A (commit log, refs, diff, windowed loading, commit validator) and Phase B (author fields, structural ACL, frame creation pivot, per-agent refs, session scheduler, message assembly v2, controller integration, stop-as-commit) are COMPLETE.

---

## 1. Vision Overview

The Reactive Frame Engine transforms Kikx from a procedurally-orchestrated interaction system into a declarative, event-driven architecture where **frame mutations are the universal event primitive**. Today, the InteractionLoop manually drives agent-kernel communication: it iterates an async generator, intercepts tool calls, checks permissions, creates frames, and coordinates scheduling through explicit event emission and handler wiring. The proposed evolution replaces this imperative control flow with a **frame event router** — when a frame is created or modified, matched plugins are notified via `onChange(previousValue, newValue)`, and they react by creating new frames, which in turn trigger further routing. The interaction loop, permission system, and multi-agent scheduler all become plugins reacting to frame mutations rather than hardwired kernel logic.

This is not a rewrite. The frame/commit engine and refs system (Phase A) and per-agent scheduling (Phase B) remain intact as foundation. The evolution introduces a CSS-selector-like plugin matching system, two commit modes (reactive and silent), and incrementally migrates scheduling, permissions, and hooks from the InteractionLoop into routing plugins. Sessions-as-frames unification, generator suspension, and general re-feed recovery are deferred to later phases.

<!-- 
Please add to "future-plans".
 -->

---

## 2. Component Breakdown

### 2.1. Frame Event Router

**Description:** The core routing engine. When `FrameManager.merge()` creates or modifies frames, the router determines which plugins care about that frame and invokes their `onChange(previousValue, newValue)` handler.

**Design Decisions:**
- `onChange(previousValue, newValue)` is the universal handler signature
<!-- 
Yes, but the argument signature you have is wrong. It needs to be:
`onChange(propName, previousValue, newValue)`

I like the idea of the engine doing the diff, and deciding there is a change. However, I think the plugin can deal with the level of call abstraction if it wants. A plugin could even do:
```js
onChange(propName, previousValue, newValue) {
  return this[`on${propName}Change`].call(this, previousValue, newValue);
}
```
 -->
- Routing happens per-commit, not per-frame (handlers see a consistent snapshot)
<!-- 
Correct. We can "lock" or "summarize" frames however we want for optimization. This will probably be an implementation detail of the commit engine itself.
 -->
- Synchronous matching, async handling
<!-- 
I think I understand you here, and I think I want to say yes. A little more clarity on this one would be nice.
 -->
- Handler isolation: one handler's failure does not prevent others from firing
<!-- 
Correct.
 -->
- **Re-entrant safety via queue**: handlers that create new frames add commits to a queue processed iteratively, not recursively

**Multi-Perspective Highlights:**
- **cynic**: "This is an event bus. Event buses become debugging nightmares. How do you trace 'why did this frame get created?'"
- **devil**: "Why not just use the existing EventEmitter?"
- **Response**: EventEmitter can't do pattern-based matching, ordering control, isolation, or loop detection. The router provides all of these.

**Acceptance Criteria:**
1. Frame merge triggers matched handlers via `onChange(null, frame)` for creation
2. Frame update triggers `onChange(previousFrame, newFrame)` for modification
3. Silent commits do NOT trigger routing
4. Handler errors are caught and don't prevent other handlers from firing
<!-- Yes -->
5. Re-entrant frame creation works without stack overflow (iterative processing)
<!-- Yes -->
6. Loop detection with configurable depth limit prevents infinite cycles
<!-- Yes, but I caution worrying about this too much. We might actually find loops useful, and even a feature. I think for now we should debug and then fix bugs... but leave the ability to loop if you want to (a good example would be agent to agent dialog, which would look very much like a loop) -->

---

### 2.2. Plugin Selector System

**Description:** Plugins declare interest in frames via selectors registered at load time via `registerSelector(selector, handler)`.
<!-- Yes, but plugins might also be able to assist with routing, storage, or other things. I like the generic plugin interface we have now, and I don't really want to change it too much. It is true that we will be "binding" to selectors, instead of "register"ing things. But I like the flexible, context driven interface we have. We likely will want plugins to do other things as well in the future. -->

**MVP Selector Syntax:**
- `type:user-message` — match frame.type === 'user-message'
- `type:*` — catch-all
- `author:agent` — match frame.authorType === 'agent'
- `type:tool-call[toolName=shell:execute]` — type + content property match

**Design Decisions:**
- Registration at `setup()` time (alongside `registerTool`, `registerCommand`)
<!-- 
Yes, and I believe both of these are still needed.
 -->
- Selectors compiled once at registration, not per-frame
<!-- 
Correct. Rarely. Probably only at plugin change/install/remove.
 -->
- O(N-plugins) per frame mutation
- Support both string selectors (parsed) AND function predicates (passed through)

**Acceptance Criteria:**
1. Plugins call `registerSelector(selector, handler)` in setup()
2. Type selectors match frames with matching type
3. Invalid selectors throw at registration time
4. Multiple handlers can match the same frame

<!-- 
You got it!
 -->

---

### 2.3. Reactive/Silent Commit Modes

**Description:** `merge([frames], { silent: true })` persists without triggering routing.

**Use cases for silent commits:**
- Progress updates during tool execution
- Agent ref advances
- Error frames (prevents error cascades)
- Internal bookkeeping

<!-- 
Yes.
 -->

**Acceptance Criteria:**
1. Silent merge creates a commit that does NOT trigger routing
2. Default merge DOES trigger routing
3. `loadWindow()` does not trigger routing
4. Silent commits are in the commit log (real commits, just non-reactive)

<!-- 
Correct.
 -->

---

### 2.4. Sessions-as-Frames Unification — DEFERRED

**Recommendation:** Defer to a dedicated phase after the router is stable.

**Rationale:** High risk, invasive, current SessionManager works and has tests. The router can be built and validated without this unification. Attempting it simultaneously creates a two-front war.

**Bridge option (if needed sooner):** Add `sessionFrameId` to Session model. On session creation, also create a `type: 'session'` frame. Messages reference `parentId: sessionFrameId`.

<!-- 
I agree. We can defer this work for now... but let's be future-facig, be aware of it, and plan simple things now that will make our lives easier later. 
 -->

---

### 2.5. Permission Flow — KEEP HARD-BREAK, MOVE TO PLUGIN

**Phase C approach:** Express permission flow through the router, but keep the hard-break mechanism. The permission plugin reacts to tool-call frames that need approval, creates permission-request frames, and the existing hard-break/replay logic handles the rest.

**Phase D (later):** Replace hard-break with generator suspension. Requires generator lifecycle manager and crash recovery fallback.

<!-- 
I think all events are "hard breaks" in this new design, so I don't think this is an issue... but let's see if we can simplify and clean up this system a bit if possible.
 -->

---

### 2.6. Recovery — TARGETED, NOT GENERAL

**Phase C approach:** On session load, query for `pending-action` frames without matching responses. Re-emit `permission-request` frames. Users see pending permissions and can approve/deny.

<!-- 
Hmmm... not so sure about this one. I think you are saying that we just keep popping it up in their face. I don't like that idea. Let's not. If a question (or permission) needs to be asked again, the same tool call can always be invoked again.
 -->

**General re-feed deferred** until handlers have proven idempotency in production.

---

### 2.7. Plugin Ordering

- Default: installation order (internal plugins first, then external)
- Within a plugin: registration order
- Configurable by org owner (future feature)

---

## 3. Implementation Phases

### Phase C1: Frame Event Router Foundation
| Step | Description | Files |
|------|------------|-------|
| C1.1 | Create `FrameRouter` class | `src/core/routing/frame-router.mjs` (NEW) |
| C1.2 | Create `SelectorCompiler` | `src/core/routing/selector-compiler.mjs` (NEW) |
| C1.3 | Add `registerSelector` to PluginContext | `src/core/plugin-loader/index.mjs` (MODIFY) |
| C1.4 | Add `registerSelector` to PluginRegistry | `src/core/plugin-loader/registry.mjs` (MODIFY) |
| C1.5 | Add `silent` flag to merge options/commits | `src/shared/frame-manager/frame-manager.mjs` (MODIFY) |
| C1.6 | Wire Router into KikxCore | `src/core/kikx-core.mjs` (MODIFY) |
| C1.7 | Tests | `spec/core/routing/` (NEW) |

### Phase C2: Migrate Scheduling to Router
Convert SchedulerOrchestrator logic into a routing plugin.

### Phase C3: Migrate Permission Flow to Router
Move permission checking from InteractionLoop into a routing plugin.

### Phase C4: Migrate Hook System to Router
Replace HookRunner with routing-based message interception.

### Phase C5: Slim Down InteractionLoop
Remove migrated logic. Target: under 500 lines (from ~1150).

---

## 4. What Changes in Current Code

**Modified (~10 lines each):**
- `frame-manager.mjs` — add `silent` flag
- `plugin-loader/index.mjs` — add `registerSelector` to context
- `plugin-loader/registry.mjs` — add `_selectors` registry

**Heavily modified:**
- `interaction/index.mjs` — remove ~400 lines of scheduling/permission/hook logic after C2-C5

**Deprecated:**
- `scheduler-orchestrator.mjs` — logic moves to scheduling plugin

**New files:**
- `src/core/routing/frame-router.mjs`
- `src/core/routing/selector-compiler.mjs`
- `src/core/internal-plugins/scheduling/index.mjs`
- `src/core/internal-plugins/permissions/index.mjs`
- Plus corresponding test files

---

## 5. What Gets Deferred

| Feature | When |
|---------|------|
| Sessions-as-Frames | After Phase C stable |
| Generator Suspension | Phase D |
| General Re-feed Recovery | After handlers battle-tested |
| Configurable Plugin Ordering | When third-party plugins exist |
| Abilities System | Phase E |
| Signatures/Federation | When needed |

---

## 6. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Re-entrant routing causes performance issues | Medium | Depth limit (default 10), monitoring |
| Migration breaks existing behavior | High | Incremental phases, all tests pass each step |
| Router performance with many plugins | Low | O(N-plugins) is fine for 10-20; index by type later |
| Silent commit misuse | Low | Clear docs, naming conventions |
| Error frame cascades | Medium | Error frames as silent commits |
| Two code paths during migration | Medium | Feature flags, clear switch-over points |

---

## 7. Plan Test Results

All 17 plan assertions **PASS** at the design level. One requires runtime verification: "Existing tests continue to pass through migration."

---

## 8. Open Questions

1. **Selector syntax MVP**: Include property selectors (`[toolName=shell:execute]`) from the start, or add later?
<!-- Included from the start. -->
2. **Silent commit naming**: `{ silent: true }` or `{ reactive: false }`?
<!-- I like "silent: true" -->
3. **Loop depth limit**: Default 10? 20? Configurable per-plugin or globally?
<!-- Looping for what? -->
4. **Migration order**: Scheduling first (simplest), permissions (highest value), or hooks (fewest consumers)?
<!-- Whichever is the easiest, and can get done in parallel with sub-agents. -->
5. **Error frames**: Visible to user or admin-only diagnostic?
<!-- 
Visible to everyone. We will change this later on if we need to. At least for now this will be useful for debugging.
 -->
6. **Phantom frames**: Should they trigger routing? (Current thinking: no)
<!-- 
For now, no... but I wonder if it will stay that way. Have it a boolean "phantom: true", and for now, we will skip routing... but that might change.
 -->
7. **Command dispatch**: Move `/command` handling to a routing plugin too?
<!-- 
Yes, just make sure this plugin is essentially "zero" in priority. This is also where we will want a "handled" system, so a plugin doesn't have to call the "next" method.
 -->
8. **Timeline priority**: Which phase is most urgent?
<!--
Nothing is urgent. I want it done correct, not quickly.
 -->

---

<!-- ═══════════════════════════════════════════════════════════════════════════ -->
<!-- CONVERSATION BOUNDARY — 2026-03-06 — Corrections & Future Plans Captured  -->
<!-- ═══════════════════════════════════════════════════════════════════════════ -->

---

## Annotations Incorporated — Resolved Decisions

All annotations from the architecture plan have been read and processed. Here's the refined set of decisions, incorporating your corrections:

### Resolved Open Questions

| # | Question | Decision |
|---|----------|----------|
| 1 | Selector syntax MVP | **Include property selectors from the start.** `type:tool-call[toolName=shell:execute]` is needed for the permission plugin. |
| 2 | Silent commit naming | **`{ silent: true }`** |
| 3 | Loop depth limit | **Don't over-worry about loops.** Loops may be useful (agent-to-agent dialog looks like a loop). Debug and fix bugs as they arise, but leave the ability to loop. |
| 4 | Migration order | **Whichever is easiest.** Can be parallelized with sub-agents. |
| 5 | Error frames | **Visible to everyone** for now. Useful for debugging. Change later if needed. |
| 6 | Phantom frames | **No routing for now.** Use `phantom: true` boolean on the frame. May change later. |
| 7 | Command dispatch | **Yes, move to routing plugin.** "Zero" priority (always first). Add a **"handled" system** so plugins don't need to call `next()` — setting `handled = true` stops further routing. |
| 8 | Timeline | **Nothing is urgent. Done correct, not quickly.** |

### Key Corrections to the Plan

1. **onChange signature**: `onChange(propName, previousValue, newValue)` — NOT `onChange(previousValue, newValue)`. Plugins can further dispatch internally:
   ```js
   onChange(propName, previousValue, newValue) {
     return this[`on${propName}Change`].call(this, previousValue, newValue);
   }
   ```

2. **Recovery approach**: Do NOT re-pop pending permissions in users' faces. If a question needs to be asked again, the same tool call can be invoked again by the agent. Recovery is plugin-driven, not system-driven.

3. **Plugin interface**: Keep the flexible, context-driven plugin interface. `registerSelector` is additive alongside existing `registerTool` and `registerCommand` — not a replacement.

4. **Permissions simplification**: "All events are hard breaks in this new design" — the event-driven architecture naturally pauses between events. Simplify and clean up the permission system accordingly.

5. **Loop detection**: Be cautious. Agent-to-agent dialog is a valid use case that looks like a loop. Don't block legitimate loops.

### Deferred Items — Captured in bot-docs

All six deferred items have been captured in `bot-docs/future-plans/` with detailed YAML files:

| Item | File | Priority |
|------|------|----------|
| Sessions-as-Frames | `bot-docs/future-plans/sessions-as-frames.yaml` | Medium |
| Generator Suspension | `bot-docs/future-plans/generator-suspension.yaml` | Medium |
| General Re-feed Recovery | `bot-docs/future-plans/general-re-feed-recovery.yaml` | Low |
| Configurable Plugin Ordering | `bot-docs/future-plans/configurable-plugin-ordering.yaml` | Low |
| Abilities System | `bot-docs/future-plans/abilities-system.yaml` | Medium |
| Signatures & Federation | `bot-docs/future-plans/signatures-federation.yaml` | Low |

The `bot-docs/plan/kikx/future-plans.yaml` index has been updated with cross-references to each detailed file.

### What's Next

The plan is fully annotated, corrections incorporated, and deferrals documented. The next step when you're ready is to formalize Phase C1 into a concrete implementation plan (the TODO.md) and start building. Phase C1 is the Frame Event Router Foundation — the selector compiler, router core, silent commit mode, and the wiring into KikxCore. Everything else (C2-C5 migrations) depends on C1 being solid.

<!-- 
This is turning into a good plan. I have one concern though. I think our "onChange" system might be a little simple, in the sense that we don't have a clear place in the process to call "next" for the next plugin to execute.

I would like to be able to call "next" to execute the next plugin. The next call should also pass along the "context", which will include the frame. We can then have a "change helper" in the plugin base class to detect changes.

i.e.

export function setup({ BasePluginClass, registerSelector }) {
  class Plugin extends BasePluginClass {
    onChange(context, propName, previousValue, newValue) { // I just realized that we should probably pass in the context? Or maybe we provide the context to the class when we instantiate (new Plugin(context))? The later concerns me, as this is async code, and the context might change through the pipeline... but I guess if we ensure only one plugin executes at a time (serial execution) then maybe this isn't an issue?
      // Do something
    }

    async process(context) { // Get's call when the selector matches
      const {
        frames, // the entire frame stack
        previousFrame, // the previous frame
        newFrame, // the new committed frame
        next, // the next plugin (or NOOP, if the system detects there is no "next")
      } = context;

      this.processChanges(context); // Calls "this.onChange" on changed properties... this is the helper in BasePluginClass that detects property/state changes... although, we DO need to know if a frame has changed before we start routing to get this far and deep into a plugin... so maybe the "changes" come across in the context? And this just iterates the "changes" passed in via the engine?

      return await next(context); // user can optionally modify context, i.e. for plugins that assist with routing, add metadata, etc...
    }
  }

  registerSelector('.selector', Plugin); // Register the plugin class (not instance... I don't want instances to be running for a long time, as this adds complexity, and could be a big potential source of bugs and memory issues, plus cross-server issues)
}

 -->

 <!--
 Thoughts? We appear to have a number of open-ended questions here.
  -->

---

<!-- ═══════════════════════════════════════════════════════════════════════════ -->
<!-- CONVERSATION BOUNDARY — 2026-03-07 — Claude's Response: Plugin Lifecycle  -->
<!-- ═══════════════════════════════════════════════════════════════════════════ -->

---

Yeah, we do have open questions, and they're the *right* questions to be asking before writing code. Let me work through them one at a time.

### The `process()` + `onChange()` split

Your sketch actually reveals two distinct concerns that were conflated in the original plan:

1. **`process(context)`** — "A frame matched your selector. Here's the full context. Do your thing." This is the entry point. This is where the plugin decides what to do.
2. **`onChange(context, propName, previousValue, newValue)`** — "Here's a specific property that changed." This is a convenience helper for plugins that care about individual property transitions.

I think you're right that `process()` is the primary handler, and `onChange()` is a *derived* helper that `processChanges()` calls in a loop. The router calls `process()`. The plugin optionally calls `this.processChanges(context)` which diffs and dispatches to `onChange()` per-property. Or the plugin ignores `processChanges()` entirely and just works with `context.newFrame` directly. That's clean.

### The `next()` middleware pattern

This is where I want to push back a little — not on the concept, but on the *default behavior*.

You said earlier: "I want a 'handled' system, so a plugin doesn't have to call the 'next' method." But now you're sketching a middleware chain where plugins explicitly call `next()`. These are two different models:

**Model A — Middleware (Express-style):** Plugin MUST call `next()` to continue the chain. If it doesn't, routing stops. This is powerful (plugins can transform context, short-circuit) but error-prone (forget `next()` and you silently break the chain).

**Model B — Broadcast with "handled" flag:** Router calls every matched plugin. Plugin sets `context.handled = true` to stop further routing. Default is "everyone gets called." This is simpler and less error-prone.

Your code sketch shows Model A, but your earlier annotation ("I want a 'handled' system, so a plugin doesn't have to call next") describes Model B.

My recommendation: **Model B as the default, with `next()` available for the rare cases that need it.** Here's why:

- Most plugins don't care about ordering. They match a frame, do their thing, create new frames. They shouldn't need to think about `next()`.
- The "handled" flag covers the command dispatch case you described — the command plugin sets `handled = true` and the router stops.
- Middleware chains are powerful but they're a cognitive tax on every plugin author. "Did I remember to call next?" is the #1 bug in Express middleware.

Concrete proposal:

```js
async process(context) {
  // Default: router calls every matched plugin in order.
  // If you want to stop further routing:
  context.handled = true;

  // If you need to transform context for downstream plugins
  // (rare, mainly for routing/metadata plugins):
  context.newFrame.metadata = { ...context.newFrame.metadata, enriched: true };

  // No "next()" call needed. Router handles iteration.
}
```

For the rare middleware case (a plugin that wraps/transforms), we could have a separate registration: `registerMiddleware('.selector', Plugin)` — these DO get `next()` and run before broadcast handlers. But I'd defer that until we actually need it.

<!-- 
HHmmmm... I do greatly appreciate you pushing back, but I don't think I agree with you. Here is why:
1. The "next" process naturally creates a "call chain"/async interation for the routing system. This simplifies the entire system. Sure, the router manages and handles the "next" and "done" calls themselves, but the chain is naturally async, and is a natural form of iteration to crawl the registered selectors.
2. I DO want plugins to be able to modify the context and frames (i.e. one plugin adds metadata to the frame, silently commits that, and passes the update onto the next plugin in the chain). This becomes more convoluted if we have a "pluggin" and "middleware" system, or a separate "handled" process. Besides, what if a plugin needs to be middleware AND a plugin at the same time? Why have two separate systems?
3. Plugins are not exactly build by "anyone" and "everyone" on the fly. Plugin authors need to be good engineers, and need to know what they are doing. Don't call "next"? Too bad, you broke things. Fix your bug.
4. However, ONE thing comes out of your push back. I think we do need an explicit "done" method that is passed in side-by-side with "next". If the plugin wants to stop the call chain, then it `return await done(context);`, instead of calling "next".
5. Another thing, the router itself should wrap the `process` call in a "try/catch/finally". This way, if the plugin throws an error, or returns WITHOUT calling done/next, then we can properly handle the situation without the whole system going down (not calling done/next would itself throw/log an error for that specific plugin). i.e. if "process" returns without a "next" or "done" call, that is an error.

Thoughts? I am still open to feedback.
 -->

### Context: argument vs constructor

You flagged this yourself: "maybe we provide the context to the class when we instantiate? The later concerns me, as this is async code."

Your instinct is right to be concerned. Context-on-constructor means the instance is bound to one routing cycle. Context-as-argument means the class is reusable.

But then you also said: "Register the plugin class (not instance... I don't want instances running for a long time)."

So: **fresh instance per routing cycle**. The router does `new Plugin()`, calls `plugin.process(context)`, and the instance is GC'd. No long-lived state, no cross-contamination, no memory leaks.

This means context goes in the argument (or the constructor, since the instance is short-lived — functionally equivalent). I'd lean toward the constructor because it makes `this.context` available in `onChange()` without threading it through:

```js
class Plugin extends BasePluginClass {
  // BasePluginClass constructor stores context on this.context
  // BasePluginClass.processChanges() iterates context.changes and calls onChange()

  async process() {
    // this.context is available
    this.processChanges(); // calls onChange() per changed property
  }

  onChange(propName, previousValue, newValue) {
    // this.context is available if needed
    if (propName === 'status' && newValue === 'approved') {
      // do something
    }
  }
}
```

Since instances are per-routing-cycle, the "context might change through the pipeline" concern evaporates — each plugin gets its own instance with its own context snapshot.

<!-- 
Adding the context to the plugin class instance itself (via the constructor) greatly simplifies the interface, and we already know that we don't want plugins processing in parallel (I can see such a thing turning nightmarish real fast). So as long as we spin up the plugin class, await for it to finish (which hopefully happens after a "next" or "done" call), then we should never need to worry about the "contex" becoming stale out-of-band.
 -->

### Where do `changes` come from?

You asked: "we DO need to know if a frame has changed before we start routing... so maybe the 'changes' come across in the context?"

Yes. The router computes the diff *before* dispatching. The context includes:

```js
context = {
  frames,          // full frame stack (for lookups)
  previousFrame,   // frame before this commit (null for creation)
  newFrame,        // frame after this commit (null for deletion)
  changes,         // [{ propName, previousValue, newValue }, ...] — pre-computed diff
  commit,          // the commit that triggered this routing cycle
  handled,         // false initially, plugin can set to true
};
```

`processChanges()` in `BasePluginClass` just iterates `context.changes` and calls `this.onChange()` for each. The router already did the diff — the plugin doesn't need to.

<!-- 
Agreed. Good thinking.
 -->

### Summary of open questions — proposed answers

| Question | Proposed Answer |
|----------|-----------------|
| `process()` vs `onChange()` | `process()` is the entry point. `onChange()` is a convenience helper called by `processChanges()`. |
| `next()` vs `handled` flag | **`handled` flag** as default. No `next()` needed. Router iterates matched plugins automatically. Defer middleware-style `next()` until proven needed. |
| Context delivery | Constructor arg. Fresh instance per routing cycle. `this.context` available everywhere. |
| Where do changes come from? | Router computes diff, passes `context.changes` array. `processChanges()` iterates it. |
| Class vs instance registration | **Class registration** (`registerSelector('.selector', PluginClass)`). Router instantiates per cycle. |

<!--
Any further thoughts?
 -->

---

<!-- ═══════════════════════════════════════════════════════════════════════════ -->
<!-- CONVERSATION BOUNDARY — 2026-03-07 — Claude's Response: next/done Model   -->
<!-- ═══════════════════════════════════════════════════════════════════════════ -->

---

Alright, you've convinced me. Let me explain why, and then let's nail down the revised model.

### Why `next()`/`done()` wins over `handled` flag

Your five points are all good, but #2 and #4 together are what tipped me. Let me restate the argument as I understand it:

- A `handled` flag gives you two states: "keep going" and "stop." That's it.
- `next(context)` / `done(context)` gives you three: "keep going with this context," "stop, I'm done," and implicitly "I modified the context before passing it along."

The `handled` flag can't express "I added metadata to this frame, now let the next plugin see my enriched version." You'd need the flag *plus* some way to mutate shared state, which is the same thing as middleware but with extra steps and more footguns. Why have two systems when one does both?

And point #3 is pragmatically correct — these aren't npm packages installed by random developers. Plugin authors are us, or engineers we trust. The cognitive overhead of "remember to call `next()` or `done()`" is a non-issue for competent engineers, especially with the safety net from point #5.

### The safety net (point #5) is the key insight

The router wrapping `process()` in try/catch/finally solves the "forgot to call next" problem that was my main objection. Here's what the router does internally:

```js
async _executeChain(matchedPlugins, context) {
  let index = 0;
  let chainResolved = false;

  const done = async (ctx) => {
    chainResolved = true;
    return ctx;
  };

  const next = async (ctx) => {
    chainResolved = true;
    index++;
    if (index >= matchedPlugins.length)
      return ctx;

    chainResolved = false; // reset for next plugin
    return await this._invokePlugin(matchedPlugins[index], ctx, next, done);
  };

  return await this._invokePlugin(matchedPlugins[0], context, next, done);
}

async _invokePlugin(PluginClass, context, next, done) {
  let chainResolved = false;
  const wrappedNext = async (ctx) => { chainResolved = true; return next(ctx); };
  const wrappedDone = async (ctx) => { chainResolved = true; return done(ctx); };

  const plugin = new PluginClass(context);
  try {
    const result = await plugin.process(wrappedNext, wrappedDone);
    if (!chainResolved) {
      // Plugin returned without calling next() or done() — that's a bug
      this._logger.error(`Plugin ${PluginClass.name} returned without calling next() or done()`);
      // Fail safe: treat as done() to prevent silent chain breakage

      /*
      Response from user: I am not sure I like the idea of one plugin breaking the entire chain. I think we should just log the error, and call "next" ourselves. We could always evict the plugin as well, if this becomes a bigger issue in the future (with plugins not properly going through the proper process).
      */
      return context;
    }
    return result;
  } catch (err) {
    this._logger.error(`Plugin ${PluginClass.name} threw:`, err);
    // Plugin crashed — continue chain so one bad plugin doesn't break everything
    return next(context);
  }
}
```

Key behaviors:
- **Plugin forgets `next()`/`done()`**: Logged as error, ~~treated as `done()`~~ <!-- still call "next" and proceed. Evict the plugin if the behavior continues (should be a future plan). --> ~~Chain stops but system doesn't break.~~
- **Plugin throws**: Logged as error, chain **continues** (skips the broken plugin). One plugin's crash doesn't prevent others from processing.
<!-- This same mentality should be applied to the item above. -->
- **Plugin calls `done()`**: Chain stops intentionally. No error.
- **Plugin calls `next(ctx)`**: Chain continues with (potentially modified) context.

### Revised plugin interface

Incorporating all agreed-upon decisions:

```js
export function setup({ BasePluginClass, registerSelector }) {
  class PermissionsPlugin extends BasePluginClass {
    // BasePluginClass constructor receives context, stores as this.context
    // this.context = { frames, previousFrame, newFrame, changes, commit } /* From user: We should probably also have access to the "engine" in here... but don't sweat that. DO feel free to add what is needed to this context however, and think about future-needs for plugins */

    async process(next, done) {
      // Check if this tool call needs permission
      let toolName = this.context.newFrame.content?.toolName;
      let needsApproval = await this.checkPermission(toolName); // We need the permissions system to have "metadata" like it currently does, i.e. like how the shell command stores commands and arguments that are allowed/disallowed

      if (needsApproval) {
        // Create a permission-request frame (reactive commit — triggers routing)
        await this.createFrame({ type: 'permission-request', ... });
        return await done(this.context); // Stop chain — waiting for user response
      }

      // No permission needed — pass along, maybe with metadata
      this.context.newFrame.metadata = {
        ...this.context.newFrame.metadata,
        permissionChecked: true, // We need to ensure keys like this can not be set by anyone but the system itself, or that they are derived from the system directly
      };

      return await next(this.context);
    }

    // Optional: use the convenience helper for property-level changes
    onChange(propName, previousValue, newValue) {
      if (propName === 'approved' && newValue === true) {
        // Permission was granted — execute the tool
        
        /* Response from user:
        If we have the tool/whatever execution happen inside the permission frame itself, then we also have to pass along context/the original frame, and the permissions system has to know HOW to execute it. It is probably better if the permissions system commits an update to the original frame, which will send the frame back through the router as an "event", and then the tool-call gets a "signed updated" from the system that allows the tool-call to proceed (with the original frame/context that the tool call already had).
        */
      }
    }
  }

  registerSelector('type:tool-call', PermissionsPlugin);
}
```

### Context on constructor — agreed

Serial execution + fresh instance per cycle = context on constructor is safe. `this.context` is available in both `process()` and `onChange()` without threading. Instance is GC'd after the routing cycle. Clean.

### Updated summary

| Question | Final Answer |
|----------|-------------|
| `process()` vs `onChange()` | `process(next, done)` is the entry point. `onChange()` is a convenience helper. |
| Routing model | **`next(ctx)`/`done(ctx)` middleware chain.** Router catches missing calls and crashes. |
| Context delivery | Constructor arg. Fresh instance per routing cycle. `this.context` everywhere. |
| Changes | Router computes diff, passes `context.changes`. `processChanges()` iterates. |
| Registration | Class registration. Router instantiates per cycle. |
| Error handling | Plugin crash → logged, chain continues. Missing next/done → logged, treated as done. |

I think we've resolved all the open design questions for the plugin lifecycle. Unless you see something I'm missing, this is ready to be formalized into a Phase C1 implementation plan.

<!--
I brought up some further important points for us to discuss here... let's make sure we cover them before we proceed.
 -->

---

<!-- ═══════════════════════════════════════════════════════════════════════════ -->
<!-- CONVERSATION BOUNDARY — 2026-03-07 — Claude's Response: Four Points       -->
<!-- ═══════════════════════════════════════════════════════════════════════════ -->

---

Four important points raised. Let me address each.

### 1. Missing `next()`/`done()` → call `next()`, don't stop the chain

You're right. I had the error behavior backwards. If a plugin forgets to call `next()` or `done()`, the safe behavior is to **continue the chain**, not stop it. A broken plugin shouldn't have the power to silently halt all downstream processing. The corrected `_invokePlugin`:

```js
if (!chainResolved) {
  this._logger.error(`Plugin ${PluginClass.name} returned without calling next() or done()`);
  return next(context); // Continue chain — don't let a broken plugin stop everything
}
```

And in the catch block, same thing — already calling `next(context)`. Both failure modes (forgot to call, threw an error) have the same recovery: log it, keep going. Consistent.

Plugin eviction on repeated violations is a good future-plan item. A simple counter: if a plugin fails N times in a row, disable it and log a warning. But that's later.

### 2. Context should include the engine

Makes sense. Plugins will need to do things like query frames, create commits, look up participants. The context should provide access to the system capabilities the plugin needs. Something like:

```js
context = {
  // Frame data for this routing cycle
  frames,          // full frame stack
  previousFrame,   // before commit (null for creation)
  newFrame,        // after commit (null for deletion)
  changes,         // [{ propName, previousValue, newValue }, ...]
  commit,          // the triggering commit

  // System access
  engine,          // the frame engine / manager — query frames, create commits
  session,         // session context (participants, settings)
  logger,          // scoped logger for this plugin
};
```

I'd keep this extensible — the context object can grow as we discover what plugins need. The initial set should be whatever the first few plugins (scheduling, permissions, command dispatch) actually require. We'll learn what's missing fast.

<!-- 
Love this! The "logger" being in the context also allows the plugin base class to expose this via a "this.logger" getter.
 -->

### 3. Permission metadata (allowed/disallowed commands, arguments)

This is about making sure the permission system carries its current richness into the routing model. Today, shell permissions have metadata like `{ allowedCommands: [...], blockedPatterns: [...] }`. The permission plugin needs this same data.

This fits naturally: the permission plugin reads its configuration (which could be stored as frames, or loaded from the agent/org settings — however permissions are currently configured). The plugin itself owns this logic, not the router. The router just delivers the `type:tool-call` frame to the permission plugin. What the plugin does with it — including checking tool-specific metadata — is the plugin's business.

No architecture change needed here. It's an implementation detail of the permission plugin.

<!-- 
This means each plugin needs its own "space" in the database. I think we already have this. Something to think about.

And, if I remember correctly, we designed plugins to have their own "space" in a cascading way: They have global spaces, which merge into sessions spaces, which could merge even lower. This makes sense, as we probably want per-session storage for plugins, and also other "scopes".
 -->

### 4. Permission approval flow — update the original frame, don't execute from the permission plugin

This is a really good architectural insight. Let me make sure I understand the flow you're describing:

1. Agent yields tool-call → `type:tool-call` frame created (status: `pending`)
2. Router delivers to permission plugin → plugin sees it needs approval
3. Permission plugin creates `type:permission-request` frame, calls `done()` — chain stops
4. User approves → permission-response frame created
5. Router delivers permission-response to permission plugin
6. Permission plugin **updates the original tool-call frame** (sets status: `approved`, signs it)
7. This update triggers the router again — the tool-call frame goes back through routing
8. The tool-execution plugin sees `type:tool-call` with `status: approved` and a valid system signature → executes the tool
9. Tool result → new frame → routing continues

This is cleaner than having the permission plugin execute the tool because:
- The permission plugin doesn't need to know *how* to execute tools. Separation of concerns.
- The tool-execution plugin already has the original context — it was the one that first received the tool-call frame.
- The "signed update from the system" concept naturally fits the authority model. The permission plugin stamps the frame with proof of approval. The tool plugin verifies the stamp before executing. <!-- Note from user: An important distinction here: The tool plugin ITSELF doesn't verify the signature of approval, instead it is still the permissions system, when the tool plugin calls "this.checkPermissions" again. -->

This also means tool-call frames have a lifecycle: `pending` → `approved`/`denied` → `executing` → `complete`. Each transition is a frame mutation, each mutation goes through routing. The whole flow is observable in the commit log.
<!-- 
Yes.
 -->

This is genuinely elegant. The permission system becomes a gatekeeper that stamps frames, not a dispatcher that executes things.

<!-- 
Yes, but through this dialog it has become clear that we need properties, or approval signatures (maybe tied to frame id?) that are OUTSIDE the scope of frames, or properties that are protected system-only properties on frames. It would be a security violation to leave such properties open to the world. We need to ENSURE authority and identity on such frame updates. This is important.
 -->

### Updated error handling summary

| Failure Mode | Behavior |
|-------------|----------|
| Plugin forgets `next()`/`done()` | Logged as error, `next(context)` called automatically — chain continues |
| Plugin throws | Logged as error, `next(context)` called — chain continues |
| Plugin calls `done(context)` | Chain stops intentionally. No error. |
| Plugin calls `next(context)` | Chain continues with (potentially modified) context |
| Plugin fails repeatedly | Future: eviction after N consecutive failures |

---

<!-- ═══════════════════════════════════════════════════════════════════════════ -->
<!-- CONVERSATION BOUNDARY — 2026-03-07 — Claude's Response: Protected Props   -->
<!-- ═══════════════════════════════════════════════════════════════════════════ -->

---

Three annotations, all good. Let me take them in order.

### Plugin scoped storage — cascading spaces

You're right, we already have this concept. Plugins have storage that cascades: global → org → session (and potentially lower). The permission plugin stores its allowed/blocked command lists at the appropriate scope. This is an existing design that carries forward cleanly — no new architecture needed, just make sure the context exposes the plugin's scoped storage so it can read its configuration during `process()`.

<!-- 
We probably should have the plugin system itself LOAD its data. The router or engine shouldn't be "aware" of such things. Besides, "process" calls are async, so this should work just fine. This also means we lazy-load only what we need to load (JIT loading).
 -->

### Permission check stays in the permission system

Your correction on step 8 is important. I had the tool plugin verifying the approval signature, but that's wrong — the tool plugin shouldn't know *anything* about permissions. The flow is:

1. Tool-call frame created (status: `pending`)
2. **Permission plugin** sees it → needs approval → creates permission-request, calls `done()`
3. User approves → permission plugin updates tool-call frame (status: `approved`, stamped)
4. Tool-call frame goes back through routing
5. **Permission plugin** sees it *again* → calls `this.checkPermission()` → sees it's already approved → calls `next(context)`
6. **Tool plugin** sees it → status is `approved`, permission plugin already passed it through → executes

The permission plugin is *always* the gatekeeper. The tool plugin never checks permissions itself. It trusts that if it received the frame through the chain, permission was already handled upstream. This is the whole point of ordered middleware — plugins earlier in the chain handle concerns that plugins later in the chain don't need to think about.

This also means the permission plugin needs to run *before* the tool plugin in the chain. Which ties back to your "zero priority" comment about plugin ordering. Internal system plugins (command dispatch, permissions) run first. Tool execution runs after.

<!-- 
I think conceptually you have this correct, but again I want to make some important distictions. The engine/plugin system itself can't and shouldn't "know" what needs permission approval, and what doesn't. Doing so breaks future-compatibility, and bogs us down with static internals.

Instead, I'd like to clean-up what you have said here to be more explicit about what actually happens, and in what order:

1. Tool-call frame created
2. Tool plugin executed, and "await this.checkPermission" happens inside the plugin (pointing out that "async" here is important, if the plugin system needs to load its own metadata [discussed above])
3. No approval can be made, so "this.checkPermission" fails, generates a permission request frame, and calls "done".
4. User responds to permissions request -> gives approval signature
5. This "approval" update "event" from the user routes back to the permissions frame, back though the plugin, where the original tool-call frame now gets a new "signed commit".
6. This routes a new "update event" through the tool plugin, which again calls "await this.checkPermissions", which this time is automatically approved, because of the signed-commit that approves it.
7. Tool execution proceeds as-normal

Alternative flow if the tool is already pre-approved by the user/system:
Step 2 jumps directly to step 6 because of a prior pre-approval
 -->

### Protected frame properties — this is the big one

You're identifying a real security requirement: if the permission system stamps a frame with `status: approved`, what stops a malicious plugin (or a compromised agent) from setting `status: approved` directly, bypassing the permission system entirely?

Options I see:

**Option A — System-only properties via schema enforcement:**
The frame engine knows which properties are "system-only" (e.g. `status`, `approvedBy`, `approvalSignature`). Any attempt to set these through the normal `merge()` path is rejected unless the caller has system authority. Plugins that need to set system properties go through a privileged API (`engine.systemUpdate(frameId, props)`) that's only available to internal plugins.

**Option B — Separate authority record:**
Approval isn't stored *on* the frame at all. Instead, there's a separate `approvals` table/store keyed by frame ID. The permission system writes to this store. The permission plugin reads from this store when checking `this.checkPermission()`. Frame properties remain unprivileged — the authority lives outside the frame.

**Option C — Signed properties:**
Properties like `approved` are paired with a signature: `{ approved: true, approvalSig: 'hmac_xyz' }`. The signature is computed using a server-side secret. Any plugin can *read* the property, but only the server can *produce* a valid signature. The permission plugin verifies the signature, not just the boolean.

My take: **Option A is simplest and sufficient for now.** We're on a single server. We control the plugin loading. System-only properties enforced at the engine level prevent accidental or malicious overwrites. The engine already validates frames through the commit validator — adding a "protected properties" check is natural.

Option C is elegant and would be needed for federation (where you can't trust remote servers to enforce Option A). But per our earlier agreement, federation is deferred.

<!-- 
Actually, none of this is likely needed if we stick to the flow I outlined above. Any malicious actor can commit whatever they want to the frame. Any such update will simply be ignored, as long as the "checkPermissions" that is part of the permissions system checks for a valid signature of the original permission-request frame. There is no way for a malicious actor to properly sign the frame, unless that actor has access to the user's private key.

As long as we design the signature system properly, and always have permission checks go through the permissions system via a "checkPermissions" anmd the "checkPermissions" does the correct thing (verify the signature), then we likely won't have a problem. With this pattern, we aren't just checking boolean properties like "approved: true"... instead, the check that actually happens is a signature verification, which if not present, will be rejected.

Your next question might properly be "What about global/long-standing approvals?" Well, those are ALSO signed by the user(s) and their private keys. Same thing, different frame grants the approval (a global/scoped signed approval).
 -->

The concrete implementation: FrameManager gets a `_protectedProperties` set (e.g. `['status', 'approvedBy', 'permissionChecked']`). Regular `merge()` strips these. A `mergeTrusted()` or similar method preserves them, and is only callable from system context (internal plugins). The router passes the appropriate merge capability based on plugin trust level.

Does this address your concern, or are you thinking about a different attack surface?

<!--
What do you think, given my feedback here? What security concerns am I glossing over?
 -->

---

<!-- ═══════════════════════════════════════════════════════════════════════════ -->
<!-- CONVERSATION BOUNDARY — 2026-03-07 — Claude's Response: Signature Model   -->
<!-- ═══════════════════════════════════════════════════════════════════════════ -->

---

Okay, you've fundamentally reframed how I was thinking about this. Let me work through it.

### Plugin JIT loading — agreed, trivial

The plugin loads its own data during `process()` (which is async). The router/engine doesn't "know" or "care" about plugin storage. The context just provides access to the storage API. The plugin decides when and what to load. Lazy, JIT, clean.

### The corrected permission flow — this changes everything

I had the permission system as a *separate plugin* that runs before the tool plugin. You're saying no — `checkPermission` lives in the **tool plugin itself** as a method call. The tool plugin is the one that decides "I need permission." This is a critical distinction.

Let me restate your flow to make sure I have it:

1. Tool-call frame created → routes to the **tool plugin**
2. Tool plugin calls `await this.checkPermission()` — this is a method on `BasePluginClass`
3. `checkPermission()` looks for a valid signed approval for this tool call. Doesn't find one.
4. `checkPermission()` creates a permission-request frame and calls `done()` — the chain stops, and we're now waiting for the user
5. User approves → creates a signed approval frame (signed with the user's private key)
6. This approval routes back through the system, and the **original tool-call frame gets a signed commit** attesting to the approval
7. The tool-call frame update routes back to the **tool plugin**
8. Tool plugin calls `await this.checkPermission()` *again* — this time it finds the signed approval, verifies the signature, and returns success
9. Tool execution proceeds

<!-- 
Correct, with one minor clarification: the "done" is actually called by the tool plugin itself when "checkPermissions" fails.
 -->

**What I had wrong:** I was modeling permissions as a separate plugin in the chain that runs *before* the tool plugin. You're modeling it as a capability *within* every plugin — `this.checkPermission()` is part of `BasePluginClass`. Any plugin can call it. The permission system is a service, not a middleware layer.

<!-- 
Correct. This is something I also wanted to clarify: The permissions system is BAKED INTO the system... it isn't a plugin, and it isn't separate from the system. It can have a "plugin architecture" if we need it to, just so it slips right into the current framework, but ultimately it runs first, and is managed by the system itself.
 -->

This is better because:
- No ordering dependency between "permission plugin" and "tool plugin"
- Every plugin can protect any operation it wants, not just tool calls
- The permission system doesn't need to understand what it's protecting — it just verifies signatures
- Pre-approval (step 2 jumping to step 6) works naturally because `checkPermission()` just looks for a valid signature — if one already exists, it returns immediately

### On protected properties — you're right, we don't need them

I was thinking about this wrong. I was worried about a malicious actor setting `approved: true` on a frame. Your response is: **who cares?** Let them write whatever they want. The permission check doesn't look at a boolean property. It verifies a **cryptographic signature** on the approval frame. You can set `approved: true` all day long — without a valid signature from an authorized user, `checkPermission()` will reject it.

This eliminates Option A (protected properties), Option B (separate table), and even Option C (signed properties) as I described it. The security isn't at the property level or the engine level — it's at the **verification level inside `checkPermission()`**.

The frame itself is just data. The authority comes from the signature chain: "User X signed approval Y for tool-call Z." If you can't produce that signature, the approval doesn't exist, regardless of what properties you've written to the frame.

<!-- 
Yes, exactly!
 -->

### Security concerns you might be glossing over

You asked, so here's what I'd push on:

**1. Key management before federation.**
You said signatures are deferred to federation, but the permission flow as you've described it *requires* signatures to work. If `checkPermission()` verifies a signature, we need key pairs now, not later. Unless... `checkPermission()` uses a simpler verification mechanism in the near term (server-side HMAC, or just "the server stamps the approval commit with `authorType: 'user'` and `authorID`, and since we trust the server, we trust the stamp"). In other words: on a single server, the server's authentication of the user *is* the signature. We can swap in real crypto later without changing the `checkPermission()` interface.

<!-- 
Is there any reason we can't just move to a public/private key pair now (or even just depend on a GPG library)?
 -->

**2. Replay attacks.**
If a user signs an approval for "execute shell command `ls`", can that signed approval be replayed to approve a *different* shell command? The signature needs to bind to the specific tool-call frame (by ID, or by content hash). Otherwise a single approval grants blanket access.

<!--
What if the thing signed is the frame ID being approved? Duplicates of frame_id is invalid is disallowed.
 -->

**3. Scope of pre-approvals.**
"Global/scoped signed approvals" — these are powerful and dangerous. A pre-approval that says "user X approves all shell commands" is a valid use case, but it's also a wide-open door. The scoping needs to be precise: what tool, what parameters, what session, what time window. This is a UX design problem as much as a security one.

<!--
Yes, this could be a problem. Also, if we are approving the frame via signing the frame id, this also won't work. Thoughts? I do want to allow "dangerous mode" where all permissions are automatically approved.

However, to auto-approve permissions, we will need to think of something. What if we have the system itself sign such requests?

This makes me consider a problem with our current system though: user signing keys are encrypted, and user interaction is required to get to the keys. So an "always allow" can't be per-user. It has to be per-session, and signed by the system. 

Maybe we simplify all things, and just make all signatures system signatures? We can then have an audit-trail for which user requested the signing (and was authenticated and approved by the system).
 -->

**4. Revocation.**
If a user grants a standing approval and later revokes it, how does the system know? The signed frame still exists. You'd need either: expiration timestamps on approvals, a revocation list, or version numbers where newer revocations override older approvals.

<!--
We could always commit an update that revokes the signing. However, this doesn't seem like it will actually be a problem. If a user auto-approves a bunch of tools, and then revokes that auto-approval, well those tools have already run, so why does it matter? Anything that hasn't already been approved and executed, well, it will just need manual approval instead.
 -->

None of these are blockers for Phase C. But they're worth thinking about now so the `checkPermission()` interface is designed to handle them later. The method signature probably needs to accept the specific thing being checked (tool name, parameters) so the verification can bind to the right scope.

<!--
Good thoughts here! Help me think through this.
 -->

---

<!-- ═══════════════════════════════════════════════════════════════════════════ -->
<!-- CONVERSATION BOUNDARY — 2026-03-07 — Claude's Response: Signing Model     -->
<!-- ═══════════════════════════════════════════════════════════════════════════ -->

---

Let me think through each of your responses. You're pulling on threads that are converging toward a cleaner answer than any of the options I originally proposed.

### 1. Key pairs now — can we just do it?

No real reason we can't. Node.js has `crypto.generateKeyPairSync` / `crypto.sign` / `crypto.verify` built in. No external dependency needed. Ed25519 is fast, small keys (32 bytes), small signatures (64 bytes), and is the modern standard for this kind of thing.

```js
import { generateKeyPairSync, sign, verify } from 'node:crypto';

// Generate
const { publicKey, privateKey } = generateKeyPairSync('ed25519');

// Sign
const signature = sign(null, Buffer.from(frameId), privateKey);

// Verify
const valid = verify(null, Buffer.from(frameId), publicKey, signature);
```

That's it. No GPG needed. The question is just *when* keys get generated and *where* they're stored. For now: generated on user creation, private key stored encrypted in the DB (or derived from their password), public key stored plainly. But this brings us to the problem you identified...

### 2. Replay — signing the frame ID

Signing the frame ID works perfectly for per-request approvals. Frame IDs are unique. If I sign `frm_abc123`, that signature is only valid for `frm_abc123`. Can't replay it against `frm_xyz789`. Problem solved.

### 3. Pre-approvals — this is the hard one, and you've landed on the answer

You walked yourself through the problem and arrived at: **system signatures with user audit trail.**

Let me trace your reasoning and make sure we agree:

**The problem:** Per-frame signing (sign the frame ID) can't express "always approve shell commands." You'd need the user's private key to sign future frame IDs, but the private key is encrypted and requires user interaction.

**Your proposed solution:** The *system* signs approvals. The system has its own key pair. When a user says "always allow shell commands in this session," the system records: "User X (authenticated, verified) authorized auto-approval for [scope]. System signing all matching requests on their behalf." The system signs future tool-call approvals using the system key, with an audit record pointing back to the user's authorization.

This gives you two tiers:

| Tier | Who Signs | When | Trust Model |
|------|-----------|------|-------------|
| **Per-request** | System (on behalf of authenticated user) | User clicks "Approve" on a specific tool call | User authenticated → system signs the specific frame ID |
| **Standing approval** | System (on behalf of authenticated user) | User configures "always allow X" | User authenticated → system records the rule → system auto-signs matching frames |

Wait — I just realized something. With your model, *both* tiers are actually system signatures. The difference is just whether the user explicitly approved *this specific request* or *a class of requests*. In both cases, the system does the signing because it's the one that verified the user's identity.

This simplifies everything dramatically:

- **One signing key**: the system's key pair. Not per-user keys.
- **`checkPermission()` verifies**: system signature on the approval frame.
- **Audit trail**: the approval frame records *which user* authorized it and *how* (explicit click vs standing rule).
- **No user key management**: users authenticate via password/session token (as they do now). The system acts as their signing proxy.

Per-user key pairs become a federation concern only — needed when you can't trust the system to honestly report "user X authorized this." On a single server, the system *is* the trusted authority.

<!--
Yes, but I have a concern. What if we have compromised keys?

I was also thinking we could sign "on behalf" of a specific user. In the case of user-approve, this is straight forward. In the second case, the system is signing on behalf of the user, but that is upon behalf of the users' permanent global approval, that was signed by the user.

The interesting part about this idea is that the system is always the signer, but only ever on behalf of another actor. This would be interesting from a few different perspectives. One of them would be that if a user was removed from an organization, all their permissions requests now become invalid, because the system attempts to sign on behalf on an approval request that has been deleted. What I am describing here is "onion encryption", or "envolope" encryption.

This still doesn't fix out issue with a compromised system key. I guess maybe keys could be timstamped? So that the key selected for varification would be chosen based on a date rane? This way, when we rotate keys, we can still load and verify OLD data, but any NEW data can not be verified by an old key?
 -->

### 4. Revocation — you're right, it's a non-issue

Your logic is sound: if a tool was already approved and executed, revoking the approval retroactively is meaningless — the tool already ran. For future requests, the system just stops auto-signing. `checkPermission()` checks for a valid standing approval *at the time of the request*. If the standing approval has been revoked (new commit that nullifies it), the system won't auto-sign, and the tool call falls back to manual approval.

No revocation list needed. The commit log *is* the revocation list. A revocation is just another commit.

### Revised `checkPermission()` flow

```
checkPermission(toolName, params):
  1. Look for a system-signed approval frame for THIS frame ID
     → Found + valid signature? Return approved.

  2. Look for a standing approval rule matching (toolName, params, session scope)
     → Found + not revoked? System auto-signs this frame ID. Return approved.

  3. No approval found.
     → Create permission-request frame.
     → Return denied (caller should call done()).
```

### One remaining question

With system-only signing, the "dangerous mode" (auto-approve everything) is just a system-level standing approval with scope `*`. The system auto-signs every tool call. Clean, auditable, and easily toggled per-session.

But: should "dangerous mode" be per-session, per-user, per-org, or global? My instinct says per-session is the safest default. A user can say "I trust this agent in this session" without accidentally granting blanket access across all sessions.

<!--
I agree. I can see other possibilites in the future, but I think this is a good start.
 -->

---

<!-- ═══════════════════════════════════════════════════════════════════════════ -->
<!-- CONVERSATION BOUNDARY — 2026-03-07 — Claude's Response: Envelope Signing  -->
<!-- ═══════════════════════════════════════════════════════════════════════════ -->

---

### Envelope signing — "system always signs on behalf of"

This is a really elegant model. Let me make sure I'm following the layers:

**Layer 1 — Per-request approval:**
- User clicks "Approve" for a specific tool call
- System signs: `sign(frameId, systemPrivateKey)`
- Approval record: `{ frameId, approvedBy: userId, type: 'explicit', systemSig: '...' }`

**Layer 2 — Standing approval (auto-approve):**
- User previously signed a standing rule: `sign('allow:shell:*:session:ses_abc', userPrivateKey)` → stored as a standing-approval frame
- Tool call comes in matching the rule
- System verifies the standing approval is valid (user's signature checks out, user still exists, user still in org)
- System signs *on behalf of* the user: `sign(frameId + standingApprovalFrameId, systemPrivateKey)`
- Approval record: `{ frameId, approvedBy: userId, type: 'standing', standingApprovalRef: standingApprovalFrameId, systemSig: '...' }`

The "envelope" part: the system signature wraps a reference to the user's authorization. It's a chain: system signed this frame → because user signed that standing approval → which covers this scope. If the user is removed from the org, their standing approval frame becomes invalid (user no longer authorized), so the system refuses to sign on their behalf. The chain breaks naturally.

Wait — but you said user keys are encrypted and require user interaction. So at Layer 2, the user *did* interact once (to create the standing approval). That standing approval was signed with their key at that time. The system then references that signed artifact for future auto-approvals. The user doesn't need to interact again until the standing approval is revoked or expires.

That's clean. The user's signature is a *one-time delegation* to the system for a specific scope. The system carries it forward.

<!--
Yes, the user's PRIVATE key is encrypted. Their public key is still available. So their signature can be verified.

You are making this envelope encryption idea harder than it needs to be.

A signing request is:
`{authUserID:..., frameID:..., ts:timestamp, whatever...}`

In this very specific order. This is then the literal data that is used for the verification.
The user signs this blob of data, and stores the result in the frame. The verification can happen with the user's public key, and further verification can be had by knowing it was this very specific set of deterministic data that WAS signed, garenteeing the original intent was preserved.

Then, the system signs this request as well. The system signs the user's signature. This can be verified with te server's public key, and the comparison of it to deterministic (and true) ordered datapoints further guarentees legitimacy.

A request is only ever valid if it has a server signature signing a user's signature. In the case of an auto-approval, we wouldn't use datapoints like "frame id". Instead, we would use deterministic datapoints like the pattern itself `{authUserID:..., pattern:*, type:command, ts:...}`.

Does this make sense? Am I getting us any closer to an understanding?
 -->

### Compromised system key + key rotation

You're right to worry about this. If the system key is compromised, an attacker could forge approval signatures for any tool call.

Your timestamped key idea works. Here's a concrete approach:

**Key versioning:**
- System generates a new key pair periodically (or on demand via admin action)
- Each key pair has a `validFrom` / `validUntil` timestamp and a `keyVersion` integer
- When signing, the system uses the *current* key and stamps the `keyVersion` on the approval
- When verifying, `checkPermission()` looks up the key by `keyVersion` and checks that the approval timestamp falls within the key's validity window

```js
// System key store (in DB or config)
systemKeys = [
  { version: 1, publicKey, privateKey, validFrom: '2026-01-01', validUntil: '2026-06-30' },
  { version: 2, publicKey, privateKey, validFrom: '2026-07-01', validUntil: null },  // current
];

// Sign with current key
approval = { frameId, keyVersion: 2, sig: sign(frameId, currentKey.privateKey) };

// Verify — look up key by version, check timestamp
const key = systemKeys.find(k => k.version === approval.keyVersion);
const valid = verify(frameId, key.publicKey, approval.sig)
           && approval.timestamp >= key.validFrom
           && (!key.validUntil || approval.timestamp <= key.validUntil);
```

**On compromise:**
- Rotate: generate new key pair, set `validUntil` on the old one
- Old approvals still verify (they were signed before compromise)
- New approvals can only be forged with the new key (which the attacker doesn't have)
- If you *know* the old key was compromised, you can invalidate it entirely (`compromised: true`), which invalidates all approvals signed with it. Nuclear option, but available.

This is straightforward to implement and doesn't add much complexity. The key store is just a small table. Signing adds a version number. Verification does one extra lookup.

<!--
Yay! Thank you for the feedback. 
 -->

### Where this leaves us for Phase C

Here's what I think the implementation priority looks like:

**Phase C (now):** `checkPermission()` uses system signing with the current (single) key. No key rotation yet, no user key pairs. System signs on behalf of authenticated users. Frame ID is the signed payload. Standing approvals scoped per-session.

**Later:** Key rotation, envelope signing with user standing-approval references, per-org/global scopes, federation with user key pairs.

The `checkPermission()` interface stays the same either way — the internals evolve, but the plugin just calls `await this.checkPermission(toolName, params)` and gets back approved/denied.

<!--
I can agree to a near-future plan for this. We can defer key rotation to another future plan. Please add it to our "future-plans". 
 -->

### Dangerous mode

Per-session, agreed. A session-scoped standing approval with scope `*`, signed by the system on behalf of the authenticated user who enabled it. Auditable, revocable, and contained.

<!--
Honestly I'd prefer this not to be any different than any other permissions. The user grants per-session approvals by default, and only when the user goes into "global permisions" in their prefernces can they create approvals (or denials) that are applied globally. But if they allow dangerous mode globally, well, that is their choice. We might provide a little warning for our convenience.
 -->

---

I think we've reached a natural stopping point on the signing/permissions design. We have enough clarity to build Phase C1 without painting ourselves into a corner on the security model. Want to keep going on conversation.md, or shall we start formalizing Phase C1?

<!--
Maybe, I still want to better understand envolope signing, and how it must be based on deterministic and verifiable states.
 -->

---

<!-- ═══════════════════════════════════════════════════════════════════════════ -->
<!-- CONVERSATION BOUNDARY — 2026-03-07 — Claude's Response: Deterministic Sig -->
<!-- ═══════════════════════════════════════════════════════════════════════════ -->

---

You're right, I was overcomplicating it. Let me restate the envelope signing model as you've described it — simply and concretely.

### The signing model, simplified

A signature is always computed over a **deterministic, ordered blob of data**. The blob is the proof of intent. If you can reconstruct the blob from known facts and the signature verifies, you know the intent was genuine.

**Per-request approval (user approves a specific tool call):**

```
// The deterministic data blob — order matters
blob = `${authUserID}:${frameID}:${timestamp}`

// User signs the blob with their private key
userSig = sign(blob, userPrivateKey)

// System verifies the user's signature with the user's public key
verify(blob, userPublicKey, userSig)  // → true

// System then signs the USER's signature with the system key
systemSig = sign(userSig, systemPrivateKey)

// Stored on the approval frame:
{ authUserID, frameID, ts: timestamp, userSig, systemSig }
```

**To verify:**
1. Reconstruct the blob from the stored fields: `${authUserID}:${frameID}:${ts}`
2. Verify `userSig` against the blob using the user's public key → proves the user intended to approve this exact frame at this exact time
3. Verify `systemSig` against `userSig` using the system's public key → proves the system witnessed and endorsed the user's approval

Both signatures must be present and valid. A request is only legitimate if **the system signed the user's signature**. The system won't sign unless it authenticated the user. The user can't fake the system signature. The system can't fake the user signature. Both parties must agree.

<!--
Curious... without access to the user's private key, what does reconstructing the blob do? How do we compare against the original? Can you explain this process to me? 
 -->

**Standing approval (auto-approve a pattern):**

```
// Different deterministic blob — no frameID, uses pattern instead
blob = `${authUserID}:${pattern}:${type}:${scope}:${timestamp}`
// e.g. "usr_abc:*:command:ses_xyz:1709827200"

userSig = sign(blob, userPrivateKey)
systemSig = sign(userSig, systemPrivateKey)

// Stored on the standing-approval frame:
{ authUserID, pattern: '*', type: 'command', scope: 'ses_xyz', ts: timestamp, userSig, systemSig }
```

**When a tool call comes in that matches a standing approval:**
1. System finds the matching standing-approval frame
2. System verifies both signatures on the standing approval (is it still valid?)
3. System checks: does user still exist? Still in org? Standing approval not revoked?
4. System creates a new per-request approval for *this* frame ID, but signed only by the system (the user's authority is *derived* from the standing approval)

```
// Auto-approved: system signs on behalf of user, referencing the standing approval
blob = `${authUserID}:${frameID}:${standingApprovalFrameID}:${timestamp}`
systemSig = sign(blob, systemPrivateKey)

// No userSig — the authority comes from the standing approval chain
{ authUserID, frameID, standingApprovalRef: standingApprovalFrameID, ts: timestamp, systemSig }
```

The verification chain: system signed this → because standing approval X exists → standing approval X was signed by user Y → user Y is still authorized.

<!--
Correct, you got the concept down. 
 -->

### Why deterministic data matters

The blob isn't random metadata. It's a precise statement of intent reconstructable from verifiable facts:

- `authUserID` — who authorized it (verifiable: user exists in DB)
- `frameID` — what was authorized (verifiable: frame exists in commit log)
- `timestamp` — when it was authorized (verifiable: within key validity window)
- `pattern` / `type` / `scope` — what class of actions was authorized (verifiable: matches the tool call being checked)

If any of these are tampered with, the signature won't verify because the reconstructed blob won't match what was originally signed. You can't change the frameID and keep the signature valid. You can't change the userID. You can't backdate it. The signature binds all the fields together.

<!--
Exactly. 
 -->

### Dangerous mode = just another standing approval

No special system. User goes to session settings (or global preferences), enables "auto-approve all" for some scope. This creates a standing-approval frame with `pattern: '*'`. Same signing. Same verification. Same audit trail. If they do it globally, it's `scope: 'global'` instead of `scope: 'ses_xyz'`. We can show a warning ("This grants blanket approval across all sessions — are you sure?") but ultimately it's their choice.

<!--
Yep! 
 -->

### Key rotation — added to future-plans

Per your request, I'll add key rotation to the future-plans after this response.

<!--
Yes please, and thank you! 
 -->

### Where I think we are now

The signing model is:
1. **Deterministic blobs** — ordered fields that capture intent
2. **User signs the blob** (per-request) or **signed it once** (standing approval)
3. **System signs the user's signature** — endorsement by the trusted authority
4. **Verification reconstructs the blob** and checks both signatures
5. **Auto-approval** = system signs on behalf of user, referencing a valid standing approval

Does this match your understanding? Anything I'm still getting wrong?

<!--
Yes, I think we are both on the same page. I'd like to understand the data point reconstruction, and how we use that to validate (via cryptographic hash? help me understand...)
 -->

---

<!-- ═══════════════════════════════════════════════════════════════════════════ -->
<!-- CONVERSATION BOUNDARY — 2026-03-07 — Claude's Response: How Signing Works -->
<!-- ═══════════════════════════════════════════════════════════════════════════ -->

---

### How public/private key signing actually works — the mechanics

Let me walk through this step by step, because it's genuinely elegant once you see what's happening mathematically.

**The key pair relationship:**

Ed25519 generates two keys that are mathematically linked:
- **Private key**: a 32-byte secret. Only the signer has this.
- **Public key**: a 32-byte value derived from the private key. Anyone can have this.

The magic: you can **sign** with the private key, and anyone with the public key can **verify** the signature is genuine — without ever seeing the private key. It's a one-way mathematical relationship.

**What `sign()` actually does:**

```
data = "usr_abc:frm_xyz:1709827200"    // the deterministic blob
signature = sign(data, privateKey)      // → 64 bytes of signature
```

Internally, `sign()` does:
1. Hash the data (Ed25519 uses SHA-512 internally)
2. Combine that hash with the private key using elliptic curve math
3. Produce a 64-byte signature that is *unique to both the data AND the key*

The signature is essentially: "this specific data was endorsed by the holder of this specific private key."

**What `verify()` actually does:**

```
data = "usr_abc:frm_xyz:1709827200"    // reconstructed from stored fields
valid = verify(data, publicKey, signature)  // → true or false
```

Internally, `verify()` does:
1. Hash the data the same way `sign()` did
2. Use the *public key* and the *signature* to check that the signature could only have been produced by the corresponding private key
3. Return true/false

**The key insight you're asking about — reconstruction:**

We don't compare blobs directly. We don't need the original blob. We **reconstruct** it from the stored fields and ask: "does the signature verify against this reconstructed data?"

Here's the concrete flow:

```js
// === AT APPROVAL TIME (user clicks "Approve") ===

// 1. Build the deterministic blob from current facts
let blob = `${authUserID}:${frameID}:${Date.now()}`;
// blob = "usr_abc:frm_xyz:1709827200"

// 2. User's client signs it
let userSig = sign(blob, userPrivateKey);
// userSig = <64 bytes> — unique to this blob + this private key

// 3. Store the approval
approval = { authUserID: 'usr_abc', frameID: 'frm_xyz', ts: 1709827200, userSig };


// === AT VERIFICATION TIME (checkPermission called) ===

// 4. Read the stored approval
let { authUserID, frameID, ts, userSig } = approval;

// 5. RECONSTRUCT the blob from the stored fields — same format, same order
let reconstructed = `${authUserID}:${frameID}:${ts}`;
// reconstructed = "usr_abc:frm_xyz:1709827200"

// 6. Look up the user's PUBLIC key (stored openly in the DB)
let publicKey = await getUserPublicKey(authUserID);

// 7. Verify: does this signature match this data + this public key?
let valid = verify(reconstructed, publicKey, userSig);
// If someone tampered with authUserID, frameID, or ts in the stored approval,
// the reconstructed blob won't match what was originally signed,
// and verify() returns false.
```

**Why this works — the tamper scenarios:**

| Attack | What happens |
|--------|-------------|
| Change `frameID` in stored approval | Reconstructed blob is different → signature doesn't match → `verify()` returns false |
| Change `authUserID` in stored approval | Reconstructed blob different + wrong public key used → double fail |
| Change `ts` in stored approval | Reconstructed blob different → signature doesn't match |
| Forge a signature without the private key | Computationally infeasible (would take billions of years) |
| Copy signature to a different approval | Signature was computed over different data → won't verify against new blob |

The deterministic blob format is the contract between signer and verifier. Both sides agree: "this is the exact string that represents this approval." If the stored fields are tampered with, the reconstructed blob won't match, and the signature fails. If the signature is forged, the math fails. There's no way to cheat without the private key.

**No hash comparison needed.** The `verify()` function does all the cryptographic work internally. We just feed it: the reconstructed data, the public key, and the signature. It returns true or false. That's it.

### The envelope layer (system signing the user's signature)

Same principle, one layer deeper:

```js
// System signs the user's signature (not the blob — the signature itself)
systemSig = sign(userSig, systemPrivateKey);

// To verify the system layer:
let systemValid = verify(userSig, systemPublicKey, systemSig);
// Proves: the system endorsed this specific user signature
```

Both must pass:
1. `verify(reconstructedBlob, userPublicKey, userSig)` — user approved this data
2. `verify(userSig, systemPublicKey, systemSig)` — system endorsed the user's approval

Does this clarify the mechanics?

<!--
Fantastic! Yes, this is how I imagined it worked. Thanks for clarifying.

Do you think we are ready to update our plan? What about testing? What about verifying "done"?
 -->

---

<!-- ═══════════════════════════════════════════════════════════════════════════ -->
<!-- CONVERSATION BOUNDARY — 2026-03-07 — Claude's Response: Plan Readiness    -->
<!-- ═══════════════════════════════════════════════════════════════════════════ -->

---

### Are we ready to update the plan?

Yes, I think so. Our conversation.md dialog has resolved every open design question from the original architecture plan, and introduced several new decisions that weren't in the original. Let me inventory what's changed since the AGIS-produced plan:

**Decisions that refined the original plan:**

| Topic | Original Plan | After Dialog |
|-------|--------------|-------------|
| onChange signature | `onChange(previousValue, newValue)` | `onChange(propName, previousValue, newValue)` |
| Routing model | Broadcast with `handled` flag | **`next(ctx)`/`done(ctx)` middleware chain** |
| Plugin entry point | `onChange()` only | **`process(next, done)` as entry, `onChange()` as convenience helper** |
| Plugin lifecycle | Not specified | **Class registration, fresh instance per routing cycle, context on constructor** |
| Error handling | Not specified | **Missing next/done → log + call next. Throw → log + call next. Never break the chain.** |
| Permission architecture | Separate permission plugin in chain | **`checkPermission()` on BasePluginClass — a service, not middleware** |
| Permission approval flow | Permission plugin executes tool | **Permission plugin stamps frame, frame re-routes to tool plugin** |
| Protected properties | Options A/B/C proposed | **Not needed — security via signature verification** |
| Signing model | Deferred to federation | **System envelope signing for Phase C. Deterministic blobs. Key rotation deferred.** |
| Plugin storage loading | Engine loads into context | **Plugin JIT-loads its own data during async `process()`** |
| Dangerous mode | Not specified | **Standing approval with `pattern: '*'`, per-session default** |

**New concepts not in the original plan:**

1. **Envelope signing** — system always signs on behalf of authenticated user
2. **Standing approvals** — signed rules that authorize auto-approval for matching patterns
3. **`done()` function** — explicit chain termination (vs `next()` for continuation)
4. **Router safety net** — try/catch/finally around every plugin, chain never breaks
5. **Tool-call frame lifecycle** — `pending` → `approved` → `executing` → `complete`
6. **Plugin eviction** — future: disable plugin after N consecutive failures

### What about testing?

For Phase C1, here's what I think the test matrix looks like:

**Selector Compiler tests:**
- Parse `type:user-message` → matcher function
- Parse `type:tool-call[toolName=shell:execute]` → matcher with property check
- Parse `type:*` → catch-all matcher
- Parse `author:agent` → authorType matcher
- Invalid selector → throws at registration time
- Function predicate passed through unchanged

**Frame Router tests:**
- Frame creation triggers matched handlers (`onChange(propName, null, newValue)`)
- Frame update triggers matched handlers (`onChange(propName, oldValue, newValue)`)
- Silent commits do NOT trigger routing
- Handler errors caught, chain continues
- Missing `next()`/`done()` → logged, chain continues
- `done()` stops chain intentionally
- `next(ctx)` passes modified context to next plugin
- Re-entrant frame creation processed iteratively (no stack overflow)
- Multiple plugins match same frame → all invoked in order
- No matched plugins → no error, commit still persists
- `context.changes` correctly computed by router before dispatch

**BasePluginClass tests:**
- Constructor stores context on `this.context`
- `this.logger` available via context
- `processChanges()` iterates `context.changes` and calls `onChange()` per entry
- `checkPermission()` creates permission-request frame on denial
- `checkPermission()` returns approved when valid signature exists

**Silent commit tests:**
- `merge([frames], { silent: true })` creates commit with `silent: true`
- Silent commits in commit log (they're real commits)
- Silent commits do NOT trigger router
- Default merge (no options) triggers router

**Integration tests:**
- Full round-trip: frame created → selector matches → plugin.process() called → plugin creates new frame → second routing cycle fires
- Permission flow: tool-call → checkPermission fails → permission-request created → user approves → signed commit → tool-call re-routes → checkPermission passes → tool executes

### What about verifying "done"?

For Phase C1 to be "done":

1. **All new tests pass** (selector compiler, frame router, base plugin class, silent commits)
2. **All existing tests still pass** (1411+ tests, nothing broken)
3. **The router is wired into KikxCore** and fires on non-silent merges
4. **At least one plugin registered via `registerSelector()`** and triggered by a frame mutation (even if it's a test-only plugin)
5. **Silent commits proven** — a merge with `{ silent: true }` does NOT trigger routing

Phase C1 does NOT include:
- Migrating scheduling to the router (that's C2)
- Migrating permissions to the router (that's C3)
- Migrating hooks (C4)
- Slimming InteractionLoop (C5)
- Envelope signing implementation (deferred, but the `checkPermission()` interface is ready for it)

Phase C1 is the foundation. If it's solid, everything else bolts on incrementally.

Shall I update the plan in bot-docs to reflect all of this?

<!--
Yes, please do. We are adding all C* plans, yes? We would just _start integrating_ Phase C1 first, correct?
 -->

---

<!-- ═══════════════════════════════════════════════════════════════════════════ -->
<!-- CONVERSATION BOUNDARY — 2026-03-07 — Claude's Response: Plan Update       -->
<!-- ═══════════════════════════════════════════════════════════════════════════ -->

---

Yes, exactly. The bot-docs plan will cover all of C1 through C5, but implementation starts at C1. Each phase has its own "done" criteria. You don't touch C2 until C1 is solid.

I'll update the bot-docs plan now — the reactive-frame-engine.yaml — to reflect everything from our dialog. This will be a substantial revision incorporating all the design decisions we've made.
