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

## Bundled versus external plugins

Plugins placed as immediate children of the repository `plugins/` directory load
automatically. External sites are added with `KIKX_PLUGIN_PATHS`; they extend
rather than replace bundled sites. A configured path can point to one plugin or a
container of plugin directories.

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
