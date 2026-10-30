# Plugins, Providers, and Persistence

> **Current v3 architecture.** Last verified against source: 2026-10-30.

Kikx treats extensibility as a runtime contract, not a build-time add-on. The
plugin system is implemented and used by core. The number of bundled plugins is
not the same as the size of the extension surface: only OCR is bundled in this
repository today, while deployments can load additional agent providers and
plugins from configured paths.

## Plugin surfaces

`PluginRegistry` supports:

- tools, commands, selectors, and typed tags;
- agent providers and their model/config descriptors;
- database drivers and driver-qualified migrations;
- frame indexes, including driver-qualified indexes;
- plugin-owned application services and ordered prompt sections;
- scoped HTTP mounts, plugin databases, capability checks, and event subscriptions;
- frame, tool, agent-config-form, and composition-surface client descriptors;
- a replaceable `main-app` shell; and
- stack-based class registration and override.

The loader accepts a plugin module, plugin directory, or directory containing
plugins. Each module exports `setup`, receives explicit registration functions,
and may return teardown behavior. Loaded plugin paths also define the safe roots
from which the server serves plugin client assets.

Class overrides are stacks: the most recently registered class wins, and
unloading a plugin reveals the class beneath it. Core deliberately resolves
FrameRouter, FrameRuntime, CompactionService, and database drivers through the
registry. Crypto and authentication are intentionally not plugin-overridable.

Plugins are trusted code, not a security boundary. The server application class
and the browser `kikx-app` shell are deliberately replaceable. Plugin HTTP mounts
are authenticated by default and require an explicit public declaration to opt
out. Plugin admin inventory, reload, install, and unload routes require an
authenticated Kikx identity.

Every registration is attributed to its plugin and entered in an ownership
ledger. Unload releases registry entries, services, subscriptions, scoped
databases, and class overrides. Durable plugin data is retained unless the
plugin explicitly purges it.

Tools extend `PluginInterface`; agent providers extend `AgentInterface`.
Permissions are checked before a plugin tool executes. A tool may register a
specialized frame type and browser component, but neither is required for the
tool's server-side behavior.

## Agent providers

Agent records name a provider `pluginID` and contain public config, secrets,
enabled state, tags, and character fields. `AgentManager` validates config
against the provider's descriptor and aggregates provider model catalogs.
Provider instances inherit the shared agent loop, prompt construction, context
budgeting, tool dispatch, usage capture, retry-safety contract, and OCR fallback.

Provider-specific request/stream code belongs in the provider. Coordinator
routing, durable frames, tools, compaction, and session behavior remain core
contracts.

## Database driver contract

The database is a document store addressed by paths. `DatabaseConnectionBase`
defines read, write, merge-patch, delete, list, streaming entries, bulk get, and
batch operations. Optional search, query, ranges, events, and auth surfaces are
advertised by capability flags; callers must not assume every driver supports
every optional capability.

Built-in drivers currently include PostgreSQL, SQLite, and legacy AeorDB.
PostgreSQL is the primary driver in current development. Historical store class,
directory, property, and method names still contain `AeorDB`; they are
compatibility debt, not a requirement that AeorDB be active. Current prose
therefore says **the database** unless a driver-specific behavior matters.

The PostgreSQL driver stores path/body documents, provides transactional
batches, and implements search, structured query, and byte ranges. SQLite is a
local alternative. AeorDB remains available so migration back can be a driver
selection when it becomes stable enough.

## Implemented versus incomplete

Implemented:

- generic document-driver contract and runtime selection;
- built-in driver registration;
- plugin registration for new drivers;
- driver-aware capability failures;
- Kikx-native authentication data stored through the generic contract.

Incomplete cleanup:

- the source fallback still selects the legacy driver when configuration omits
  a driver;
- several generic stores still expose legacy `aeordb` property/class names;
- some user-facing tool strings and old scripts still say AeorDB.

Documentation must describe current architecture, while historical plans and
reports should retain driver-specific facts with clear historical labels.

## Source of truth

- [`src/core/plugins/plugin-registry.mjs`](../../src/core/plugins/plugin-registry.mjs)
- [`src/core/plugins/plugin-loader.mjs`](../../src/core/plugins/plugin-loader.mjs)
- [`src/core/plugins/class-registry.mjs`](../../src/core/plugins/class-registry.mjs)
- [`src/core/plugins/core-classes.mjs`](../../src/core/plugins/core-classes.mjs)
- [`src/core/database/database-connection-base.mjs`](../../src/core/database/database-connection-base.mjs)
- [`src/core/database/postgresql-connection.mjs`](../../src/core/database/postgresql-connection.mjs)
- [`src/server/create-server.mjs`](../../src/server/create-server.mjs)

## Related

- [Architecture overview](./README.md)
- [Agentic script](./agentic-script.md)
- [Frames, runtime, and routing](./frames-runtime-routing.md)
