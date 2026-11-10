---
title: Plugin system reference
status: current
doc_type: reference
audience: [developers, maintainers, operators]
applies_to: development-v3
last_verified: 2026-10-30
canonical: true
keywords: [plugins, extensions, tools, providers, services, routes, migrations, client-surfaces]
---

# Plugin system reference

> **Current documentation — Kikx v3 (unreleased).** Last verified 2026-10-30
> against the loader, registries, ownership ledger, migration runner, plugin
> router, client descriptor API, and bundled OCR plugin.

Plugins are the supported extension mechanism for Kikx product behavior. They can
supply agents, tools, commands, selectors, tags, database drivers, server
services, prompt sections, frame indexes, schema migrations, HTTP mounts, and
browser surfaces. Selected core classes and the browser application shell can
also be replaced.

Plugins are trusted code. They run in the server process, or in the browser as
first-party modules, and are not a security boundary. The server application
class and the `kikx-app` browser shell are deliberately replaceable.

## Discovery and loading

Server bootstrap always starts with the repository's `plugins/` directory, then
adds configured `KIKX_PLUGIN_PATHS`. Configured sites extend bundled plugins; they
do not replace them.

A plugin site may be:

- one module file;
- a directory with `index.mjs`;
- a package directory whose `package.json` names `main`;
- a container directory whose immediate child directories are plugins.

String path lists use the operating system path delimiter. Paths are resolved and
de-duplicated in order. Modules are dynamically imported with a cache-busting
query. A module without `setup` is ignored. A load failure is warned, retained in
the failure inventory, and skipped rather than aborting the server.

A plugin may also provide a `kikx-plugin.json` manifest. A package.json is read
as a fallback, but is reported as a fallback rather than a declared plugin.

## Setup contract

A plugin exports `setup(provide)` and may optionally export `pluginName`. Calling
`provide(callback)` invokes the callback with a setup context containing:

- `registry`, `commandRegistry`, and the application `context`;
- `pluginPath`, `pluginName`, `PluginInterface`, and `AgentInterface`;
- `registerClass`;
- `registerTool`, `registerCommand`, `registerSelector`, and
  `registerTagDefinition`;
- `registerAgentProvider` and `registerAgentType`;
- `registerDatabaseDriver`;
- `registerFrameIndex` and `registerMigrations`;
- `registerService` and `registerPromptSection`;
- `mountHttp`, `db`, and `authorize`;
- `readConfig`, `appendToSession`, `appendToSessionQuietly`, and `subscribe`;
- `registerComponent`, `registerFrameComponent`, `registerToolComponent`,
  `registerAgentConfigForm`, `registerClientSurface`, and `registerMainApp`.

`setup` may return a teardown function, or an object with `onInit`, `onShutdown`,
and `teardown`. `onInit` runs after all `provide` callbacks for that plugin have
registered their definitions. Shutdown hooks run in reverse load order.

## Registry rules

- Tools must extend `PluginInterface`.
- Agent providers must extend `AgentInterface`.
- Database drivers must extend `DatabaseConnectionBase`.
- Component descriptors require a valid hyphenated custom-element tag and a
  module URL.
- Registrations with an existing key override the prior mapping and emit a
  warning. Unloading restores the prior mapping when one existed.
- Provider and driver descriptors may resolve configuration fields
  asynchronously.

The universal `ClassRegistry` keeps a stack per class key. The most recently
registered class wins; removing a plugin reveals the layer below. Authentication
and cryptography are not plugin-overridable.

Every registration made by a plugin is recorded in the plugin ownership ledger.
The loader supplies the ambient plugin owner, so direct registry calls made
inside `provide` are attributed too. Explicit attribution always wins.

## Registration surfaces

### Services

`registerService(name, { factory, dependsOn, shutdown }, options)` adds a service
to the application context. Factories run after core services exist, in
dependency order. A service may replace an existing context service; unloading
restores the previous service, or removes the name when it had no predecessor.
Dependency cycles and missing services fail startup rather than yielding a
partially initialized context.

### Prompt sections

`registerPromptSection(name, { text, order })` contributes an ordered section to
the agent start brief. Sections are sorted by `order` and name, and are removed
on unload.

### Frame indexes

`registerFrameIndex(name, definition)` adds a queryable frame index. A definition
may declare `drivers`; the frame store then exposes it only while that database
driver is active. An index without `drivers` is available to every driver.
Unloading removes the index registration; durable index data is not deleted
unless the plugin explicitly purges it.

### HTTP mounts

`mountHttp(handler, { auth })` mounts a plugin-owned HTTP subtree at
`/api/v1/plugins/<pluginID>/`. Mounts are authenticated by default through the
Kikx account store. A plugin must opt in explicitly with `{ auth: 'public' }` for
unauthenticated access; that choice should be treated as a reviewed security
decision. The authenticated identity is passed to the handler.

Admin inventory, reload, install, and unload routes require an authenticated
Kikx identity. They are not public plugin-management endpoints.

### Migrations and scoped data

`registerMigrations({ directory, drivers })` registers a plugin migration
directory. Relative directories resolve beneath the plugin root. Migrations run
only when the active database driver is explicitly supported; an unsupported
driver is refused instead of silently applying SQL. Plugin SQL is schema-scoped
to the plugin's prefix.

`db()` returns a scoped database handle, never the shared pool, and refuses DDL.
`authorize()` is a deny-by-default capability check for plugin transports.
`subscribe()` receives scoped runtime events for the sessions named in the
subscription; naming none receives nothing. These resources are closed and
unsubscribed on unload.

### Browser components and surfaces

Plugins can register these browser component kinds:

- `frame`, keyed by frame type;
- `tool`, keyed by tool name;
- `agent-config-form`, keyed by provider ID.

They can also register composition surfaces:

- `main-app`, a replacement `kikx-app` shell;
- `view`, a named main view;
- `sidebar-item`;
- `toolbar-action`;
- `settings-panel`.

The server exposes descriptors through `GET /api/v1/client-components`. The
browser imports each module and expects it to define the declared custom
element. A plugin `main-app` descriptor is selected before the built-in
`kikx-app` module is defined, so it can replace the entire shell. If no plugin
main app loads, the built-in shell remains the fallback.

Loaded plugin roots are recorded by plugin name. Files beneath
`<plugin-root>/client/` are served read-only at:

```text
/api/v1/plugin-assets/<pluginID>/<relative-path>
```

The route rejects traversal outside the plugin's client directory. It is an asset
route, not a trust boundary.

## Permissions

`PluginInterface.execute()` performs a permission check before `_execute()`.
Checks have a ten-second deadline. A feature with `riskLevel = 'none'` bypasses
the boundary. Other features are deny/request by default if no permission service
is registered.

Documentation must distinguish this extensibility mechanism from the metadata on
a concrete tool. A permission framework existing does not prove every built-in
operation currently requests permission.

## Lifecycle and unload

`unloadPlugin` runs the plugin teardown, drops its event subscriptions, releases
everything in its ownership ledger, closes scoped databases, and removes its
class-stack overrides. Tools, providers, drivers, components, selectors, tags,
frame indexes, mounts, migrations, services, prompt sections, and client
surfaces are therefore removed from the active registry.

Durable plugin data is retained by default. Uninstall removes definitions,
routes, indexes, and migration registrations; it does not silently delete stored
rows. A separate explicit purge is required to destroy plugin-owned data.

A plugin that registers a service or mount must release any external resource it
created in `teardown` or `onShutdown`; the ledger covers registry entries, not
sockets, timers, or child processes.

## Admin endpoints

Every `/api/v1/plugins…` endpoint requires a resolved Kikx identity
(`requireOperator`: 503 when the deployment has no account store, 401
otherwise); endpoints that load or delete code additionally require the
explicit `KIKX_PLUGIN_INSTALL_ENABLED` config gate.

| Endpoint | What it does |
| --- | --- |
| `GET /api/v1/plugins` | Inventory: location tokens, managed ground, mounted/mount, provenance `source`, `signed`, the disabled list, load failures, `signatureMode`, restart/inert overrides. |
| `POST /api/v1/plugins/install` | `{path}` (absolute directory) **or** `{npm}` (registry spec) — never both. npm resolves against configured registries, verifies sha512 `dist.integrity`, extracts with tarbomb guards into staging, swaps atomically, then rides the shared load/migrations/rollback pipeline. |
| `POST /api/v1/plugins/search?q=` | Registry search scoped to the `kikx-plugin` keyword (inventory gate); hits are re-filtered to that keyword before the UI sees them. |
| `POST /api/v1/plugins/updates` | Bounded batch (≤25) version check; a per-package lookup failure yields no chip, never an error. |
| `POST /api/v1/plugins/reload` | Re-scan configured paths plus the durable runtime list. |
| `POST /api/v1/plugins/unload` | Teardown and deregistration; files stay, so a reload finds them again. |
| `POST /api/v1/plugins/uninstall` | Unload FIRST, then delete files **only** under managed ground (configured ∪ runtime ∪ npm roots); built-ins answer `Internal Plugin — cannot be uninstalled`. Durable plugin data is retained — purge is a separate future action. |
| `POST /api/v1/plugins/set-enabled` | `{name, enabled}`: disable persists a durable flag and unloads (identity gate only — stopping code needs no config permission); enable reloads from the stored location under the install gate, restoring the flag if the load fails. The loader skips disabled basenames at boot, reload, and install. |

Every **successful** action publishes `plugin.changed {pluginID, action,
actor}` through the runtime event gateway, and connected clients refetch
component descriptors plus the inventory in place; failures publish nothing.

## Signature policy

Verification is **required by default and fail-closed**: `loadPlugins` admits a
directory only after checking its `.kikx-sig` envelope, BEFORE the import —
refused code never executes.

- Sign: `node scripts/sign-plugin.mjs [--key <pem>] <pluginDir...>` — `--key`
  defaults to `$KIKX_PLUGIN_SIGNING_PRIVATE_KEY_FILE`; `--all-bundled` signs
  the repository's own plugins.
- Trust anchors: `KIKX_PLUGIN_SIGNING_PUBLIC_KEYS`, comma-separated raw
  Ed25519 keys — publisher key plus operator keys, overlapping for rotation
  (the envelope `keyID` field is reserved for exactly that).
- Mode: `required` for every real deployment; `unsafe` is a development-only
  bypass announced by a startup warning, the inventory's `signatureMode`, and
  a persistent Settings → Plugins banner.
- Inventory `signed`: `true` under `required` (loaded implies verified),
  honestly `null` under `unsafe` (load proves nothing there).

## Configuration keys

| Key | Property path | Meaning |
| --- | --- | --- |
| `KIKX_PLUGIN_PATHS` | `/kikx/plugin/paths` | Extra plugin sites; extend, never replace, bundled roots. |
| `KIKX_PLUGIN_SIGNATURE_MODE` | `/kikx/plugin/signature/mode` | `required` (default) or `unsafe` (dev only). |
| `KIKX_PLUGIN_SIGNING_PUBLIC_KEYS` | `/kikx/plugin/signature/public/keys` | Comma-separated Ed25519 trust anchors. |
| `KIKX_PLUGIN_INSTALL_ENABLED` | `/kikx/plugin/install/enabled` | Explicit gate for code-loading/deleting endpoints. |
| `KIKX_PLUGIN_REGISTRY_URLS` | `/kikx/plugin/registry/urls` | Registry allowlist (comma-separated bases; default public npm) — configuration, never hardcoded hosts. |
| `KIKX_PLUGIN_NPM_DIR` | `/kikx/plugin/npm/dir` | Tarball landing root (default `<service root>/.kikx/plugins/npm`). |

Runtime-installed directories live in a durable list under the service root
(`.kikx/plugin-paths.json`, unioned at boot/reload) and the disabled set in
`.kikx/plugin-disabled.json` — the config store is read-only, and the tag
store is constructed after the boot load, so neither can hold these.

## Sources of truth

- `src/core/plugins/plugin-loader.mjs`
- `src/core/plugins/plugin-registry.mjs`
- `src/core/plugins/class-registry.mjs`
- `src/core/plugins/plugin-interface.mjs`
- `src/core/plugins/plugin-router.mjs`
- `src/core/plugins/plugin-database.mjs`
- `src/core/plugins/plugin-events.mjs`
- `src/core/plugins/plugin-migrations.mjs`
- `src/core/plugins/core-classes.mjs`
- `src/core/plugins/plugin-paths.mjs`
- `src/core/plugins/plugin-signature.mjs`
- `src/core/config/runtime-plugin-paths.mjs`
- `src/core/config/runtime-disabled-plugins.mjs`
- `src/server/routes/plugin-asset-routes.mjs`
- `src/server/routes/plugin-install-routes.mjs`
- `src/server/routes/plugin-lifecycle-routes.mjs`
- `src/server/plugin-changed.mjs`
- `spec/plugins/plugin-unload-spec.mjs`
- `spec/core/plugins/plugin-authority-spec.mjs`
- `plugins/ocr/index.mjs`

## Related

- [Plugin authoring guide](../guides/plugin-authoring.md)
- [Tool system reference](tools.md)
- [Database driver reference](database-drivers.md)
- [Frontend guide](../guides/frontend.md)
