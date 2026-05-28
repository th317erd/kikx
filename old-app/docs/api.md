# API Reference

All API endpoints are prefixed with `/kikx/api/` (after nginx strips the `/hero` prefix, the server sees `/api/`).

## Authentication

Authentication uses JWT tokens stored in httpOnly cookies.

### POST `/api/login`

Authenticate and receive a JWT token.

**Request:**
```json
{
  "username": "wyatt",
  "password": "secret"
}
```

**Response (200):**
```json
{
  "success": true
}
```

Sets `token` cookie (httpOnly, sameSite=strict, 30-day expiry).

**Response (401):**
```json
{
  "error": "Invalid credentials"
}
```

### POST `/api/logout`

Clear the auth cookie.

**Response (200):**
```json
{
  "success": true
}
```

---

## Sessions

All session endpoints require authentication.

### GET `/api/sessions`

List sessions for the authenticated user.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `archived` | boolean | `false` | Include archived sessions |
| `search` | string | - | Filter by name (case-insensitive contains) |

**Response (200):**
```json
{
  "sessions": [
    {
      "id": "abc123",
      "name": "dev",
      "agentId": 1,
      "agentName": "My Claude",
      "messageCount": 12,
      "preview": "Last message preview...",
      "archived": false,
      "createdAt": "2024-01-15T10:30:00.000Z",
      "updatedAt": "2024-01-15T14:22:00.000Z"
    }
  ]
}
```

### POST `/api/sessions`

Create a new session.

**Request:**
```json
{
  "name": "my-project",
  "agentId": 1,
  "systemPrompt": "You are a helpful assistant."
}
```

**Response (201):**
```json
{
  "id": "xyz789",
  "name": "my-project",
  "agentId": 1,
  "createdAt": "2024-01-15T10:30:00.000Z"
}
```

### GET `/api/sessions/:id`

Get a specific session with messages.

**Response (200):**
```json
{
  "id": "abc123",
  "name": "dev",
  "agentId": 1,
  "systemPrompt": "...",
  "messages": [
    { "role": "user", "content": "Hello", "hidden": false },
    { "role": "assistant", "content": [...], "hidden": false }
  ],
  "archived": false,
  "createdAt": "2024-01-15T10:30:00.000Z",
  "updatedAt": "2024-01-15T14:22:00.000Z"
}
```

**Note:** Messages with `hidden: true` are system messages (e.g., startup ability injections) that are sent to the AI but should not be displayed in the chat UI.
```

### PUT `/api/sessions/:id`

Update session metadata.

**Request:**
```json
{
  "name": "renamed-session",
  "systemPrompt": "New prompt"
}
```

**Response (200):**
```json
{
  "success": true
}
```

### DELETE `/api/sessions/:id`

Delete a session permanently.

**Response (200):**
```json
{
  "success": true
}
```

### POST `/api/sessions/:id/archive`

Archive a session (soft delete).

**Response (200):**
```json
{
  "success": true
}
```

### POST `/api/sessions/:id/unarchive`

Unarchive a session.

**Response (200):**
```json
{
  "success": true
}
```

### POST `/api/sessions/:id/clear`

Clear all messages in a session.

**Response (200):**
```json
{
  "success": true
}
```

---

## Messages

### POST `/api/sessions/:id/messages`

Send a message to a session (batch mode).

**Request:**
```json
{
  "content": "What files are in this directory?"
}
```

**Response (200):**
```json
{
  "content": [
    { "type": "text", "text": "I found the following files..." }
  ],
  "toolCalls": [],
  "stopReason": "end_turn"
}
```

### POST `/api/sessions/:id/messages/stream`

Send a message with streaming response via Server-Sent Events (SSE).

**Request:**
```json
{
  "content": "Search for hiking boots"
}
```

**Response:** SSE stream with the following event types:

#### Message Lifecycle Events

```
event: message_start
data: {"messageId":"uuid","sessionId":"abc123","agentName":"My Claude"}

event: text
data: {"messageId":"uuid","text":"I'll search for "}

event: text
data: {"messageId":"uuid","text":"hiking boots..."}

event: message_complete
data: {"messageId":"uuid","content":"Full response text","executedElements":2}
```

#### HML Element Events

```
event: element_start
data: {"messageId":"uuid","id":"elem-1","type":"websearch","attributes":{},"executable":true}

event: element_update
data: {"messageId":"uuid","id":"elem-1","type":"websearch","content":"hiking","delta":"hiking"}

event: element_complete
data: {"messageId":"uuid","id":"elem-1","type":"websearch","content":"hiking boots","executable":true,"duration":150}

event: element_executing
data: {"messageId":"uuid","id":"elem-1","type":"websearch"}

event: element_result
data: {"messageId":"uuid","id":"elem-1","type":"websearch","result":{"results":[...]}}

event: element_error
data: {"messageId":"uuid","id":"elem-1","type":"websearch","error":"Search failed"}
```

#### Tool Use Events (for agents with native tools)

```
event: tool_use_start
data: {"messageId":"uuid","toolId":"tool-1","name":"calculator"}

event: tool_result
data: {"messageId":"uuid","toolId":"tool-1","content":"42"}
```

#### Error Events

```
event: error
data: {"messageId":"uuid","error":"Connection failed"}
```

**Example JavaScript Client:**

```javascript
async function sendMessageStream(sessionId, content, callbacks) {
  const response = await fetch(`/api/sessions/${sessionId}/messages/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    let eventType = null;
    let eventData = null;

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        eventData = JSON.parse(line.slice(6));
      } else if (line === '' && eventType && eventData) {
        callbacks[eventType]?.(eventData);
        eventType = null;
        eventData = null;
      }
    }
  }
}

// Usage
sendMessageStream('session-123', 'Hello', {
  message_start: (d) => console.log('Started:', d.messageId),
  text: (d) => console.log('Text:', d.text),
  element_start: (d) => console.log('Element:', d.type),
  element_result: (d) => console.log('Result:', d.result),
  message_complete: (d) => console.log('Done:', d.content),
});
```

---

## Agents

### GET `/api/agents`

List all agents for the current user.

**Response (200):**
```json
{
  "agents": [
    {
      "id": 1,
      "name": "My Claude",
      "type": "claude",
      "apiUrl": null,
      "config": { "model": "claude-sonnet-4-20250514" },
      "defaultProcesses": ["act"],
      "createdAt": "2024-01-10T08:00:00.000Z",
      "updatedAt": "2024-01-10T08:00:00.000Z"
    }
  ]
}
```

### POST `/api/agents`

Create a new agent.

**Request:**
```json
{
  "name": "My Claude",
  "type": "claude",
  "apiKey": "sk-ant-...",
  "apiUrl": null,
  "config": { "model": "claude-sonnet-4-20250514", "maxTokens": 4096 },
  "defaultProcesses": ["act"]
}
```

**Response (201):**
```json
{
  "id": 1,
  "name": "My Claude",
  "type": "claude",
  "apiUrl": null,
  "defaultProcesses": ["act"],
  "createdAt": "2024-01-10T08:00:00.000Z"
}
```

### GET `/api/agents/:id`

Get a specific agent.

**Response (200):**
```json
{
  "id": 1,
  "name": "My Claude",
  "type": "claude",
  "apiUrl": null,
  "config": { "model": "claude-sonnet-4-20250514" },
  "defaultProcesses": ["act"],
  "hasApiKey": true,
  "createdAt": "2024-01-10T08:00:00.000Z",
  "updatedAt": "2024-01-10T08:00:00.000Z"
}
```

Note: API key is never returned, only `hasApiKey` boolean.

### PUT `/api/agents/:id`

Update an agent.

**Request:**
```json
{
  "name": "Renamed Agent",
  "apiKey": "new-key",
  "config": { "model": "claude-opus-4-20250514" }
}
```

**Response (200):**
```json
{
  "success": true
}
```

### DELETE `/api/agents/:id`

Delete an agent.

**Response (200):**
```json
{
  "success": true
}
```

### GET `/api/agents/:id/config`

Get the decrypted config for an agent.

**Response (200):**
```json
{
  "config": {
    "model": "claude-sonnet-4-20250514",
    "maxTokens": 4096,
    "temperature": 0.7
  }
}
```

### PUT `/api/agents/:id/config`

Update the config for an agent.

**Request:**
```json
{
  "config": {
    "model": "claude-opus-4-20250514",
    "maxTokens": 8192
  }
}
```

**Response (200):**
```json
{
  "success": true
}
```

---

## Abilities

Unified system for processes (instruction macros) and functions (executable code).

### GET `/api/abilities`

List all abilities for the current user.

**Response (200):**
```json
{
  "abilities": [
    {
      "id": "builtin-websearch",
      "name": "system_web_search",
      "type": "function",
      "source": "builtin",
      "description": "Search the web",
      "permissions": {
        "autoApprove": true,
        "dangerLevel": "safe"
      }
    },
    {
      "id": "system-act",
      "name": "act",
      "type": "process",
      "source": "system",
      "description": "Action system for AI agents"
    },
    {
      "id": 1,
      "name": "my_skill",
      "type": "process",
      "source": "user",
      "description": "Custom skill"
    }
  ]
}
```

### POST `/api/abilities`

Create a new user ability (process type only).

**Request:**
```json
{
  "name": "my_skill",
  "type": "process",
  "description": "A custom skill",
  "content": "# My Skill\n\nInstructions here..."
}
```

**Response (201):**
```json
{
  "id": 1,
  "name": "my_skill",
  "type": "process",
  "source": "user",
  "description": "A custom skill"
}
```

### GET `/api/abilities/:id`

Get ability details.

**Response (200):**
```json
{
  "id": 1,
  "name": "my_skill",
  "type": "process",
  "source": "user",
  "description": "A custom skill",
  "content": "# My Skill\n\nInstructions here...",
  "permissions": {
    "autoApprove": false,
    "dangerLevel": "safe"
  }
}
```

### PUT `/api/abilities/:id`

Update a user ability.

**Request:**
```json
{
  "name": "renamed_skill",
  "description": "Updated description",
  "content": "# Updated Content"
}
```

**Response (200):**
```json
{
  "success": true
}
```

### DELETE `/api/abilities/:id`

Delete a user ability.

**Response (200):**
```json
{
  "success": true
}
```

### PUT `/api/abilities/:id/permissions`

Update ability permissions.

**Request:**
```json
{
  "autoApprove": true,
  "dangerLevel": "moderate"
}
```

**Response (200):**
```json
{
  "success": true
}
```

---

## Processes

*Note: Processes API is maintained for backward compatibility. New code should use the Abilities API.*

### GET `/api/processes`

List all processes (system + user).

**Response (200):**
```json
{
  "system": [
    {
      "name": "act",
      "description": "Enables the AI to perform actions via JSON assertion blocks.",
      "properties": { "version": "2.0", "category": "core" },
      "type": "system"
    }
  ],
  "user": [
    {
      "id": 1,
      "name": "my_process",
      "description": "Custom process",
      "type": "user",
      "createdAt": "2024-01-10T08:00:00.000Z",
      "updatedAt": "2024-01-10T08:00:00.000Z"
    }
  ]
}
```

### POST `/api/processes`

Create a new user process.

**Request:**
```json
{
  "name": "my_process",
  "description": "What this process does",
  "content": "# Process Content\n\nInstructions here..."
}
```

**Response (201):**
```json
{
  "id": 1,
  "name": "my_process",
  "description": "What this process does",
  "type": "user",
  "createdAt": "2024-01-10T08:00:00.000Z"
}
```

### GET `/api/processes/system/:name`

Get a system process by name.

**Response (200):**
```json
{
  "name": "act",
  "content": "# Action System\n\nWhen you need to...",
  "description": "Enables the AI to perform actions via JSON assertion blocks.",
  "properties": { "version": "2.0", "category": "core" },
  "type": "system"
}
```

### GET `/api/processes/:id`

Get a user process with decrypted content.

**Response (200):**
```json
{
  "id": 1,
  "name": "my_process",
  "description": "What this process does",
  "properties": {},
  "content": "# Process Content\n\nInstructions here...",
  "rawContent": "...",
  "type": "user",
  "createdAt": "2024-01-10T08:00:00.000Z",
  "updatedAt": "2024-01-10T08:00:00.000Z"
}
```

### PUT `/api/processes/:id`

Update a user process.

**Request:**
```json
{
  "name": "renamed_process",
  "content": "# Updated Content"
}
```

**Response (200):**
```json
{
  "success": true
}
```

### DELETE `/api/processes/:id`

Delete a user process.

**Response (200):**
```json
{
  "success": true
}
```

---

## Help

### GET `/api/help`

Get comprehensive help data including commands, system functions, abilities, and assertions. Supports regex filtering for targeted lookups.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `filter` | string | - | Regex pattern to filter results by name or description |
| `category` | string | `all` | Category to return: `all`, `commands`, `functions`, `abilities`, `assertions` |
| `detailed` | boolean | `false` | Include detailed info (schemas, examples) |

**Response (200):**
```json
{
  "systemMethods": [
    {
      "name": "websearch",
      "description": "Fetch web pages or search the web",
      "permission": "always"
    },
    {
      "name": "help",
      "description": "Get help information about available commands, abilities, and functions",
      "permission": "always"
    },
    {
      "name": "update_prompt",
      "description": "Update an <hml-prompt> element with user's answer",
      "permission": "always"
    }
  ],
  "assertions": [
    { "type": "websearch", "description": "Search the web for information" }
  ],
  "processes": {
    "system": [
      { "name": "system_act", "description": "Action system for AI agents" }
    ],
    "user": []
  },
  "commands": {
    "builtin": [
      { "name": "help", "description": "Show this help information. Usage: /help [filter]" },
      { "name": "clear", "description": "Clear the current chat" }
    ],
    "user": []
  }
}
```

**Example - Filter by pattern:**
```
GET /api/help?filter=search
```

Returns only items matching "search" in name or description.

**Example - Get specific category with details:**
```
GET /api/help?category=functions&detailed=true
```

Returns only functions with full schema and examples.

**Response (400) - Invalid regex:**
```json
{
  "error": "Invalid regex pattern: Unterminated character class"
}
```

---

## WebSocket

Connect to `/kikx/ws` for real-time updates.

### Server → Client Messages

**Message streaming:**
```json
{ "type": "message_start", "sessionId": "abc123", "messageId": "msg-1" }
{ "type": "message_chunk", "sessionId": "abc123", "messageId": "msg-1", "content": "Hello" }
{ "type": "message_end", "sessionId": "abc123", "messageId": "msg-1" }
```

**Operation updates:**
```json
{ "type": "operation_start", "sessionId": "abc123", "operationId": "op-1", "command": "web_search" }
{ "type": "operation_complete", "sessionId": "abc123", "operationId": "op-1", "result": "..." }
{ "type": "operation_error", "sessionId": "abc123", "operationId": "op-1", "error": "..." }
```

**Assertion updates:**
```json
{ "type": "assertion_update", "messageId": "msg-1", "assertionId": "a-1", "status": "running" }
{ "type": "assertion_update", "messageId": "msg-1", "assertionId": "a-1", "status": "completed", "result": "..." }
```

**Question prompts:**
```json
{
  "type": "question_prompt",
  "messageId": "msg-1",
  "assertionId": "q-1",
  "question": "Should I proceed?",
  "mode": "demand"
}

{
  "type": "question_prompt",
  "messageId": "msg-1",
  "assertionId": "q-2",
  "question": "Any preference?",
  "mode": "timeout",
  "timeout": 30000,
  "default": "none"
}
```

### Client → Server Messages

**Abort operation:**
```json
{ "type": "abort", "sessionId": "abc123" }
```

**Answer question:**
```json
{ "type": "question_response", "assertionId": "q-1", "answer": "yes" }
```

---

## Error Responses

All error responses follow this format:

```json
{
  "error": "Description of what went wrong"
}
```

Common HTTP status codes:

| Code | Meaning |
|------|---------|
| 400 | Bad request (missing/invalid parameters) |
| 401 | Unauthorized (not logged in or invalid token) |
| 404 | Not found |
| 409 | Conflict (duplicate name) |
| 500 | Server error |
