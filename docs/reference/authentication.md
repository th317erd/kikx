# Authentication reference

> **Current documentation — Kikx v3 (unreleased).** Last verified 2026-10-27 against the native auth stores, account store, HTTP routes, and browser sign-in flow.

Kikx authentication is native and database-driver-neutral. It is not delegated to AeorDB. Users, magic-link records, access/refresh sessions, and API keys are ordinary durable documents stored through the configured database driver.

## Services and records

`createAuthService` composes four stores:

- users;
- sessions;
- API keys;
- single-use magic links.

Opaque access tokens, refresh tokens, API keys, and magic-link codes use generated identifiers and secrets. Durable records keep hashes rather than raw secrets. API-key creation returns the full key only once. Refresh rotation replaces both access and refresh hashes, invalidating both previous tokens.

Disabled or missing users fail authentication. Access verification intentionally returns `null` for malformed, expired, revoked, or disabled identities so callers receive one consistent unauthenticated outcome.

## First administrator

When `KIKX_ADMIN_EMAIL` is configured and no users exist, startup attempts to create the first administrator and request a magic link. It never creates a second administrator merely because the process restarts. Bootstrap is best-effort: failure is logged and does not abort server startup.

When no users exist and no admin email is configured, the server logs a warning.

## Public authentication routes

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/auth/magic-link` | Request a link without revealing whether the email exists |
| `GET` | `/api/v1/auth/magic-link/verify?code=...` | Consume a code and issue tokens; can return a browser handoff page |
| `POST` | `/api/v1/auth/token` | Exchange an API key for a session |
| `POST` | `/api/v1/auth/refresh` | Rotate a refresh token and issue a new token pair |
| `POST` | `/api/v1/auth/logout` | Revoke the current session when identifiable; remains idempotently successful |

## Authenticated account routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/auth/me` | Current public user record |
| `GET` | `/api/v1/auth/api-keys` | List the current user's redacted keys |
| `POST` | `/api/v1/auth/api-keys` | Create a key and return its secret once |
| `DELETE` | `/api/v1/auth/api-keys/:id` | Revoke one of the current user's keys |
| `GET` | `/api/v1/account` | Read account profile |
| `PATCH` | `/api/v1/account` | Update supported profile fields |

The browser keeps session data in session storage and a shared local-storage record so a successful HTML magic-link handoff can open the application. API calls use the bearer access token and refresh through the native refresh route.

## Route-by-route authorization caution

The HTTP router does not apply one global authentication middleware. Each route handler decides whether and how to resolve identity. Some infrastructure and descriptor routes are intentionally unauthenticated; some message/question operations accept optional identity; account and API-key routes require it.

Do not infer that an endpoint is authenticated merely because it is under `/api/v1`, and do not state a broad API authorization guarantee without checking the handler. Security-sensitive documentation and changes must be verified route by route.

## Magic-link safety properties

- Requests return the same success shape for known and unknown addresses.
- A link is generated only for an existing enabled user.
- Mail delivery failure is logged without converting the public response into an account-existence oracle.
- The public base URL is validated at service construction.
- Browser redirects accept only safe root-relative paths.
- The handoff page escapes embedded JSON and sends restrictive response headers.

## Sources of truth

- `src/core/auth/auth-service.mjs`
- `src/core/auth/user-store.mjs`
- `src/core/auth/session-store.mjs`
- `src/core/auth/api-key-store.mjs`
- `src/core/auth/magic-link-store.mjs`
- `src/core/auth/token-utils.mjs`
- `src/core/account/account-store.mjs`
- `src/server/routes/auth-routes.mjs`
- `src/client/components/kikx-auth.mjs`

## Related

- [Configuration reference](configuration.md)
- [HTTP and SSE API](http-api.md)
- [Development setup](../guides/development.md)
- [Storage model and paths](storage.md)

