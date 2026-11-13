---
title: Plugin authoring guide
status: current
doc_type: guide
audience: [developers, maintainers]
applies_to: development-v3
last_verified: 2026-10-30
canonical: true
keywords: [plugins, authoring, tools, services, routes, migrations, client-components]
---

# Plugin authoring guide

> **Current documentation — Kikx v3 (unreleased).** Last verified 2026-10-30
> against the plugin loader, registries, client descriptors, lifecycle hooks,
> migration driver checks, and bundled OCR plugin.

Use a plugin when behavior should be discoverable and replaceable without
hard-coding it into server composition. Plugins run in the Kikx server process
and carry the same trust as application code. They can replace the main browser
shell, so review a plugin’s client module with the same care as its server code.

## Minimal layout

```text
my-plugin/
  kikx-plugin.json
  index.mjs
  migrations/
    001-create.sql
  client/
    my-tool-view.mjs
```

The `kikx-plugin.json` file is optional but preferred:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Example Kikx plugin"
}
```

`index.mjs` is the default entry point. A `package.json` with `main` also works,
but is treated as a package fallback rather than a declared plugin manifest.

## Setup function

```js
'use strict';

export const pluginName = 'my-plugin';

export function setup(provide) {
  return provide(({ PluginInterface, registerTool }) => {
    class EchoTool extends PluginInterface {
      static pluginID = 'my-plugin';
      static featureName = 'echo';
      static displayName = 'Echo';
      static description = 'Return supplied text.';
      static riskLevel = 'none';
      static inputSchema = {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: [ 'text' ],
        additionalProperties: false,
      };

      async _execute({ text }) {
        return { text };
      }
    }

    registerTool('echo', EchoTool);
  });
}
```

Choose `riskLevel: 'none'` only for an operation that truly needs no permission
boundary. Otherwise implement clear permission details and test allowed, denied,
missing-boundary, and timeout paths.

## Setup context

The callback supplied to `provide` receives the narrow registration API:

- tools, commands, selectors, and typed tags;
- agent providers and provider forms;
- database drivers;
- frame indexes and migrations;
- plugin-owned services and prompt sections;
- HTTP mounts, scoped database access, capability checks, config reads, event
  subscriptions, and quiet/visible session appends;
- frame, tool, provider-form, and composition-surface browser descriptors.

Use the narrowest registry for the behavior. A class override affects every
construction site that resolves that class and therefore has a larger blast
radius than registering a provider or tool.

## Lifecycle hooks

`setup` may return a teardown function:

```js
export function setup(provide) {
  let timer = setInterval(() => {}, 60_000);
  provide(() => {});
  return () => clearInterval(timer);
}
```

It may instead return an object with explicit lifecycle hooks:

```js
export function setup(provide) {
  return {
    async onInit() {
      // All registrations from this plugin exist now.
    },
    async onShutdown() {
      // Release sockets, timers, and child processes.
    },
    async teardown() {
      // Optional generic teardown.
    },
  };
}
```

`onInit` runs after every `provide` callback for the plugin has fired. Shutdown
hooks run in reverse load order. The registry ledger removes registrations; your
teardown must still close external resources.

## Services

Register an application service with dependency ordering:

```js
registerService('myIndex', {
  dependsOn: [ 'database' ],
  async factory(context) {
    let database = context.require('database');
    return { lookup: (id) => database.lookup(id) };
  },
  async shutdown(service) {
    await service.close?.();
  },
}, { pluginName: 'my-plugin' });
```

A service may intentionally replace a core service. Unload restores the previous
service, or removes the name if there was no predecessor. Missing dependencies
and cycles fail startup.

## HTTP mounts

Mounts are authenticated by default:

```js
mountHttp(async (request, context) => {
  return { ok: true, identity: context.identity };
}, { pluginName: 'my-plugin' });
```

The mount is served below `/api/v1/plugins/<pluginID>/`. Use
`{ auth: 'public' }` only for a route that is deliberately unauthenticated, and
document why. The authenticated identity is passed to the handler.

## Properties (manifest.json: pluginID, access, properties)

`manifest.json` beside the entry is the file the **signature envelope signs**
(`.kikx-sig.payload = its exact bytes`), so everything it declares is
tamper-proof by admission — grants, disclosure text and schemas are parsed
from those bytes at load, before any plugin code runs.

```jsonc
{
  "pluginID": "/org/category/name",      // FQID: >=3 segments, registry-UNIQUE
  "access": {                             // FOREIGN (absolute) keys — mandatory to touch
    "read":  { "deny": "/other/*", "allow": ["/core/kikx/email/configuration"] },
    "write": { "deny": "*", "allow": [] }
  },
  "properties": {                         // OWN keys — optional; schema-checked on write
    "last_run": { "type": "number" },
    "label":     { "type": "string", "default": "" }
  }
}
```

Rules (reference: [Properties store](../reference/properties.md)):

- **`pluginID` is required** whenever `access` or `properties` appears.
  Relative keys resolve into your own namespace
  (`my_key` → `/plugins/org/category/name/my_key`, forced scope
  `(plugin, <fqid>)`) with **no declaration** — dynamic per-item keys are
  supported; declared keys are type-checked server-side (`string`, `number`,
  `boolean`, `object`, `array`, `null`); undeclared keys stay free within the
  64KB value cap.
- Grants are read/write SEPARATE maps; wildcards are prefix-only
  (`/core/*`, or bare `*` = the whole absolute tree) plus `{uuid}` segments
  (exactly one segment — `{UUID}` spelling folds to `{uuid}`). Evaluation is
  AeorDB-inspired (owner 2026-11-13, cf. `permission_resolver.rs`): the
  NEAREST/most specific matching declaration wins, **deny decides
  equal-specificity ties**, and nothing matching = no opinion = default deny —
  so `"deny": "*"` plus one exact allow grants exactly that key.
- Path tokens: `{uuid}` is legal in grant patterns (above); `{current}` is
  **identity-resolved at request time by users' HTTP calls** — it never
  appears in a manifest, because grants are evaluated without an identity.
- Denied absolute attempts are logged once, structured:
  `[properties-deny] caller=… action=… key=… decision=deny reason=…`.
- A malformed `access`/`properties` block **refuses the load** (nothing
  half-registers); failed loads and unloads release what was registered.
- The Settings → Plugins card discloses your grants from those signed bytes:
  `Properties: /org/category/name · reads … · writes … · declares …`.

## Frame indexes and migrations

Declare which database drivers an index supports:

```js
registerFrameIndex('my_index', {
  type: 'string',
  drivers: [ 'aeordb' ],
  extract: (frame) => frame.content?.myValue,
});
```

An index without `drivers` is available to every driver. A driver-qualified index
is hidden when another driver is active.

Register plugin SQL migrations with a plugin-relative directory:

```js
registerMigrations({ directory: 'migrations', drivers: [ 'postgres' ] });
```

Relative directories resolve beneath the plugin root. An unsupported driver is
refused rather than silently applying SQL. Plugin SQL is schema-scoped to the
plugin prefix.

## Agent provider

Extend the supplied `AgentInterface`, declare provider metadata and configuration
fields, and implement `ask()` as an async generator. Prefer core helpers for
message projection, context budgeting, tool definitions, prompt recording,
retries, and agent-loop controls. Mark the provider retry-unsafe after any side
effect that must not be repeated.

Provider configuration separates ordinary `config` from `secrets`. Never return
stored secrets in descriptors, API results, logs, or tool output.

## Browser component

Register a descriptor with a hyphenated custom-element tag and module URL. For
plugin-owned assets, use:

```text
/api/v1/plugin-assets/<pluginID>/my-tool-view.mjs
```

The module must define the declared custom element. Follow the AEOR framework
lifecycle rules, avoid Shadow DOM, and add both focused client tests and a real
browser boot/workflow test.

Composition surfaces use the same descriptor contract:

```js
registerMainApp('shell', {
  tagName: 'kikx-app',
  moduleURL: `/api/v1/plugin-assets/${pluginName}/app.mjs`,
});
```

The bootstrap loads a plugin `main-app` descriptor before defining the built-in
`kikx-app`. If the plugin module fails, the core shell remains the fallback.
`view`, `sidebar-item`, `toolbar-action`, and `settings-panel` descriptors are
available for a plugin shell to compose.

## System Settings surfaces

A plugin can paint into System Settings (the gear behind the brand mark) with
registrations from `setup()`'s provide context:

```js
registerClientSurface('settings-panel', 'echo-panel', {
  tagName: 'kikx-echo-settings',
  moduleURL: `/api/v1/plugin-assets/${pluginName}/settings.mjs`,
  label: 'Echo settings',
  section: 'Plugins',   // the tab; unknown sections clamp to General when a
                        // plugin unloads — the live section set owns that
});
registerClientSurface('sidebar-item', 'echo-row', {
  tagName: 'kikx-sidebar-echo',
  moduleURL: `/api/v1/plugin-assets/${pluginName}/sidebar.mjs`,
  label: 'Echo',        // plugin-owned rows group under a PLUGINS heading
});
```

For settings pages, extend the exported `KikxSettingsPage` base and call
`configure({ label, description, section })` — teardown runs exactly once on
disconnect. The sections model unions the base tabs with plugin sections,
stable-sorted by `surfaceID`. State a user typed belongs in the store, never
only inside a DOM node: rebuilding a subtree destroys DOM-held input, and
`ReactiveState` notifies on top-level assignment only (replace, don't mutate).

## Bundled versus external plugins

Plugins placed as immediate children of the repository `plugins/` directory load
automatically. External sites are added with `KIKX_PLUGIN_PATHS`; they extend
rather than replace bundled sites. A configured path can point to one plugin or a
container of plugin directories.

## Signing (required by default)

Real deployments verify signatures; development runs `unsafe`. Sign each plugin
directory before installing it anywhere real:

```sh
node scripts/sign-plugin.mjs --key /path/to/publisher.pem plugins/my-plugin
node scripts/sign-plugin.mjs --all-bundled   # the repository's own plugins
```

`--key` defaults to `$KIKX_PLUGIN_SIGNING_PRIVATE_KEY_FILE`; public anchors live
in `KIKX_PLUGIN_SIGNING_PUBLIC_KEYS`. The gate runs inside `loadPlugins` before
the import, so an unsigned directory in `required` mode never executes. Policy
detail lives in the [plugin reference](../reference/plugins.md#signature-policy).

## Installing and lifecycle

- **Path:** Settings → Plugins → “Install from path” (absolute directory), or
  `POST /api/v1/plugins/install {path}`.
- **npm:** the Browse column searches the registry for the `kikx-plugin`
  keyword and installs a pinned version; or `POST {npm: "pkg[@version]"}` —
  sha512-verified, tarbomb-guarded, atomic landing, the same load pipeline.
- **Updates:** an “Update available” chip (bounded registry batch check)
  reuses the exact install pipeline with the resolved version.
- **Lifecycle:** Unload stops the runtime (files stay); Disable persists a
  durable skip flag and unloads; Enable reloads from the stored location;
  Uninstall deletes **managed** directories only — built-ins refuse, durable
  data is retained. Every successful action republishes `plugin.changed`, so
  open Settings views update in place across clients.

## Teardown and reload

Unload removes the plugin’s tools, providers, drivers, components, selectors,
tags, frame indexes, mounts, migrations, services, prompt sections, and client
surfaces. It also drops event subscriptions and closes scoped databases. Durable
plugin data is retained unless the plugin explicitly purges it.

## Verification checklist

- Loader discovers file, package, and container forms as intended.
- Invalid setup or descriptor fails clearly without exposing secrets.
- `onInit` sees all registrations from the plugin; shutdown runs in reverse order.
- Service dependencies, replacement, and restoration are tested.
- Provider/driver descriptor resolution is tested, including failure fallback.
- HTTP mounts reject unauthenticated requests and pass identity when allowed.
- Driver-qualified indexes and migrations behave correctly on each driver.
- Tool schema, permission behavior, result references, and persisted frames are covered.
- Client assets cannot escape the plugin client root.
- Plugin `main-app` replacement falls back to the core shell on failure.
- Teardown releases external resources; reload produces the same registration state.
- A signed directory passes `required` mode; an unsigned one is refused before its code imports.
- Settings sections register, clamp to General when their plugin unloads, and an incoming `plugin.changed` refreshes an open view in place (no shell repaint).
- Browse install and the update chip round-trip against a mocked registry — tests never touch the network.

## Sources of truth

- `src/core/plugins/plugin-loader.mjs`
- `src/core/plugins/plugin-registry.mjs`
- `src/core/plugins/plugin-interface.mjs`
- `src/core/plugins/agent-interface.mjs`
- `src/core/plugins/plugin-router.mjs`
- `src/core/plugins/plugin-migrations.mjs`
- `src/core/database/database-connection-base.mjs`
- `src/server/routes/plugin-asset-routes.mjs`
- `src/client/app.mjs`
- `plugins/ocr/index.mjs`
- `spec/core/plugin-loader-spec.mjs`
- `spec/core/plugin-registry-spec.mjs`
- `spec/plugins/plugin-unload-spec.mjs`

## Related

- [Plugin system reference](../reference/plugins.md)
- [Tool system reference](../reference/tools.md)
- [Database driver reference](../reference/database-drivers.md)
- [Frontend guide](frontend.md)
