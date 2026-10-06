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
