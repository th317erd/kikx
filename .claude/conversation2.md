# Server Plan — Conversation Round 19

## Round 18 Resolved
- Prompts as inline HTML: **CONFIRMED**
- Prompt dismissal: blanks = "User refused to answer", defaults are valid
- Prompt state: tracked via FrameManager (survives reload/device switch)
- `hml-prompt-value`: **DROP IT** — just use `value` attribute on `hero-hml-prompt` itself

---

## Prompt State via FrameManager

You're absolutely right — I was wrong to say "no server-side prompt tracking." Prompts MUST have persistent state because:

1. **Browser reload**: User reloads before answering → prompts must still be interactive
2. **Device switch**: User answers from a different device → answers must show as answered
3. **History**: Scrolling back through old messages, answered prompts show green-success
4. **Multi-user**: Another participant needs to see that prompts were answered

FrameManager is the right home for this. Here's how it works:

### The Frame Model

**Agent's message frame** (stored in DB, contains the HTML with prompts):
```html
I'd love to help with colors!
<hero-hml-prompt name="primary" label="Primary color" input-type="color" default-value="#00e5ff"></hero-hml-prompt>
<hero-hml-prompt name="style" label="Theme style" input-type="select" options='["Bold","Subtle","Minimal"]'></hero-hml-prompt>
Pick your favorites!
```

**User submits answers** → Client sends to server → Server creates a **response frame** that targets the original message frame:

```json
{
  "type": "prompt-response",
  "targets": ["<original-message-frame-id>"],
  "content": {
    "values": {
      "primary": "#00e5ff",
      "style": "Bold"
    }
  }
}
```

FrameManager merges this via the targeting system (deep merge into the original frame's content). The original frame now has values associated with its prompts.

<!-- 
Exactly!
 -->

### Client Rendering

When the `hero-hml-prompt` WebComponent renders, it checks for its value in the frame's merged content:

- **No value** → interactive mode (form field, editable)
- **Has value** → answered mode (green-success color, read-only pill badge)
- **Blank/dismissed** → shows "User refused to answer" in muted style

The `name` attribute on each `<hero-hml-prompt>` is the key that maps to the value in the response frame's content.

### On Reload / Device Switch

1. FrameManager loads frames from DB (including the prompt-response frame)
2. Targeting system merges values into the original message frame
3. WebComponents render with values present → green-success mode
4. Unanswered prompts render as interactive (user can still answer)

### The Submit Flow

1. User fills in prompts within an interaction
2. Clicks Submit (interaction-level button)
3. For each `<hero-hml-prompt>` in the interaction:
   - If the user provided a value → include it
   - If the field is blank AND has a default → include the default (it's a valid answer)
   - If the field is truly blank (no default, no input) → include `null` (dismissed)
   <!-- Quick comment: Last time you forgot that a checkbox is binary, and by default always has a default. You wouldn't include the answer of a checkbox if the user didn't first check it, and then uncheck it. Please remember that binary fields automatically have a default. -->
4. Client sends the values to server
5. Server creates prompt-response frame targeting the message frame
6. Server also sends the values as a new user message to the agent:
   ```
   Primary color: #00e5ff
   Theme style: Bold
   ```
7. New interaction starts, agent sees the answers in conversation history

<!-- 
You got it!
 -->

---

## Drop `hero-hml-prompt-value`

You're right to question it. The original V1 concept was a separate component for displaying submitted answers as read-only pill badges. But that's unnecessary — `hero-hml-prompt` itself should handle both states:

| State | Rendering |
|-------|-----------|
| **Unanswered** | Interactive form field (input, select, color picker, etc.) |
| **Answered** | Green-success color, read-only pill badge showing the value |
| **Dismissed** | Muted "User refused to answer" text |

One component, two modes. The mode is determined by whether a value exists in the frame's merged content.

**Client-side change needed**: The existing `hero-hml-prompt` component (Wave G) needs to support read-only mode. The existing `hero-hml-prompt-value` component (Wave G, item 28) can be removed or repurposed.

<!-- 
You got it!
 -->

---

## Clarification on `<option>` Replacement

You mentioned `hero-hml-prompt-value` might have been intended to replace `<option>`. I think the original V1 intent was different — it was a separate read-only display component. But if you're thinking of using child elements to define options for select/radio prompts, that could work:

```html
<hero-hml-prompt name="color" label="Pick a color" input-type="select">
  <hero-hml-option value="red">Red</hero-hml-option>
  <hero-hml-option value="blue">Blue</hero-hml-option>
  <hero-hml-option value="green">Green</hero-hml-option>
</hero-hml-prompt>
```

vs the current attribute approach:
```html
<hero-hml-prompt name="color" label="Pick a color" input-type="select" options='["Red","Blue","Green"]'></hero-hml-prompt>
```

The attribute approach is simpler (one element, JSON in attribute). The child element approach is more HTML-native. Either works. Your call — or we can defer this to implementation time.

<!-- 
I'd like to have an <hero-hml-option>, or a <hero-hml-prompt type="radio">, or a <hero-hml-prompt type="check"> child elements for a "select" field "type".
 -->

---

## Updated Architecture Summary

| Layer | What | How |
|-------|------|-----|
| **Agent output** | HTML text with custom elements | Claude instructed to output HTML via system prompt |
| **Server sanitization** | Allowlist of safe tags + registered custom elements | `sanitize-html` or similar, in core |
| **Frame storage** | Message frames contain sanitized HTML | Mythix ORM, frame persistence |
| **Prompt state** | FrameManager targeting system | prompt-response frame targets original message frame, deep merge |
| **Client rendering** | WebComponents in Shadow DOM | `hero-hml-prompt` reads value from frame, switches mode |
| **Prompt submission** | Client → server → prompt-response frame + new user message | Triggers new interaction with answers in context |
| **Tool execution** | Structured tool calls (Claude API) | Server orchestrates, permissions, hard-break |

---

## Ready for Plan Tests?

I believe all architectural questions are now resolved. Shall I proceed to generate `bot-docs/test/meta.yaml` with plan test assertions and run them?

<!-- 
I think we are ready to update the plan, and plan tests too, yes. When the tests all pass, and the plan is updated, let's please commit and push our work.
 -->

---

*Answer inline.*
