# Architecture

Kikx is being rebuilt around a small set of explicit runtime boundaries:

- `AeorDBClient`: HTTP access to the standalone AeorDB process.
- `AppContext`: service registry for process-local services.
- Server routes: plain Node HTTP handlers that call explicit services.
- Browser client: native modules served from `src/client/`, built with AEOR's Element Builder, `ReactiveState`, Query Engine, and shared web components from `~/Projects/aeor-web-components`.
- Repositories: planned storage adapters for sessions, frames, value store entries, permissions, agents, users, and token usage.
- Plugins: planned agent/tool extension points, copied forward from the old app only where the contracts still fit.
- Agentic script: the shared agent loop prompt/contract generated from executable templates. See [Agentic Script](./agentic-script.md).
- Context compaction: async memory compression using hidden `CompactionFrame` records. See [Context Compaction](./context-compaction.md).

The legacy implementation is available under `old-app/` and should be treated as reference material, not as active runtime code.
