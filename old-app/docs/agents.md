# Agent System

The agent system provides a pluggable architecture for different AI backends with encrypted configuration storage and rich context passing.

## File Structure

```
server/lib/
├── agents/
│   ├── agent.mjs           # Base Agent class
│   ├── claude-agent.mjs    # Claude implementation
│   ├── openai-agent.mjs    # OpenAI implementation
│   └── index.mjs           # Registry and factory
```

## Database Schema

Agents are stored in the `agents` table:

```sql
CREATE TABLE agents (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL,
  name              TEXT NOT NULL,
  type              TEXT NOT NULL,           -- 'claude', 'openai'
  api_url           TEXT,                    -- Custom endpoint (optional)
  encrypted_api_key TEXT,                    -- AES encrypted
  encrypted_config  TEXT,                    -- AES encrypted JSON
  default_processes TEXT DEFAULT '[]',       -- JSON array of process names
  created_at        TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at        TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, name)
);
```

## Agent Configuration

Each agent has an `encrypted_config` blob that stores a JSON object merged into every API call:

```json
{
  "model": "claude-sonnet-4-20250514",
  "maxTokens": 4096,
  "temperature": 0.7
}
```

### Common Config Fields

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Model identifier (e.g., `claude-sonnet-4-20250514`, `gpt-4o`) |
| `maxTokens` | number | Maximum response tokens |
| `temperature` | number | Sampling temperature (0-1) |

### Editing Config via UI

The Agents modal includes a "Config" button that opens a JSON editor:

1. Click "Agents" button in header
2. Find agent in list
3. Click "Config" button
4. Edit JSON in textarea
5. Click "Save" (validates JSON before saving)

### Config via API

```bash
# Get current config
GET /api/agents/:id/config

# Update config
PUT /api/agents/:id/config
Content-Type: application/json
{ "config": { "model": "claude-opus-4-20250514", "maxTokens": 8192 } }
```

## Default Processes

Each agent can specify default processes that are automatically included in the system prompt:

```json
{
  "defaultProcesses": ["act", "my_custom_process"]
}
```

When a session uses this agent:
1. System processes (e.g., `act`) are loaded from `server/lib/processes/`
2. User processes are loaded from the database
3. All process content is concatenated into the system prompt

## Rich Context Object

When handling operations, all handlers receive a rich context with agent info:

```javascript
const context = {
  userId: 1,
  sessionId: 'abc123',
  dataKey: 'user-encryption-key',

  agent: {
    id: 5,
    name: 'My Claude',
    type: 'claude',
    apiUrl: null,               // or custom URL
    config: {                   // Decrypted!
      model: 'claude-sonnet-4-20250514',
      maxTokens: 4096,
    },
    defaultProcesses: ['act'],
  },

  session: {
    id: 'abc123',
    name: 'dev',
    systemPrompt: '...',
  },

  signal: AbortSignal,
  pipeline: { index: 0, handlers: ['handler_a', 'handler_b'] },
};
```

Handlers can use `context.agent.config` to access model settings, custom parameters, etc.

## Base Agent Class

`server/lib/agents/agent.mjs`:

```javascript
export class Agent {
  constructor(options = {}) {
    this.messages = [];
    this.tools    = options.tools || [];
    this.metadata = options.metadata || {};
    this.config   = options.config || {};  // Merged agent config
  }

  async sendMessage(content, context) {
    throw new Error('sendMessage must be implemented by subclass');
  }

  getMessages() {
    return this.messages;
  }

  clear() {
    this.messages = [];
  }

  async executeTool(name, input, context) {
    throw new Error(`Tool "${name}" not implemented`);
  }

  getToolDefinitions() {
    return this.tools;
  }
}
```

## Claude Agent

`server/lib/agents/claude-agent.mjs`:

```javascript
export class ClaudeAgent extends Agent {
  constructor(options = {}) {
    super(options);

    this.client = new Anthropic({
      apiKey:  options.apiKey,
      baseURL: options.apiUrl || undefined,
    });

    // Config from agent.encrypted_config
    this.model     = this.config.model || 'claude-sonnet-4-20250514';
    this.maxTokens = this.config.maxTokens || 4096;
    this.system    = options.system || '';
  }

  async sendMessage(content, context) {
    this.messages.push({ role: 'user', content });

    while (true) {
      let response = await this.client.messages.create({
        model:      this.model,
        max_tokens: this.maxTokens,
        system:     this.system,
        tools:      this.getToolDefinitions(),
        messages:   this.messages,
      });

      this.messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason !== 'tool_use')
        break;

      // Execute tools, add results, continue loop...
    }

    return { content: response.content, stopReason: response.stop_reason };
  }
}
```

## OpenAI Agent

`server/lib/agents/openai-agent.mjs`:

```javascript
export class OpenAIAgent extends Agent {
  constructor(options = {}) {
    super(options);

    this.client = new OpenAI({
      apiKey:  options.apiKey,
      baseURL: options.apiUrl || undefined,
    });

    this.model     = this.config.model || 'gpt-4o';
    this.maxTokens = this.config.maxTokens || 4096;
  }

  async sendMessage(content, context) {
    // Similar pattern, adapted for OpenAI API format
  }
}
```

## Agent Registry

`server/lib/agents/index.mjs`:

```javascript
import { ClaudeAgent } from './claude-agent.mjs';
import { OpenAIAgent } from './openai-agent.mjs';

const agents = {
  claude: ClaudeAgent,
  openai: OpenAIAgent,
};

export function createAgent(type, options = {}) {
  let AgentClass = agents[type];
  if (!AgentClass) throw new Error(`Unknown agent type: ${type}`);
  return new AgentClass(options);
}

export function getAgentTypes() {
  return Object.keys(agents);
}
```

## Creating an Agent (UI Flow)

1. Click "Agents" in header
2. Click "Add Agent"
3. Fill in form:
   - **Name**: Display name (e.g., "My Claude")
   - **Base Type**: claude or openai
   - **Model**: Select from dropdown (filtered by type)
   - **API URL**: Optional custom endpoint
   - **API Key**: Required, encrypted at rest
   - **Default Processes**: Checkboxes for system processes
4. Click "Add Agent"

## Adding a New Agent Type

1. Create `server/lib/agents/my-agent.mjs`:

```javascript
import { Agent } from './agent.mjs';

export class MyAgent extends Agent {
  constructor(options = {}) {
    super(options);
    // Initialize client with options.apiKey, options.apiUrl
    // Read config from this.config
  }

  async sendMessage(content, context) {
    // Use context.agent.config for settings
    // Use context.signal for abort handling
    // Return { content, stopReason }
  }
}
```

2. Register in `server/lib/agents/index.mjs`:

```javascript
import { MyAgent } from './my-agent.mjs';

const agents = {
  claude: ClaudeAgent,
  openai: OpenAIAgent,
  my:     MyAgent,
};
```

3. Add to valid types in `server/routes/agents.mjs`:

```javascript
let validTypes = ['claude', 'openai', 'my'];
```

4. Add model options in `public/index.html`:

```html
<optgroup label="My Provider" id="my-models">
  <option value="my-model-v1">My Model v1</option>
</optgroup>
```

## Security Considerations

- **API keys never leave the server** - Frontend only sees `hasApiKey: true/false`
- **Config decrypted only when needed** - Stays encrypted in database
- **Per-user encryption** - Each user has their own data key
- **Type validation** - Only registered agent types can be created
