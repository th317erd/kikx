# Kikx — Plugin System

Kikx uses a plugin architecture to provide tools, commands, event handlers, and instructions to the agent ecosystem. Plugins are the primary extension mechanism.

---

## Plugin Architecture

### Plugin Loading

Plugins are loaded by the `PluginLoader` (`src/core/plugin-loader/index.mjs`) during `KikxCore.start()`. There are two provider types:

- **InMemoryPluginProvider** — Built-in (internal) plugins hardcoded in the core
- **FilesystemPluginProvider** — External plugins loaded from disk paths specified via `KIKX_PLUGIN_PATHS` environment variable

### Plugin Module Interface

Every plugin exports a `setup` function:

```javascript
'use strict';

export function setup(pluginContext) {
  // pluginContext provides:
  //   pluginName     — String: plugin name
  //   context        — CascadingContext: dependency injection
  //   PluginInterface — Base class for tools
  //   AgentInterface  — Base class for agent plugins
  //
  // Registration methods:
  //   registerTool(name, ToolClass)
  //   registerCommand(name, handler)
  //   registerSelector(selector, PluginClass)
  //   registerInstructions(content, options)
  //   registerCapability(name, descriptor)

  // Return a teardown function (optional)
  return async function teardown() {
    // Cleanup resources
  };
}
```

### Plugin Registry

The `PluginRegistry` (`src/core/plugin-loader/registry.mjs`) is the central registration point. It stores:

| Registry | Format | Purpose |
|----------|--------|---------|
| Tools | `pluginID:toolName` -> `ToolClass` | Operations agents can invoke |
| Commands | `commandName` -> handler function | System slash commands |
| Selectors | frame matcher -> `PluginClass` | Event handlers triggered by frame patterns |
| Instructions | content string + options | Text injected into agent primers |
| Capabilities | name -> descriptor | Declared agent capabilities |
| Hooks | event name -> handler list | Lifecycle callbacks |

---

## Tool Development

### PluginInterface (Base Tool Class)

Tools extend `PluginInterface` (`src/core/routing/base-plugin-class.mjs`):

```javascript
class MyTool extends PluginInterface {
  // Required: actual operation
  async _execute(args) {
    // args is the parsed tool arguments from the agent
    return { result: 'done' };
  }

  // Optional: custom permission logic
  static getPermissionsClass() {
    return MyToolPermissions; // extends base Permissions class
  }

  // Optional: help metadata
  static getHelp() {
    return {
      name:        'myPlugin:myTool',
      description: 'Does something useful',
      parameters:  { /* JSON schema */ },
      riskLevel:   'low',
    };
  }
}
```

### Risk Levels

Every tool declares a static `riskLevel`:

| Level | Behavior | Examples |
|-------|----------|---------|
| `'none'` | Auto-allowed, no permission check | `help:search`, read-only lookups |
| `'low'` | Default approval, overridable by rules | Safe data access, memory reads |
| `'high'` | Needs approval unless explicit allow rule exists | Web search, external API calls |
| `'critical'` | Always needs human approval, bypasses all allow rules | Shell execution, API key access |

### Custom Permission Matching

Tools can provide a custom `Permissions` subclass for advanced rule matching. For example, `ShellPermissions` evaluates rules on a per-command basis:

```javascript
class ShellPermissions extends Permissions {
  matchesRule(rule, params) {
    // rule.metadata.commands contains allowed commands
    // params.command is the command being executed
    // Return true if this rule applies to this specific command
  }
}
```

---

## Internal Plugins

Located in `src/core/internal-plugins/`, these ship with Kikx:

### Shell (`shell`)
- **Tool**: `shell:execute` — Execute shell commands
- **Risk level**: `critical` (always needs approval)
- **Custom permissions**: `ShellPermissions` for per-command matching
- Supports allow-once, deny-once, allow-forever, deny-forever per command

### Memory (`memory`)
- **Tools**: `memory:setValue`, `memory:getValue`, `memory:searchValues`, `memory:deleteValue`
- Agent configuration and memory storage via ValueStore
- Supports Ed25519 signing for tamper-proof values
- Returns `signed`/`verified` flags for signed entries

### Permissions (`permissions`)
- **Tools**: Permission rule management (create, list, delete rules)
- Allows agents to manage their own permission rules programmatically

### Help (`help`)
- **Tool**: `help:search` — Search available tools and commands
- **Risk level**: `none` (auto-allowed)
- Returns tool descriptions, parameters, and usage information

### Hooks (`hooks`)
- Lifecycle event handlers: `before_interaction`, `after_message`, `before_tool`, `after_tool`
- Allows plugins to intercept and modify behavior at key points

### Reload (`reload`)
- **Command**: `/reload` — Reloads agent configuration and primer
- Useful for live configuration changes without restarting sessions

### Scheduling (`scheduling`)
- Multi-agent task coordination
- Manages agent turn-taking in multi-participant sessions

### Cross-Session (`cross-session`)
- **Tool**: `crossSession:createSession` — Create child sessions
- Always needs approval (sub-session creation is sensitive)
- Enables agent deliberation via child sessions

### Web Search (`websearch`)
- **Tools**: `websearch:search`, `websearch:fetch`
- Web search and HTML-to-Markdown conversion
- Uses `marked` and `turndown` for content processing

### System Command (`system-command`)
- System-level meta-commands
- Handles internal housekeeping operations

### Invite (`invite`)
- Session invitation management
- Allows agents to invite other agents into sessions

---

## Agent Plugins

Agent plugins implement the AI provider interface. They extend `AgentInterface` and implement the `run()` async generator:

```javascript
class ClaudeAgent extends AgentInterface {
  async *run(messages) {
    // messages: array of { role, content } objects
    // Yield blocks: { type: 'text', text } or { type: 'tool_use', ... }

    // Call the AI provider API
    // Yield streaming results
    // Handle tool results via yield/next pattern
  }
}
```

Agent plugins are registered via `pluginID` on the Agent model. The external plugin at `~/Projects/kikx-workspace/kikx-plugin-claude` provides the Claude agent implementation.

---

## Frame Router

The `FrameRouter` (`src/core/routing/frame-router.mjs`) dispatches frame changes to registered plugins:

1. FrameManager emits a `commit` event when frames change
2. FrameRouter matches changed frames against registered selectors
3. Matching plugins receive routing context (frame, change type, commit metadata)
4. Plugins execute as a middleware chain (`process(next, done)`)
5. Re-entrant safety: if a handler creates new frames, those commits are queued and processed iteratively

### Selector Compilation

Selectors are compiled to predicate functions by the `SelectorCompiler` (`src/core/routing/selector-compiler.mjs`):

```javascript
// Simple type matching
registerSelector('frame.type === "user-message"', MyPlugin);

// Multiple conditions
registerSelector('frame.authorType === "agent" && frame.type === "message"', MyPlugin);
```

---

## External Plugin Development

External plugins live in separate directories and are loaded via `KIKX_PLUGIN_PATHS`:

```
my-plugin/
  package.json    — { "name": "my-plugin", "main": "index.mjs" }
  index.mjs       — exports setup(pluginContext)
```

**Loading**: Set `KIKX_PLUGIN_PATHS` to a colon-separated list of directories containing plugin folders:

```bash
KIKX_PLUGIN_PATHS=~/Projects/my-plugins:~/Projects/more-plugins node src/server/index.mjs
```

The FilesystemPluginProvider scans each directory for subdirectories with a `package.json` and loads them.

---

## CascadingContext

Plugins receive a `CascadingContext` — a layered property store providing dependency injection:

```javascript
// Access models
let models = context.getProperty('models');
let { User, Agent, Session } = models;

// Access services
let core             = context.getProperty('core');
let permissionEngine = context.getProperty('permissionEngine');
let connection       = context.getProperty('connection');
```

Context properties are resolved from local to parent scope, enabling layered overrides.
