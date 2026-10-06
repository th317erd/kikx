'use strict';

// Canonical property paths for Kikx's existing configuration surface. Each
// path is chosen so that `envKeyFor(path)` reproduces the historical
// environment-variable name exactly, preserving backwards compatibility.
// `spec/core/config/config-paths-spec.mjs` guards that invariant.

export const KIKX_HOST_PATH = '/kikx/host';
export const KIKX_PORT_PATH = '/kikx/port';
export const AEORDB_URL_PATH = '/aeordb/url';
export const AEORDB_TOKEN_PATH = '/aeordb/token';
export const KIKX_PLUGIN_PATHS_PATH = '/kikx/plugin/paths';
export const KIKX_CONTEXT_WINDOW_TOKENS_PATH = '/kikx/context/window/tokens';
export const KIKX_COMPACTION_AGENT_ID_PATH = '/kikx/compaction/agent/id';
export const KIKX_COMPACTION_AGENT_CONTEXT_TOKENS_PATH = '/kikx/compaction/agent/context/tokens';
export const KIKX_CONTEXT_PROMPT_RESERVE_TOKENS_PATH = '/kikx/context/prompt/reserve/tokens';
export const KIKX_COMPACTION_TRIGGER_RATIO_PATH = '/kikx/compaction/trigger/ratio';
export const KIKX_COMPACTION_HARD_RATIO_PATH = '/kikx/compaction/hard/ratio';
export const AEOR_WEB_COMPONENTS_DIR_PATH = '/aeor/web/components/dir';

// Canonical database-driver selection path (env ORG_AEOR_KIKX_DATABASE_DRIVER)
// with a transition alias retained for convenience (env KIKX_DATABASE_DRIVER).
export const DATABASE_DRIVER_PATH = '/org/aeor/kikx/database/driver';
export const KIKX_DATABASE_DRIVER_PATH = '/kikx/database/driver';

// Canonical database-location path (env ORG_AEOR_KIKX_DATABASE_PATH) with a
// transition alias (env KIKX_DATABASE_PATH). Drivers that take a file/URL
// location (e.g. SQLite) read this; AeorDB ignores it and keeps its own keys.
export const DATABASE_PATH_PATH = '/org/aeor/kikx/database/path';
export const KIKX_DATABASE_PATH = '/kikx/database/path';

// Canonical database-URL path (env ORG_AEOR_KIKX_DATABASE_URL) with a
// transition alias (env KIKX_DATABASE_URL). URLs are consumed by drivers that
// connect to a network server (e.g. PostgreSQL); AeorDB keeps its own keys.
export const DATABASE_URL_PATH = '/org/aeor/kikx/database/url';
export const KIKX_DATABASE_URL = '/kikx/database/url';

// Kikx-native authentication configuration. Each path round-trips to the
// documented environment name via `envKeyFor`.
export const KIKX_ADMIN_EMAIL_PATH = '/kikx/admin/email';
export const KIKX_ADMIN_NAME_PATH = '/kikx/admin/name';
export const KIKX_AUTH_PUBLIC_URL_PATH = '/kikx/auth/public/url';
export const KIKX_AUTH_MAILER_MODE_PATH = '/kikx/auth/mailer/mode';
export const KIKX_AUTH_MAILER_SMTP_URL_PATH = '/kikx/auth/mailer/smtp/url';
export const KIKX_AUTH_MAILER_FROM_PATH = '/kikx/auth/mailer/from';
export const KIKX_AUTH_ACCESS_TTL_SECONDS_PATH = '/kikx/auth/session/access/ttl/seconds';
export const KIKX_AUTH_REFRESH_TTL_SECONDS_PATH = '/kikx/auth/session/refresh/ttl/seconds';
export const KIKX_AUTH_MAGIC_LINK_TTL_SECONDS_PATH = '/kikx/auth/magic/link/ttl/seconds';
