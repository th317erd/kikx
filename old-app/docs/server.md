# Server Design

The server is a Node.js Express application with SQLite database, supporting both batch and streaming message processing.

## Core Modules

### Streaming HML Parser

`lib/markup/stream-parser.mjs` - Progressive HML parsing using EventEmitter:

```javascript
import { EventEmitter } from 'events';

class StreamingHMLParser extends EventEmitter {
  constructor() {
    super();
    this.buffer = '';
    this.elementStack = [];
  }

  write(chunk) {
    this.buffer += chunk;
    this.processBuffer();
  }

  end() {
    // Flush remaining text, emit 'done'
  }

  processBuffer() {
    // Parse tags, emit events:
    // - 'text' - Plain text chunk
    // - 'element_start' - Opening tag detected
    // - 'element_update' - Content accumulating
    // - 'element_complete' - Closing tag found
  }
}

export function createStreamParser() {
  return new StreamingHMLParser();
}
```

### Streaming Messages Route

`routes/messages-stream.mjs` - SSE endpoint for streaming responses:

```javascript
router.post('/:sessionId/messages/stream', async (req, res) => {
  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Create streaming parser
  let parser = createStreamParser();

  // Set up event handlers
  parser.on('text', (data) => sendEvent('text', data));
  parser.on('element_start', (data) => sendEvent('element_start', data));
  parser.on('element_complete', async (data) => {
    sendEvent('element_complete', data);
    if (data.executable) {
      let result = await executePipeline([elementToAssertion(data)], context);
      sendEvent('element_result', { id: data.id, result: result[0] });
    }
  });

  // Stream from agent
  for await (let chunk of agent.sendMessageStream(messages)) {
    if (chunk.type === 'text') {
      parser.write(chunk.text);
    }
  }

  parser.end();
  res.end();
});
```

### Abilities System

`lib/abilities/` - Unified extensibility system:

```
abilities/
├── index.mjs           # Exports
├── registry.mjs        # In-memory Map-based registry
├── executor.mjs        # Execution with approval flow
└── loaders/
    ├── builtin.mjs     # Built-in function abilities
    ├── system.mjs      # System processes from .md files
    ├── user.mjs        # User abilities from database
    ├── plugin.mjs      # Plugin-exported abilities
    └── startup.mjs     # __onstart_ ability loader
```

### Interactions System

`lib/interactions/` - Agent↔system↔user communication:

```
interactions/
├── index.mjs           # Exports and initialization
├── bus.mjs             # InteractionBus (pub/sub)
├── function.mjs        # Base InteractionFunction class
├── detector.mjs        # Detects ```interaction blocks in text
└── functions/
    ├── system.mjs      # Routes @system calls
    ├── websearch.mjs   # Web search implementation
    └── help.mjs        # Help function (no permission required)
```

**Interaction Block Format:**

Agents request actions using ` ```interaction ` code blocks (NOT ` ```json `):

````markdown
Some text before...

```interaction
[
  {
    "interaction_id": "unique-id",
    "target_id": "@system",
    "target_property": "websearch",
    "payload": { "query": "example" }
  }
]
```

Some text after...
````

The detector:
- Finds ` ```interaction ` blocks anywhere in the response (interlaced with text)
- Handles JSON payloads containing ` ``` ` sequences (smart closing detection)
- Supports multiple interaction blocks in a single response

**InteractionFunction** base class:

```javascript
import { InteractionFunction, PERMISSION } from '../function.mjs';

class MyFunction extends InteractionFunction {
  static register() {
    return {
      name:       'my_function',
      permission: PERMISSION.ASK,
      schema: {
        input: { type: 'string', required: true },
      },
      examples: [
        { method: 'run', args: { input: 'test' } },
      ],
    };
  }

  async run({ input }) {
    return { result: `Processed: ${input}` };
  }
}

export { MyFunction };
```

**Dynamic agent instructions**:

```javascript
import { buildAgentInstructions } from './functions/system.mjs';

// Returns markdown documentation for all registered functions
let instructions = buildAgentInstructions();
```

**Registry Functions:**

```javascript
// Register an ability
registerAbility({
  id: 'my-ability',
  name: 'my_skill',
  type: 'process',
  source: 'user',
  content: '...',
  permissions: { autoApprove: false, dangerLevel: 'safe' }
});

// Get ability by name
let ability = getAbility('my_skill');

// Get all abilities
let all = getAllAbilities();

// Get startup abilities (sorted by underscore count)
let startup = getStartupAbilities();
// Returns abilities matching _onstart_*, sorted:
// __onstart_ first, then _onstart_a, _onstart_b, etc.
```

### Startup Abilities

Abilities with names matching `_onstart_*` automatically inject on session start:

```javascript
// In messages.mjs and messages-stream.mjs
if (existingMessages.length === 0) {
  let startupAbilities = getStartupAbilities();

  if (startupAbilities.length > 0) {
    let startupContent = startupAbilities
      .filter((a) => a.type === 'process' && a.content)
      .map((a) => a.content)
      .join('\n\n---\n\n');

    // Inject as first user message (hidden from UI)
    db.prepare(`
      INSERT INTO messages (session_id, role, content, hidden)
      VALUES (?, 'user', ?, 1)
    `).run(sessionId, JSON.stringify(`[System Initialization]\n\n${startupContent}`));

    // Add acknowledgment (also hidden)
    db.prepare(`
      INSERT INTO messages (session_id, role, content, hidden)
      VALUES (?, 'assistant', ?, 1)
    `).run(sessionId, JSON.stringify('Understood. Ready to assist.'));
  }
}
```

### Hidden Messages

Messages can be marked as `hidden` in the database to suppress them from the chat UI while still including them in the conversation context sent to the AI. This is used for:

- Startup ability injections (`__onstart_*`)
- System initialization messages
- Any other messages that should influence the AI but not clutter the user's view

The frontend filters out hidden messages:
```javascript
function renderMessages() {
  let visibleMessages = state.messages.filter((m) => !m.hidden);
  // ... render only visible messages
}
```

## Configuration

`config.mjs` - Cascading configuration:

1. `HERO_*` prefixed environment variables (highest)
2. Plain environment variables
3. `config.json` file
4. Hardcoded defaults (lowest)

```javascript
export const config = {
  port:         parseInt(get('port', 8098), 10),
  host:         get('host', '0.0.0.0'),
  jwtSecret:    get('jwt_secret', 'change-this-secret-in-production'),
  jwtExpiresIn: get('jwt_expires_in', '30d'),
  usersFile:    get('usersFile', join(__dirname, 'users.json')),
};
```

## Database Schema

`database.mjs` - SQLite with migrations:

```sql
-- Core tables
CREATE TABLE users (id, username, password_hash, data_key, ...);
CREATE TABLE sessions (id, user_id, agent_id, name, system_prompt, archived, ...);
CREATE TABLE messages (id, session_id, role, content, created_at);
CREATE TABLE agents (id, user_id, name, type, encrypted_api_key, encrypted_config, ...);

-- Abilities tables
CREATE TABLE abilities (
  id, user_id, name, type, source,
  description, encrypted_content,
  auto_approve, danger_level, ...
);

CREATE TABLE ability_approvals (
  id, user_id, session_id, ability_name,
  execution_id, status, request_data, ...
);
```

## Routes

| Route | File | Purpose |
|-------|------|---------|
| `/api/login`, `/api/logout` | `auth.mjs` | Authentication |
| `/api/sessions/*` | `sessions.mjs` | Session CRUD |
| `/api/sessions/:id/messages` | `messages.mjs` | Batch messages |
| `/api/sessions/:id/messages/stream` | `messages-stream.mjs` | SSE streaming |
| `/api/agents/*` | `agents.mjs` | Agent CRUD |
| `/api/abilities/*` | `abilities.mjs` | Abilities CRUD |
| `/api/processes/*` | `processes.mjs` | Processes (legacy) |
| `/api/help` | `help.mjs` | Help data (supports ?filter, ?category, ?detailed) |
| `/ws` | WebSocket | Real-time updates |

## nginx Configuration

`nginx/server.nginx-include`:

```nginx
# API with long timeouts for streaming
location /api/ {
  proxy_pass http://127.0.0.1:8098/api/;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;

  # Important for SSE streaming
  proxy_read_timeout 300;
  proxy_send_timeout 300;
  proxy_buffering off;
}

# WebSocket upgrade
location /ws {
  proxy_pass http://127.0.0.1:8098/ws;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}
```

## Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.52.0",
    "better-sqlite3": "^11.0.0",
    "dotenv": "^17.2.3",
    "express": "^4.18.2",
    "jsonwebtoken": "^9.0.3",
    "uuid": "^9.0.0",
    "ws": "^8.14.0"
  }
}
```

## Environment Variables

`.env` (gitignored):

```bash
JWT_SECRET=your-secret-here
ANTHROPIC_API_KEY=sk-ant-...
```

Or with prefix:

```bash
HERO_JWT_SECRET=your-secret-here
HERO_PORT=8098
```

## CLI Commands

```bash
# Install dependencies
npm install

# Create a user
npm run add-user

# Start server
npm start

# Start with auto-reload (development)
npm run dev
```
