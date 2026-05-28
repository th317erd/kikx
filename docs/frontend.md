# Frontend

Kikx uses AEOR's shared browser primitives for all HTML construction:

- Element Builder for DOM creation.
- `ReactiveState` for dynamic UI state.
- Query Engine for DOM selection, live-node relocation, and event helpers.
- Shared components from `~/Projects/aeor-web-components` when the component is reusable across AEOR products.

Product-specific composition lives in `src/client/`. A component should move to `~/Projects/aeor-web-components` when it is not tied to Kikx data contracts, message semantics, or agent-runner workflows.

The Node server exposes the shared repo at `/vendor/aeor-web-components/`, so the browser imports the actively developed local source rather than a copied snapshot.
