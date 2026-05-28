# Architecture

Kikx is being rebuilt around a small set of explicit runtime boundaries:

- `AeorDBClient`: HTTP access to the standalone AeorDB process.
- `AppContext`: service registry for process-local services.
- Server routes: plain Node HTTP handlers that call explicit services.
- Repositories: planned storage adapters for sessions, frames, value store entries, permissions, agents, users, and token usage.
- Plugins: planned agent/tool extension points, copied forward from the old app only where the contracts still fit.

The legacy implementation is available under `old-app/` and should be treated as reference material, not as active runtime code.

