# Browser frontend guide

> **Current documentation — Kikx v3 (unreleased).** Last verified 2026-10-27 against the browser entrypoint, client components/state, AEOR adapter, static routes, and browser test lanes.

The current Kikx UI is a browser application built from native ES modules and custom elements. The harness itself is designed to be UI-independent: durable frames, shared projection, JSON APIs, plugin descriptors, and runtime events live outside the browser implementation.

## UI-independent boundary

Alternative clients should build on:

- database-neutral persisted frames;
- `FrameRuntime` and its HTTP routes;
- the browser-safe shared `FrameManager` projection where JavaScript reuse is appropriate;
- JSON resource endpoints;
- `/api/v1/events` runtime notifications;
- `/api/v1/client-components` metadata, or an equivalent renderer registry for the target UI.

The DOM tree, AEOR builders, browser storage, EventSource client, CSS, and custom elements are one UI implementation. They are not core runtime requirements.

## AEOR HTML framework

Kikx vendors/serves AEOR web components and re-exports the active primitives from `src/client/lib/aeor-ui.mjs`:

- `elements` for HTML builder factories;
- `ReactiveState` for top-level reactive state;
- `$` for query/event utilities.

Before changing client DOM code, read the registered `aeor-web-components` skill and its framework reference. Important constraints include:

- a tag builder finalizes when children are supplied;
- build with `.build(document)` when a real node is required;
- `false` is rendered as text, so absent conditional children must be `null`;
- state notification follows top-level assignment, not nested mutation;
- bound nodes allocate listeners that must be cleaned when a subtree is discarded;
- rebuilding live controls can destroy user input, focus, selection, scroll anchors, and lifecycle state.

Kikx intentionally does not use Shadow DOM. Shared styling and ordinary DOM inspection are part of the current component model.

## Application structure

- `kikx-app` owns application state and high-level lifecycle.
- focused controller/helper modules handle navigation, sessions, questions, agent management, and rendering.
- `kikx-data.mjs` is the browser's HTTP data boundary.
- runtime-event modules maintain one reconnecting SSE connection and apply batched updates.
- `FrameManager` turns raw frames into renderable conversation items.
- frame and tool registries select custom elements from server-provided descriptors.
- state modules keep durable UI concerns such as navigation stacks, drafts, expansion, question state, visibility, and thinking state outside ephemeral DOM nodes.

## Static module roots

The server exposes:

- `/client/` for Kikx browser modules;
- `/shared/` for browser-safe shared code;
- `/vendor/aeor-web-components/` for the framework;
- `/api/v1/plugin-assets/<pluginID>/` for loaded plugin client modules.

There is no bundler or build step in the active client. Broken imports fail at browser module-link time, which is why a real browser boot check is required in addition to unit tests.

## Authentication

The browser talks to Kikx-native `/api/v1/auth/*` routes. Kikx stores auth records through the configured database driver; it does not proxy authentication to AeorDB.

The magic-link HTML handoff writes the issued session into browser storage and redirects to a safe local path. The client attaches bearer credentials, attempts refresh when appropriate, and returns to the auth surface when the session cannot be recovered.

## Rendering and lifecycle rules

> **Current architecture gap (2026-10-30).** AEOR provides reactive leaf
> bindings and individual component properties, but it does not yet provide a
> general keyed child/list reconciler or scoped property-store layer. Kikx's
> shell still contains broad replacement paths. The evidence is in the
> [client targeted-update audit](../reports/client-targeted-update-audit-2026-10-30.md);
> the correction design is in the
> [client targeted-update layer plan](../plans/client-targeted-update-layer.md).

- Prefer stable keyed updates over whole-subtree rebuilds. Prefer property
  updates and keyed node reuse before any structural rebuild.
- Keep user-authored drafts and expansion state outside replaceable nodes.
- Clean AEOR bindings and manual state/document/window listeners on disposal.
- Preserve focus and scroll anchors when a list truly must be rebuilt.
- Route runtime-event bursts through the existing batching paths; do not trigger one full-app render per frame delta.
- Add semantic roles, labels, keyboard behavior, and visible focus to custom controls.
- Keep product-specific components in `src/client`; put genuinely reusable primitives in the AEOR project.

## Plugin rendering

At startup the client fetches component descriptors and imports each unseen `moduleURL`. The module must define the descriptor's custom-element tag. A tool class may declare `clientComponent`; registering the tool then registers its tool renderer and, when a frame type is present, the corresponding frame renderer.

A missing or invalid module can break the relevant client module graph. Production assets are staged from committed sources, so both the Kikx import and the framework/plugin asset must exist in the committed deploy inputs.

## Verification expectation

Client unit specs use a targeted mini-DOM and are fast, but they do not prove framework/browser integration. UI changes require a real-browser lane, and project policy requires Stagehand coverage for user-facing workflows. Run the relevant Playwright or Puppeteer regression as well when the defect depends on exact browser behavior, focus, layout, scrolling, module loading, or lifecycle.

## Sources of truth

- `src/client/app.mjs`
- `src/client/components/kikx-app.mjs`
- `src/client/components/kikx-data.mjs`
- `src/client/components/kikx-runtime-events.mjs`
- `src/client/components/frame-component-registry.mjs`
- `src/client/state/`
- `src/client/lib/aeor-ui.mjs`
- `src/shared/frame-manager/frame-manager.mjs`
- `src/server/static-files.mjs`
- `AGENTS.md`

## Related

- [HTTP and SSE API](../reference/http-api.md)
- [Plugin system](../reference/plugins.md)
- [Testing guide](testing.md)
- [Architecture](../architecture/README.md)
