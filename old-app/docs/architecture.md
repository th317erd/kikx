# Architecture Overview

## High-Level Design

```
┌─────────────────────────────────────────────────────────────────┐
│                         Browser (SPA)                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Session: dev │  │ Session: prod│  │ Session: test│  (tabs)  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
└─────────┼─────────────────┼─────────────────┼──────────────────┘
          │                 │                 │
          └────────────────┬┴─────────────────┘
                           │ HTTP/SSE/WebSocket
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      nginx (reverse proxy)                       │
│              https://wyatt-desktop.mythix.info/kikx/             │
└─────────────────────────────────────────────────────────────────┘
                           │
                           │ strips /kikx/ prefix
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Node.js Server (Express)                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │   Auth      │  │   Routes    │  │  WebSocket  │              │
│  │  (JWT)      │  │  (API/SSE)  │  │   Handler   │              │
│  └─────────────┘  └─────────────┘  └──────┬──────┘              │
│                                           │                      │
│  ┌────────────────────────────────────────┴──────────────────┐  │
│  │                  Streaming HML Pipeline                    │  │
│  │   Text Stream → Parser → Element Events → Execution       │  │
│  └────────────────────────────────────────┬──────────────────┘  │
│                                           │                      │
│  ┌────────────────────────────────────────┴──────────────────┐  │
│  │                   Interactions System                      │  │
│  │   Detector → InteractionBus → Function Handler → Result   │  │
│  └────────────────────────────────────────┬──────────────────┘  │
│                                           │                      │
│  ┌────────────────────────────────────────┴──────────────────┐  │
│  │                    Agent Abstraction                       │  │
│  │   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │  │
│  │   │ ClaudeAgent │  │ OpenAIAgent │  │    ...      │       │  │
│  │   └─────────────┘  └─────────────┘  └─────────────┘       │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                           │
                           │ API calls (streaming)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                External APIs (Claude, OpenAI, etc.)              │
└─────────────────────────────────────────────────────────────────┘
```

## Core Concepts

### Sessions

A **session** is a named conversation with an agent. Sessions are:

- **Named** - Identified by database ID, displayed by name
- **Persistent** - Stored in SQLite with encrypted messages
- **Independent** - Each browser tab can have a different session
- **User-scoped** - Sessions belong to authenticated users
- **Archivable** - Soft-delete via archive flag, recoverable

### Agents

An **agent** is a configured AI backend. Each agent has:

- **Type** - The base provider (claude, openai)
- **API Key** - Encrypted, never exposed to frontend
- **Config** - JSON blob merged into API calls (model, maxTokens, etc.)
- **Default Processes** - System prompts automatically included

### Kikx Markup Language (HML)

**HML** is a custom markup format for rich agent responses:

#### Executable Elements
Execute on the server, results returned to agent:

| Element | Purpose | Attributes |
|---------|---------|------------|
| `<websearch>` | Web search | - |
| `<bash>` | Shell command | `cwd`, `timeout` |
| `<ask>` | User question | `timeout`, `default`, `options` |

#### Display Elements
Rendered in the UI only:

| Element | Purpose | Attributes |
|---------|---------|------------|
| `<thinking>` | Processing indicator | - |
| `<todo>` | Task list | `title` |
| `<item>` | Todo item (inside todo) | `status` |
| `<progress>` | Progress bar | `value`, `max`, `status` |
| `<link>` | Clickable link | `href` |
| `<copy>` | Copy button | `label` |
| `<result>` | Command output | `for`, `status` |

### Abilities

**Abilities** are the unified system for all extensibility:

- **Processes** - Instruction macros with templating (skills, prompts)
- **Functions** - Executable code (websearch, bash, plugins)

```javascript
{
  id: string,
  name: string,
  type: 'function' | 'process',
  source: 'builtin' | 'system' | 'user' | 'plugin',
  content?: string,           // For processes
  execute?: Function,         // For functions
  permissions: {
    autoApprove: boolean,
    dangerLevel: 'safe' | 'moderate' | 'dangerous',
  }
}
```

#### Startup Abilities

Abilities with names matching `_onstart_*` inject on session start:
- `__onstart_` (double underscore) runs first
- Sorted by underscore count descending, then alphabetically

### Interactions System

**Interactions** are the communication format between agents and the system. The agent uses a simple target/method/args pattern:

```
@system(websearch, { query: "hiking boots" })
@user(notify, { message: "Done!" })
@agent(queue, { message: "Follow-up task" })
```

The interactions system consists of:

- **InteractionBus** - Central pub/sub message router
- **Detector** - Parses agent responses for `@target(method, args)` patterns
- **InteractionFunction** - Base class for all function handlers
- **SystemFunction** - Routes @system calls to registered function classes

#### Function Registration

All functions inherit from `InteractionFunction` and self-register with metadata:

```javascript
class WebSearchFunction extends InteractionFunction {
  static register() {
    return {
      name:       'websearch',
      permission: PERMISSION.ALWAYS,
      schema: {
        query: { type: 'string', required: true },
      },
      examples: [
        { method: 'search', args: { query: 'hiking boots' } },
      ],
    };
  }

  async search({ query }) {
    // Implementation
  }
}

registerFunctionClass(WebSearchFunction);
```

#### Permission Levels

```javascript
const PERMISSION = {
  ALWAYS: 'always',  // Auto-approve
  ASK:    'ask',     // Prompt user
  NEVER:  'never',   // Always deny
};
```

### Assertions (Legacy)

**Assertions** are the legacy operation format, still supported for backwards compatibility:

```json
{ "id": "...", "assertion": "command", "name": "web_search", "message": "..." }
```

Assertion types:
- `command` - Execute an operation
- `question` - Prompt user for input
- `response` - Display message to user
- `thinking` - Show processing status
- `link` - Clickable reference
- `todo` - Task list
- `progress` - Progress indicator

## Data Flow

### Streaming Message Flow (Default)

```
User types message
       │
       ▼
Frontend sends POST /api/sessions/{id}/messages/stream
       │
       ▼
Server sets up SSE connection
       │
       ▼
Server builds rich context (agent, session, user)
       │
       ▼
Agent API called with streaming enabled
       │
       ▼
┌──────────────────────────────────────┐
│     Streaming HML Pipeline           │
│  ┌─────────────────────────────────┐ │
│  │ For each text chunk:            │ │
│  │   → Feed to StreamingHMLParser  │ │
│  │   → Emit SSE: text event        │ │
│  │                                 │ │
│  │ On element_start:               │ │
│  │   → Emit SSE: element_start     │ │
│  │                                 │ │
│  │ On element_update:              │ │
│  │   → Emit SSE: element_update    │ │
│  │                                 │ │
│  │ On element_complete:            │ │
│  │   → Emit SSE: element_complete  │ │
│  │   → If executable: execute      │ │
│  │   → Emit SSE: element_result    │ │
│  └─────────────────────────────────┘ │
└──────────────────────────────────────┘
       │
       ▼
SSE: message_complete
       │
       ▼
Frontend updates UI progressively
```

### Batch Message Flow (Legacy)

```
User types message
       │
       ▼
Frontend sends POST /api/sessions/{id}/messages
       │
       ▼
Server builds rich context (agent, session, user)
       │
       ▼
Message sent to Agent API (non-streaming)
       │
       ▼
Response parsed for HML elements
       │
       ▼
┌──────────────────────────────────────┐
│      Assertion Pipeline              │
│  ┌─────────────────────────────────┐ │
│  │ For each assertion:             │ │
│  │   → Validate format             │ │
│  │   → Determine sequential/parallel│ │
│  │   → Execute through handlers    │ │
│  │   → Broadcast via WebSocket     │ │
│  └─────────────────────────────────┘ │
└──────────────────────────────────────┘
       │
       ▼
Results sent back to agent (if command)
       │
       ▼
Final response via HTTP
```

### SSE Event Types

```javascript
// Message lifecycle
{ event: 'message_start', data: { messageId, sessionId, agentName } }
{ event: 'text', data: { messageId, text } }
{ event: 'message_complete', data: { messageId, content, executedElements } }

// HML element lifecycle
{ event: 'element_start', data: { messageId, id, type, attributes, executable } }
{ event: 'element_update', data: { messageId, id, type, content, delta } }
{ event: 'element_complete', data: { messageId, id, type, content, executable, duration } }
{ event: 'element_executing', data: { messageId, id, type } }
{ event: 'element_result', data: { messageId, id, type, result } }
{ event: 'element_error', data: { messageId, id, type, error } }

// Tool use (for agents with native tools)
{ event: 'tool_use_start', data: { messageId, toolId, name } }
{ event: 'tool_result', data: { messageId, toolId, content } }

// Errors
{ event: 'error', data: { messageId, error } }
```

### Question Flow

```
Agent emits question assertion / <ask> element
       │
       ▼
Question handler detects mode:
├─ demand: Wait forever for user response
└─ timeout: Wait N ms, then use default
       │
       ▼
WebSocket: question_prompt sent to frontend
       │
       ▼
Frontend shows question UI
├─ demand: Targets main input, waits
└─ timeout: Shows countdown, input optional
       │
       ▼
User responds (or timeout fires)
       │
       ▼
WebSocket: question_response sent to server
       │
       ▼
Question handler resolves promise
       │
       ▼
Pipeline continues with answer
```

### WebSocket Message Types

```javascript
// Server → Client
{ type: 'message_start', sessionId, messageId }
{ type: 'message_chunk', sessionId, messageId, content }
{ type: 'message_end', sessionId, messageId }
{ type: 'assertion_update', messageId, assertionId, status, result }
{ type: 'question_prompt', messageId, assertionId, question, mode, timeout }
{ type: 'operation_start', sessionId, operationId, command }
{ type: 'operation_complete', sessionId, operationId, result }
{ type: 'operation_error', sessionId, operationId, error }

// Stream broadcasts (SSE events mirrored to WS for other clients)
{ type: 'stream_text', sessionId, messageId, text }
{ type: 'stream_element_start', sessionId, ... }
{ type: 'stream_element_complete', sessionId, ... }

// Client → Server
{ type: 'abort', sessionId }
{ type: 'question_response', assertionId, answer }
{ type: 'ability_approval_response', executionId, approved }
```

## Key Design Decisions

### Dual Message Modes

Supporting both streaming and batch modes enables:
- **Streaming** - Better UX with progressive rendering, real-time feedback
- **Batch** - Simpler debugging, deterministic behavior, FIFO processing

Toggle via `/stream on|off` command.

### Progressive HML Parsing

The `StreamingHMLParser` uses EventEmitter pattern:
- Buffers partial tags until complete
- Emits events as elements are detected
- Handles nested elements and malformed markup gracefully
- Executes elements as they complete (not waiting for full response)

### Unified Abilities

Consolidating processes, commands, functions into abilities enables:
- Single registry for all extensibility
- Consistent permission model
- Plugin system with ability exports
- Startup injection via naming convention

### Assertion-Based Operations

Moving from simple commands to typed assertions enables:
- Different handling per assertion type
- Questions that can block or timeout
- Status updates without blocking
- Parallel execution of independent tasks

### Middleware Pipeline

All operations flow through the same pipeline:
- Handlers can transform, intercept, or pass through
- Easy to add cross-cutting concerns (logging, rate limiting)
- Handlers are sorted alphabetically for predictable order

### Encrypted Storage

Sensitive data is encrypted at rest:
- Messages use per-user data keys
- Agent API keys encrypted
- Agent configs encrypted
- User processes encrypted

## File Structure

```
server/
├── server.mjs              # Express server entry
├── database.mjs            # SQLite connection & migrations
├── encryption.mjs          # AES encryption utilities
├── config.mjs              # Configuration loading
├── routes/
│   ├── auth.mjs            # Login/logout
│   ├── sessions.mjs        # Session CRUD
│   ├── messages.mjs        # Batch message handling
│   ├── messages-stream.mjs # SSE streaming endpoint
│   ├── agents.mjs          # Agent CRUD + config
│   ├── abilities.mjs       # Abilities CRUD
│   ├── processes.mjs       # Process CRUD (legacy)
│   └── help.mjs            # Help endpoint
├── middleware/
│   └── auth.mjs            # JWT verification
├── lib/
│   ├── agents/             # Agent implementations
│   │   ├── agent.mjs       # Base class
│   │   ├── claude-agent.mjs
│   │   └── index.mjs       # Registry
│   ├── abilities/          # Unified abilities
│   │   ├── index.mjs       # Exports
│   │   ├── registry.mjs    # Ability registry
│   │   ├── executor.mjs    # Execution with approval
│   │   └── loaders/        # Load abilities by source
│   │       ├── builtin.mjs
│   │       ├── system.mjs
│   │       ├── user.mjs
│   │       ├── plugin.mjs
│   │       └── startup.mjs
│   ├── markup/             # HML parsing
│   │   ├── index.mjs       # Exports
│   │   ├── parser.mjs      # Batch parser
│   │   ├── stream-parser.mjs # Streaming parser
│   │   └── executor.mjs    # HML execution
│   ├── operations/         # Operation handling
│   │   ├── index.mjs       # Detection & parsing
│   │   ├── executor.mjs    # Pipeline execution
│   │   └── registry.mjs    # Handler registry
│   ├── interactions/       # Interaction system
│   │   ├── index.mjs       # Exports
│   │   ├── bus.mjs         # InteractionBus pub/sub
│   │   ├── function.mjs    # Base InteractionFunction class
│   │   ├── detector.mjs    # Detects @target patterns
│   │   └── functions/      # Function implementations
│   │       ├── system.mjs  # @system router
│   │       └── websearch.mjs
│   ├── assertions/         # Assertion type handlers
│   │   ├── command.mjs
│   │   ├── question.mjs
│   │   ├── response.mjs
│   │   └── thinking.mjs
│   ├── processes/          # System processes
│   │   ├── index.mjs       # Loader
│   │   ├── act.md          # Action system
│   │   └── __onstart_.md   # Startup instructions
│   ├── plugins/            # Plugin system
│   │   └── loader.mjs
│   └── websocket.mjs       # WS connection handling
│
├── Additional Key Files:
│   ├── lib/abilities/conditional.mjs  # Conditional ability matching
│   ├── lib/interactions/functions/help.mjs
│   ├── lib/interactions/functions/prompt-update.mjs
│   └── lib/abilities/loaders/commands.mjs  # Command abilities
public/
├── index.html              # Main SPA
├── css/
│   ├── base.css            # Variables, reset
│   ├── chat.css            # Messages, streaming
│   ├── elements.css        # HML element styles
│   └── ...
└── js/
    ├── app.js              # Frontend logic
    ├── markup.js           # HML renderer
    └── components/
        └── hml-prompt.js   # Inline prompt Web Component
```

---

## Deep Dive: AI Agent Interaction System

This section details how the AI agent asks questions, steers conversations, and uses the abilities system.

### System Layers

```
┌─────────────────────────────────────────────────────────────┐
│                    ABILITIES SYSTEM                          │
│  (What the AI can do - processes, functions, commands)       │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                  INTERACTIONS SYSTEM                         │
│  (How the AI requests actions via <interaction> tags)        │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│              CONDITIONAL ABILITIES + HML PROMPTS             │
│  (Conversation steering via context-aware triggers)          │
└─────────────────────────────────────────────────────────────┘
```

### How the AI Requests Actions

The AI outputs `<interaction>` tags anywhere in its response:

```xml
<interaction>
{
  "interaction_id": "ws-12345",
  "target_id": "@system",
  "target_property": "websearch",
  "payload": { "query": "best running shoes" }
}
</interaction>
```

#### Interaction Message Format

```javascript
{
  interaction_id: string,    // Unique ID (agent generates)
  target_id: string,         // Target (@system, @user, function ID)
  target_property: string,   // Method to invoke
  payload: any,              // Data for the method
  ts: number,                // Timestamp (ms since epoch)
  source_id?: string,        // Source function ID
  session_id?: number,       // Session context
  user_id?: number,          // User context
  sender_id?: number,        // SYSTEM ONLY - indicates authorized user
}
```

#### Detection & Execution Flow

```
AI Response
    │
    ▼
detectInteractions(content)
    │ Parse <interaction> tags
    │ Handle nested </interaction> in JSON
    ▼
stripSensitiveProperties()
    │ Remove sender_id (agents can't spoof authorization)
    ▼
validateInteraction()
    │ Check required fields
    ▼
executeInteractions()
    │
    ├─► Permission Check (for @system targets)
    │       │
    │       ├─► Denied → queueAgentMessage('denied')
    │       │
    │       └─► Allowed → Continue
    │
    ▼
bus.send(interaction)
    │ Route to appropriate handler
    ▼
queueAgentMessage('completed' | 'failed')
    │
    ▼
formatInteractionFeedback()
    │ Format results for next AI turn
    ▼
Injected into conversation
```

#### Security: sender_id

The `sender_id` field indicates the interaction originated from an authenticated user (not the AI agent). This is **stripped during detection** so agents cannot spoof authorization:

```javascript
// detector.mjs
function stripSensitiveProperties(interaction) {
  let clean = { ...interaction };
  delete clean.sender_id;  // Agents cannot set this
  return clean;
}
```

Only the system can set `sender_id` when creating interactions from authenticated user actions.

### Registered System Functions

| Function | Description | Permission |
|----------|-------------|------------|
| `websearch` | Fetch web pages or search | ask |
| `help` | Get help information | always |
| `update_prompt` | Update hml-prompt answers | always |

### Conditional Abilities (Context-Aware Instruction Injection)

**Location:** `server/lib/abilities/conditional.mjs`

**Purpose:** Save tokens by only loading instructions when they're relevant.

The conditional abilities system is a **general-purpose pre-processing layer** that runs on **EVERY interaction** - every message the AI receives, including feedback from its own actions. Before the AI responds, the system:

1. Checks all registered conditional abilities against the current context
2. Only injects instructions for abilities that match
3. This prevents loading irrelevant instructions, saving tokens

```
┌─────────────────────────────────────────────────────────────────┐
│                   EVERY INTERACTION FLOW                         │
│                                                                  │
│  Incoming Content (user message, feedback, tool result, etc.)   │
│       │                                                          │
│       ▼                                                          │
│  checkConditionalAbilities(context)                              │
│       │                                                          │
│       ├─► No conditional abilities registered?                   │
│       │       │                                                  │
│       │       └─► SKIP (no processing needed) ─────────────┐     │
│       │                                                    │     │
│       ├─► For each conditional ability:                    │     │
│       │       │                                            │     │
│       │       ├─► matchCondition(context) → false? Skip    │     │
│       │       │                                            │     │
│       │       └─► matchCondition(context) → true? Add      │     │
│       │                                                    │     │
│       ▼                                                    │     │
│  Any matches?                                              │     │
│       │                                                    │     │
│       ├─► NO: SKIP (nothing to inject) ────────────────────┤     │
│       │                                                    │     │
│       └─► YES: formatConditionalInstructions()             │     │
│               │                                            │     │
│               ▼                                            │     │
│       Append "[System: Conditional Ability...]"            │     │
│                                                            │     │
│       ┌────────────────────────────────────────────────────┘     │
│       │                                                          │
│       ▼                                                          │
│  Send to AI (original content, or with injected instructions)    │
└─────────────────────────────────────────────────────────────────┘
```

**Key Point:** This is NOT just for prompts. Any context-aware logic can be a conditional ability:
- Detecting when the user is asking about a specific topic
- Recognizing patterns that need special handling
- Injecting project-specific instructions when relevant files are mentioned
- Triggering workflows based on conversation state

#### Structure

Each conditional ability has:

```javascript
{
  name: 'ability_name',
  applies: 'Freeform description of when this applies',
  matchCondition: (context) => {
    // Programmatic matcher
    // Returns: { matches: boolean, details?: object }
  },
  message: 'Instructions to inject when matched'
}
```

#### Example Use Cases

Conditional abilities can handle any context-aware logic:

| Use Case | Trigger Condition | Injected Instructions |
|----------|-------------------|----------------------|
| Prompt response | Unanswered `<hml-prompt>` exists | "User may be answering a prompt, use `update_prompt`" |
| Code review mode | User mentions PR/commit/diff | "Apply code review best practices..." |
| Sensitive topic | Detects keywords/patterns | "Handle with care, check policies..." |
| Project context | Specific file paths mentioned | "This project uses X framework..." |
| Tool guidance | User asks "how do I..." | "Available tools: websearch, bash..." |

#### Built-in Example: prompt_response_handler

This is the currently registered conditional ability. Others can be added.

```javascript
// builtin.mjs
{
  name: 'prompt_response_handler',
  type: 'process',
  description: 'Detects when user answers an hml-prompt via chat',
  applies: 'The user responds to an hml-prompt question without using the IPC layer',

  matchCondition: (context) => {
    let { userMessage, sessionID } = context;

    // If user's message contains <interaction>, they're using IPC
    if (userMessage.includes('<interaction>')) {
      return { matches: false };
    }

    // Check for unanswered prompts
    let unansweredPrompts = getUnansweredPrompts(sessionID);

    if (unansweredPrompts.length === 0) {
      return { matches: false };
    }

    // User sent message + there are unanswered prompts = likely answering
    return {
      matches: true,
      details: {
        unansweredPrompts,
        hint: 'The user may be responding to one of these prompts.'
      }
    };
  },

  message: `The user may be answering an hml-prompt question in regular chat.
            Use the update_prompt interaction to update the original prompt...`
}
```

#### Conditional Ability Flow

```javascript
// In messages-stream.mjs, before sending user message to AI:
let conditionalResult = await checkConditionalAbilities({
  userMessage: content,
  sessionID,
  recentMessages
});

if (conditionalResult.matched) {
  // Format and inject instructions
  let instructions = formatConditionalInstructions(conditionalResult.instructions);
  // Prepend to context as [System: Conditional Ability Triggered]
}
```

#### Output Format

When a conditional ability triggers, the AI receives:

```
[System: Conditional Ability Triggered]

**prompt_response_handler**: The user may be answering an hml-prompt question...
Details:
```json
{
  "unansweredPrompts": [
    { "messageID": 123, "promptID": "fav-color", "question": "What is your favorite color?" }
  ]
}
```
```

### HML Prompts (Inline Questions)

**Location:** `public/js/components/hml-prompt.js`

Web Component for inline user questions within AI responses.

#### How the AI Uses Them

The AI outputs in its response:

```html
I'd like to know more. <hml-prompt id="fav-color">What's your favorite color?</hml-prompt>
```

#### Web Component Structure

```javascript
class HmlPrompt extends HTMLElement {
  // Uses Shadow DOM for style encapsulation
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  // Observed attributes for reactivity
  static get observedAttributes() {
    return ['answered'];
  }

  // Key properties
  get promptId()   { return this.getAttribute('id'); }
  get isAnswered() { return this.hasAttribute('answered'); }
  get question()   { /* text content excluding <response> */ }
  get response()   { /* content of <response> element */ }
}
```

#### Rendering States

**Unanswered:**
```html
<hml-prompt id="fav-color">What's your favorite color?</hml-prompt>
```
Renders as: inline textarea with question as placeholder, blue styling

**Answered:**
```html
<hml-prompt id="fav-color" answered>
  What's your favorite color?
  <response>Blue, because it reminds me of the ocean.</response>
</hml-prompt>
```
Renders as: green styled inline text showing the answer

#### Answer Flow

```
User types answer in prompt
         │
         ▼
Press Enter
         │
         ▼
submitAnswer(answer)
         │
         ├─► Find parent [data-message-id] element
         │
         ▼
Dispatch 'prompt-submit' CustomEvent
    {
      bubbles: true,
      composed: true,  // Crosses shadow DOM
      detail: { messageId, promptId, question, answer }
    }
         │
         ▼
attachUserPromptHandlers() catches event (app.js)
         │
         ▼
Sends answer as new chat message
         │
         ▼
Updates prompt: setAttribute('answered', '')
         │
         ▼
Database updated via API
```

#### If User Answers in Chat Instead of Prompt

1. User types answer in main chat input (not the prompt)
2. `prompt_response_handler.matchCondition()` detects unanswered prompts exist
3. System injects instructions telling AI about the unanswered prompts
4. AI recognizes user's message is answering a prompt
5. AI sends `update_prompt` interaction:

```xml
<interaction>
{
  "interaction_id": "prompt-update-001",
  "target_id": "@system",
  "target_property": "update_prompt",
  "payload": {
    "message_id": 123,
    "prompt_id": "fav-color",
    "answer": "Blue"
  }
}
</interaction>
```

6. `PromptUpdateFunction` updates the stored message content in database
7. Frontend re-renders, showing the prompt as answered

### Command Abilities

**Location:** `server/lib/abilities/loaders/commands.mjs`

Commands are function abilities that can be invoked by the AI or user:

| Command | Description | Permission |
|---------|-------------|------------|
| `command_ability` | Create/edit/delete abilities | never (Ask Always) |
| `command_session` | Create/archive sessions | never (Ask Always) |
| `command_compact` | Force conversation compaction | always |
| `command_start` | Re-send startup abilities | always |
| `command_agent` | Create/configure agents | never (Ask Always) |

### Complete Flow Diagram

```
                         ┌───────────────────┐
                         │   __onstart_.md   │
                         │  (Core System     │
                         │   Instructions)   │
                         └─────────┬─────────┘
                                   │ Loaded on first message
                                   ▼
┌─────────────┐    ┌───────────────────────────────────┐    ┌─────────────┐
│   User      │◄──►│           AI Agent                │◄──►│  Abilities  │
│   Input     │    │                                   │    │  Registry   │
└─────────────┘    │  Outputs:                         │    └─────────────┘
                   │  - Text responses                 │           │
                   │  - <hml-prompt> for questions     │           │
                   │  - <interaction> for actions      │           ▼
                   └──────────────┬────────────────────┘    ┌─────────────┐
                                  │                         │ Conditional │
                                  ▼                         │  Abilities  │
                   ┌──────────────────────────────┐         └──────┬──────┘
                   │      Interaction Bus         │                │
                   │  Routes to: @system, @user   │◄───────────────┘
                   └──────────────┬───────────────┘    (Inject context)
                                  │
            ┌─────────────────────┼─────────────────────┐
            ▼                     ▼                     ▼
    ┌───────────────┐     ┌───────────────┐     ┌───────────────┐
    │  WebSearch    │     │    Help       │     │ PromptUpdate  │
    │  Function     │     │   Function    │     │   Function    │
    └───────────────┘     └───────────────┘     └───────────────┘
```

### Adding New Capabilities

#### Adding a New Interaction Function

1. Create function class in `server/lib/interactions/functions/`:

```javascript
// my-function.mjs
import { InteractionFunction, PERMISSION } from '../function.mjs';

export class MyFunction extends InteractionFunction {
  static get name() { return 'my_function'; }
  static get description() { return 'Does something useful'; }
  static get permission() { return PERMISSION.ASK; }

  static get inputSchema() {
    return {
      type: 'object',
      properties: {
        param: { type: 'string', description: 'A parameter' }
      },
      required: ['param']
    };
  }

  async execute(payload, context) {
    // Do something
    return { success: true, result: '...' };
  }
}
```

2. Register in `server/lib/interactions/index.mjs`:

```javascript
import { MyFunction } from './functions/my-function.mjs';
// ...
_registerFunctionClass(MyFunction);
```

#### Adding a New Command

Add to `server/lib/abilities/loaders/commands.mjs`:

```javascript
registerAbility({
  name: 'command_mycommand',
  type: 'function',
  source: 'builtin',
  description: 'Does something (Ask Always)',
  category: 'commands',
  permissions: {
    autoApprove: false,
    autoApprovePolicy: 'never',
    dangerLevel: 'moderate',
  },
  inputSchema: { /* ... */ },
  execute: executeMyCommand,
});
```

#### Adding a Conditional Ability

Add to `server/lib/abilities/loaders/builtin.mjs`:

```javascript
const BUILTIN_CONDITIONAL_ABILITIES = [
  // ...existing abilities...
  {
    name: 'my_conditional',
    type: 'process',
    description: 'Triggers when X happens',
    applies: 'Description of when this applies',
    matchCondition: (context) => {
      // Check context and return { matches: boolean, details?: object }
    },
    message: 'Instructions for the AI when this triggers...',
    permissions: { autoApprove: true, dangerLevel: 'safe' },
  },
];
```

### Key Design Principles

1. **Declarative & Extensible** - Add new abilities, functions, and triggers without modifying core code

2. **Security by Default** - `sender_id` cannot be spoofed by agents; permissions checked before execution

3. **Async Message Passing** - All interactions are asynchronous with status updates

4. **Graceful Degradation** - If user answers prompts in chat instead of inline, conditional abilities handle it

5. **Separation of Concerns**:
   - Abilities define *what* can be done
   - Interactions define *how* to request actions
   - Conditional abilities define *when* to inject context
   - HML prompts provide *inline UI* for questions
