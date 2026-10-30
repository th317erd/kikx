# HTTP and SSE API reference

> **Current documentation — Kikx v3 (unreleased).** Last verified 2026-10-27 against the plain Node HTTP router and all route handlers.

Kikx serves JSON APIs, an SSE runtime stream, plugin assets, and the current browser client from one plain Node HTTP server. This page inventories the route surface; request and response schemas remain defined by the handlers and stores named in Sources of truth.

## Response and authentication conventions

Successful JSON responses generally wrap payloads in `{ "data": ... }`. Failures use `{ "error": { "message": ... } }` with the error's status or 500. A handler that has already started an SSE response destroys the connection on failure rather than corrupting it with JSON.

Authorization is route-specific. There is no global middleware that makes every `/api/v1` endpoint authenticated. Consult the relevant handler before relying on an access-control property.

## Infrastructure, descriptors, and streaming

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness, readiness, database presence, compact memory status |
| `GET` | `/api/v1/infra/memory` | Memory-monitor snapshot; `?samples=1` includes the bounded ring |
| `GET` | `/api/v1/events` | Server-Sent Events, optionally filtered by `sessionID` |
| `GET` | `/api/v1/tokens` | Token-usage snapshot and total |
| `GET` | `/api/v1/client-components` | Registered frame/tool/provider-form component descriptors |
| `GET` | `/api/v1/database-drivers` | Installed driver descriptors and active driver ID |
| `GET` | `/api/v1/agent-providers` | Agent provider descriptors |
| `GET` | `/api/v1/models` | Models exposed by registered providers |
| `GET` | `/api/v1/tag-definitions` | Registered typed tag definitions |
| `GET` | `/api/v1/tool-outputs/:id` | Bounded stored-output read with range/full options |
| `GET` | `/api/v1/aeordb/events-url` | Legacy backend-specific event URL; not portable across drivers |

`/health` returns HTTP 200 even while `ready` is false. A readiness consumer must inspect the field, not only the status code.

## Authentication and account

| Method | Path |
| --- | --- |
| `POST` | `/api/v1/auth/magic-link` |
| `GET` | `/api/v1/auth/magic-link/verify` |
| `POST` | `/api/v1/auth/token` |
| `POST` | `/api/v1/auth/refresh` |
| `POST` | `/api/v1/auth/logout` |
| `GET` | `/api/v1/auth/me` |
| `GET`, `POST` | `/api/v1/auth/api-keys` |
| `DELETE` | `/api/v1/auth/api-keys/:id` |
| `GET`, `PATCH` | `/api/v1/account` |

See [Authentication](authentication.md) for flow and safety details.

## Sessions and frames

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`, `POST` | `/api/v1/sessions` | List or create sessions |
| `POST` | `/api/v1/sessions/previews` | Batch session previews |
| `PATCH`, `DELETE` | `/api/v1/sessions/:id` | Update or soft-delete a session |
| `POST` | `/api/v1/sessions/:id/restore` | Restore a soft-deleted session |
| `POST` | `/api/v1/sessions/:id/cancel` | Cancel active agent work |
| `GET` | `/api/v1/sessions/:id/frames` | Raw/projected frame window according to query options |
| `GET` | `/api/v1/sessions/:id/frame-counts` | Counts used by filtering/navigation |
| `POST` | `/api/v1/sessions/:id/messages` | Append a user message and start routing |
| `GET` | `/api/v1/sessions/:id/preferences` | Effective or keyed session preferences |
| `POST` | `/api/v1/sessions/:id/compaction/:frameID/retry` | Retry a failed compaction window |
| `GET` | `/api/v1/sessions/:id/composer/history` | Composer history |
| `GET` | `/api/v1/sessions/:id/composer/drafts` | Composer drafts |
| `PUT`, `DELETE` | `/api/v1/sessions/:id/composer/drafts/:draftID` | Save/delete a draft |
| `DELETE` | `/api/v1/sessions/:id/composer/history/:itemID` | Remove a history item |

Query parsing, frame filters, pagination, inclusion of deleted sessions, and ancestry scope are implemented by `session-routes.mjs` and shared filter helpers.

## Questions and inbox

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/questions` | Query visible questions/inbox state |
| `POST` | `/api/v1/questions/:id/answer` | Store an answer or allowed revision and wake the asker |
| `POST` | `/api/v1/questions/:id/read` | Mark one question read |
| `POST` | `/api/v1/questions/:id/dismiss` | Withdraw an open question |

## Agents and teams

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`, `POST` | `/api/v1/agents` | List or create agents |
| `GET`, `PATCH`, `DELETE` | `/api/v1/agents/:id` | Read, update, or delete an agent |
| `GET` | `/api/v1/agents/masters` | Leadership-selected agents |
| `GET` | `/api/v1/agents/compaction-bots` | Compaction-selected agents |
| `POST` | `/api/v1/agents/:id/crown` and `/uncrown` | Toggle leadership role |
| `POST` | `/api/v1/agents/:id/compact-crown` and `/compact-uncrown` | Toggle compaction role |
| `GET`, `POST` | `/api/v1/teams` | List or create teams |
| `GET`, `PATCH`, `DELETE` | `/api/v1/teams/:id` | Read, update, or delete a team |
| `POST` | `/api/v1/teams/:id/members` | Add a member |
| `DELETE` | `/api/v1/teams/:id/members/:memberID` | Remove a member |

## Tags and images

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`, `POST` | `/api/v1/tags` | Query or create tags |
| `GET`, `PUT`, `PATCH`, `DELETE` | `/api/v1/tags/:targetType/:targetID/:name` | Read/replace/update/delete one tag |
| `GET`, `HEAD` | `/api/v1/image-proxy` | Authenticated, preference-aware local image proxy |

The image proxy validates permitted paths and magic bytes and returns a safe placeholder for disabled, invalid, blocked, missing, or non-image inputs.

## Static and plugin assets

| Path | Source |
| --- | --- |
| `/`, `/index.html` | browser entry document |
| `/client/*` | Kikx browser modules and styles |
| `/shared/*` | browser-safe shared modules |
| `/vendor/aeor-web-components/*` | AEOR framework checkout/vendor tree |
| `/api/v1/plugin-assets/:pluginID/*` | loaded plugin's `client/` directory |

Static and plugin routes reject traversal outside their configured roots.

## Runtime event delivery

`RuntimeEventGateway` subscribes once to the frame runtime, coalesces repeated updates for the same session/frame/type, and distributes bounded batches to SSE subscribers. Clients may filter by session. The browser reconnects and performs resynchronization after interruption; SSE is a notification/update transport, not the sole durable source of session history.

## Sources of truth

- `src/server/router.mjs`
- `src/server/routes/*.mjs`
- `src/server/routes/route-matchers.mjs`
- `src/server/events.mjs`
- `src/server/runtime-event-gateway.mjs`
- `src/server/static-files.mjs`
- `src/server/http-helpers.mjs`

## Related

- [Authentication reference](authentication.md)
- [Storage model and paths](storage.md)
- [Frontend guide](../guides/frontend.md)
- [Observability](../operations/observability.md)
