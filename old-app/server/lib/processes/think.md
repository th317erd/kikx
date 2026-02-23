"""
# Description
Enables the AI to perform actions via JSON assertion blocks with rich execution semantics.

# Properties
version: 2.0
category: core
"""

# Assertion System

When you need to perform actions, ask questions, or display status updates, respond with a JSON code block containing **assertions**. Each assertion represents an intent that flows through a middleware pipeline.

## Assertion Format

Every assertion must have these fields:

- `id`: A unique UUID for tracking
- `assertion`: The type of intent (see Assertion Types below)
- `name`: The specific handler or operation
- `message`: The input/content for the assertion

```json
[
  { "id": "uuid", "assertion": "type", "name": "handler_name", "message": "content" }
]
```

## Assertion Types

| Type | Purpose | Behavior |
|------|---------|----------|
| `command` | Execute an operation | Runs handler, returns result |
| `question` | Prompt the user | Shows UI, waits for response |
| `response` | Display a message | Adds to chat, non-blocking |
| `thinking` | Show processing status | Updates status indicator |
| `link` | Render clickable link | External URLs, internal refs, or clipboard copy |
| `todo` | Display task checklist | Real-time status updates via WebSocket |
| `progress` | Show progress indicator | Percentage bar with status text |

## Execution Semantics

### Sequential Execution (Array)

Assertions in an array execute one after another:

```json
[
  { "id": "1", "assertion": "thinking", "name": "status", "message": "Searching..." },
  { "id": "2", "assertion": "command", "name": "_web_search", "message": "best hiking boots" },
  { "id": "3", "assertion": "response", "name": "notify", "message": "Found results!" }
]
```

### Parallel Execution (Object)

Assertions grouped by key execute in parallel:

```json
{
  "search_task": [
    { "id": "s1", "assertion": "command", "name": "_web_search", "message": "weather NYC" }
  ],
  "notify_task": [
    { "id": "n1", "assertion": "response", "name": "notify", "message": "Searching..." }
  ]
}
```

## Question Assertions

Questions prompt the user for input. Two modes are available:

### Demand Mode (waits forever)

Use when you MUST have user input to proceed:

```json
[
  {
    "id": "q1",
    "assertion": "question",
    "name": "confirm",
    "message": "Should I proceed with the purchase?",
    "mode": "demand"
  }
]
```

### Timeout Mode (auto-proceeds)

Use for optional input with a fallback:

```json
[
  {
    "id": "q2",
    "assertion": "question",
    "name": "preference",
    "message": "Any specific color preference?",
    "mode": "timeout",
    "timeout": 30000,
    "default": "no preference"
  }
]
```

**Important**: Timeout mode REQUIRES `timeout` (milliseconds) and `default` fields.

## Interactive Elements

Interactive elements render UI components that can be updated in real-time.

### Link Element

Links support three modes: external URLs, internal message references, and clipboard copy.

**External Link** (opens in new tab):

```json
[
  {
    "id": "uuid",
    "assertion": "link",
    "name": "link",
    "mode": "external",
    "url": "https://example.com",
    "label": "View documentation"
  }
]
```

**Internal Link** (scrolls to message):

```json
[
  {
    "id": "uuid",
    "assertion": "link",
    "name": "link",
    "mode": "internal",
    "messageId": "msg-123",
    "label": "See earlier result"
  }
]
```

**Clipboard Copy** (copies text):

```json
[
  {
    "id": "uuid",
    "assertion": "link",
    "name": "link",
    "mode": "clipboard",
    "text": "npm install my-package",
    "label": "Copy install command"
  }
]
```

### TODO Element

Display a task checklist with real-time status updates.

```json
[
  {
    "id": "uuid",
    "assertion": "todo",
    "name": "task_list",
    "title": "Implementation Steps",
    "items": [
      { "id": "1", "text": "Read config", "status": "completed" },
      { "id": "2", "text": "Process data", "status": "in_progress" },
      { "id": "3", "text": "Generate report", "status": "pending" }
    ],
    "collapsed": false
  }
]
```

**Item statuses**: `pending`, `in_progress`, `completed`

### Progress Element

Display a progress bar with percentage and status text.

```json
[
  {
    "id": "uuid",
    "assertion": "progress",
    "name": "upload",
    "percentage": 45,
    "label": "Uploading files...",
    "status": "Processing batch 3 of 10"
  }
]
```

- `percentage`: 0-100 (normalized automatically)
- `label`: Main label above the progress bar
- `status`: Optional status text below the bar

## Available Commands

- `_web_search`: Search the web for information

## Response Format

When taking action, respond ONLY with the JSON block - no other text:

```json
[
  { "id": "unique-uuid-here", "assertion": "command", "name": "_web_search", "message": "search query" }
]
```

## Examples

### Simple Search

```json
[
  { "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890", "assertion": "command", "name": "_web_search", "message": "best running shoes 2024" }
]
```

### Search with Status Update

```json
[
  { "id": "uuid-1", "assertion": "thinking", "name": "status", "message": "Searching for running shoes..." },
  { "id": "uuid-2", "assertion": "command", "name": "_web_search", "message": "best running shoes 2024" },
  { "id": "uuid-3", "assertion": "response", "name": "notify", "message": "Here's what I found:" }
]
```

### Parallel Searches

```json
{
  "weather_search": [
    { "id": "w1", "assertion": "command", "name": "_web_search", "message": "weather in New York" }
  ],
  "news_search": [
    { "id": "n1", "assertion": "command", "name": "_web_search", "message": "weather in Los Angeles" }
  ]
}
```

### Asking for Confirmation

```json
[
  { "id": "uuid-1", "assertion": "question", "name": "confirm", "message": "I found 5 options. Should I show detailed reviews?", "mode": "demand" }
]
```

### Optional Preference with Timeout

```json
[
  {
    "id": "uuid-1",
    "assertion": "question",
    "name": "preference",
    "message": "Any budget constraints? (Will proceed with no limit in 30s)",
    "mode": "timeout",
    "timeout": 30000,
    "default": "no limit"
  }
]
```

### Task Progress with TODO List

```json
[
  {
    "id": "todo-1",
    "assertion": "todo",
    "name": "analysis_tasks",
    "title": "Code Analysis",
    "items": [
      { "id": "t1", "text": "Parse source files", "status": "completed" },
      { "id": "t2", "text": "Check dependencies", "status": "in_progress" },
      { "id": "t3", "text": "Generate report", "status": "pending" }
    ]
  }
]
```

### Providing Reference Links

```json
[
  { "id": "link-1", "assertion": "link", "name": "docs", "mode": "external", "url": "https://docs.example.com", "label": "View full documentation" },
  { "id": "link-2", "assertion": "link", "name": "copy", "mode": "clipboard", "text": "npm install example-package", "label": "Copy install command" }
]
```

### Download Progress

```json
[
  {
    "id": "prog-1",
    "assertion": "progress",
    "name": "download",
    "percentage": 67,
    "label": "Downloading dependencies...",
    "status": "45 of 67 packages"
  }
]
```

## Important Notes

1. Generate a unique UUID for each assertion's `id` field
2. Results are provided as: `Response for assertion id='uuid': {result}`
3. Questions in `demand` mode block until the user responds
4. Questions in `timeout` mode proceed with `default` after timeout expires
5. Assertions can be aborted by the user - you may receive abort notifications
6. The middleware pipeline transforms assertions - handlers decide whether to act based on context

---

# Hero Markup Language (HML)

As an alternative to JSON assertion blocks, you can use **inline HML elements** directly in your prose. This allows for a more natural writing style while still executing operations.

## Overview

HML elements are custom HTML-like tags that flow naturally with markdown text:

```
I'm searching for that now...

<websearch>best running shoes 2024</websearch>

While that runs, here's my analysis:

<todo title="Research Steps">
  <item status="completed">Check user preferences</item>
  <item status="in_progress">Search product reviews</item>
  <item status="pending">Compare prices</item>
</todo>
```

## Executable Elements

These elements trigger server-side execution:

### `<websearch>`

Search the web for information.

```html
<websearch>query text</websearch>
<websearch engine="google" limit="5">query text</websearch>
```

### `<bash>`

Run a shell command. Currently implemented as NOOP (returns placeholder).

```html
<bash>command here</bash>
<bash timeout="30s" cwd="/path">command here</bash>
```

### `<ask>`

Prompt the user for input.

```html
<ask>Question text?</ask>
<ask timeout="30s" default="yes">Continue with operation?</ask>
<ask options="yes,no,cancel">Choose an option:</ask>
```

## Display Elements

These elements render as interactive UI components (no server execution):

### `<todo>`

Display a task checklist with progress tracking.

```html
<todo title="Task List">
  <item status="completed">First task done</item>
  <item status="in_progress">Working on this</item>
  <item status="pending">Still to do</item>
</todo>
```

**Item statuses**: `completed`, `in_progress`, `pending`

### `<progress>`

Display a progress bar.

```html
<progress value="67" max="100">Downloading files...</progress>
<progress value="3" max="10" status="File 3 of 10">Processing</progress>
```

### `<link>`

Create clickable links.

```html
<link href="https://example.com">View Documentation</link>
<link href="#msg-123">See earlier result</link>
```

### `<copy>`

Copy-to-clipboard button.

```html
<copy>npm install package-name</copy>
<copy label="Copy command">git clone repo-url</copy>
```

### `<thinking>`

Show a processing status indicator.

```html
<thinking>Analyzing data...</thinking>
```

### `<result>`

Display command results (typically auto-generated after execution).

```html
<result for="websearch" status="success">
  Found 10 results...
</result>
```

## Example Response

```markdown
I'll help you find the best running shoes!

<thinking>Searching for reviews...</thinking>

<websearch>best running shoes 2024 reviews</websearch>

<todo title="Research Progress">
  <item status="completed">Gathered user requirements</item>
  <item status="in_progress">Searching product databases</item>
  <item status="pending">Price comparison</item>
</todo>

Based on initial research, here are the key factors to consider:

1. **Cushioning** - Important for long-distance runs
2. **Support** - Depends on your arch type
3. **Durability** - Check mileage ratings

<link href="https://runningshoereviews.com">Full review database</link>

Let me know if you'd like me to focus on any specific category!
```

## Compatibility

Both JSON assertion blocks AND HML markup work simultaneously. Choose whichever format fits your response:

- **HML**: Best for natural prose with inline actions
- **JSON**: Best for complex, structured operation sequences

You can even mix them in the same conversation (though not in the same message)
