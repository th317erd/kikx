# Kikx

A web-based AI agent runner with chat interface, plugin system, and multi-agent support.

## Features

- **Multi-agent support** - Configure multiple AI agents (Claude, etc.) per user
- **Named sessions** - Each chat session is URL-addressable
- **Plugin system** - Extend functionality with commands, tools, and hooks
- **User encryption** - API keys and sensitive data encrypted per-user
- **REST API** - Full CRUD operations for sessions, agents, commands, tools
- **Dark theme UI** - Clean chat bubble interface, mobile responsive

## Quick Start

```bash
# Install dependencies
npm install

# Create .env file (copy from example and fill in values)
cp .env.example .env

# Add a user
npm run add-user

# Start server
npm start
```

Then open http://localhost:8098 in your browser.

## Configuration

### Environment Variables

Create a `.env` file in the project root:

```bash
# Required - generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
JWT_SECRET=your-64-char-hex-secret
ENCRYPTION_KEY=your-64-char-hex-key

# Optional
BASE_URL=https://example.com/kikx/
PORT=8098
HOST=0.0.0.0
```

### Data Storage

Data is stored in an OS-specific configuration directory:

- **Linux**: `~/.config/kikx/`
- **macOS**: `~/Library/Application Support/kikx/`
- **Windows**: `%APPDATA%/kikx/`

Contents:
- `kikx.db` - SQLite database (users, agents, sessions, messages)
- `plugins/` - Installed plugins

## CLI Commands

```bash
# Add a new user (interactive password prompt)
npm run add-user [username]

# Change a user's password
npm run change-password [username]

# Re-encrypt all user data (for key rotation)
npm run update-user-encryption [username]
```

## API Endpoints

### Authentication
- `POST /api/login` - Authenticate and receive JWT cookie
- `POST /api/logout` - Clear JWT cookie
- `GET /api/me` - Get current user info

### Agents
- `GET /api/agents` - List user's agents
- `POST /api/agents` - Create agent
- `GET /api/agents/:id` - Get agent
- `PUT /api/agents/:id` - Update agent
- `DELETE /api/agents/:id` - Delete agent

### Sessions
- `GET /api/sessions` - List user's sessions
- `POST /api/sessions` - Create session
- `GET /api/sessions/:id` - Get session with messages
- `PUT /api/sessions/:id` - Update session
- `DELETE /api/sessions/:id` - Delete session

### Messages
- `GET /api/sessions/:id/messages` - Get messages
- `POST /api/sessions/:id/messages` - Send message
- `DELETE /api/sessions/:id/messages` - Clear messages

### Commands & Tools
- `GET /api/commands` - List commands (user + plugins)
- `POST /api/commands` - Create user command
- `GET /api/tools` - List tools (user + plugins)
- `POST /api/tools` - Create user tool

## Plugin System

Plugins are stored in `{config_dir}/plugins/{plugin-name}/`.

### Plugin Structure

```
my-plugin/
├── package.json
└── index.mjs
```

### package.json

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "main": "index.mjs",
  "hero": {
    "agents": ["*"]  // or ["claude", "openai"]
  }
}
```

### index.mjs

```javascript
// Lifecycle
export async function init(context) { }
export async function destroy() { }

// Commands (invoked with /command-name)
export const commands = [
  {
    name: 'my-command',
    description: 'Does something cool',
    execute: async (args, context, signal) => {
      return 'Command result';
    },
  },
];

// Tools (available to AI agents)
export const tools = [
  {
    name: 'my_tool',
    description: 'A tool for the AI to use',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The query' },
      },
      required: ['query'],
    },
    execute: async (input, context, signal) => {
      return `Result for: ${input.query}`;
    },
  },
];

// Hooks (intercept and modify data flow)
export const hooks = {
  beforeUserMessage: async (message, context) => message,
  afterAgentResponse: async (response, context) => response,
  beforeCommand: async (data, context) => data,
  afterCommand: async (data, context) => data,
  beforeTool: async (data, context) => data,
  afterTool: async (data, context) => data,
};
```

## nginx Configuration

The `nginx/` directory contains a complete nginx configuration with self-signed SSL certificates for development.

### Directory Structure

```
nginx/
├── wyatt-desktop.mythix.info     # Server block config (symlink to sites-enabled)
├── server.nginx-include          # Location blocks for proxying
└── ssl/
    ├── ca/
    │   └── aeor_development_com.ca.pem    # CA certificate
    ├── public/
    │   └── wyatt_desktop_mythix_info.pem  # Server certificate
    └── private/
        └── wyatt_desktop_mythix_info.key  # Private key
```

### Setup

1. Deploy the project to `/var/www/kikx/`

2. Symlink the server config:
```bash
sudo ln -s /var/www/kikx/nginx/wyatt-desktop.mythix.info /etc/nginx/sites-enabled/
```

3. Test and reload nginx:
```bash
sudo nginx -t && sudo systemctl reload nginx
```

### Development Certificates

The included SSL certificates are self-signed for development use. To trust them in your browser, import the CA certificate (`nginx/ssl/ca/aeor_development_com.ca.pem`) into your system's certificate store.

## Development

```bash
# Run tests
npm test

# Run specific test file
npx jasmine spec/lib/encryption-spec.mjs
```

## Security Notes

- Passwords are hashed with scrypt (never stored in plaintext)
- User secrets (containing encryption keys) are encrypted with user's password
- API keys and agent configs are encrypted with user's data key
- JWT tokens contain the decrypted secret for session-based decryption
- All sensitive operations use timing-safe comparisons

## License

GPL-3.0
