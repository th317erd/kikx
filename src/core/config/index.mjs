'use strict';

export { normalizePropertyPath, envKeyFor, joinPropertyPath } from './property-path.mjs';
export { ConfigError } from './config-error.mjs';
export {
  createProcessEnvProvider,
  createObjectProvider,
  createDefaultsProvider,
  flattenJsonEnv,
  loadJsonEnvFile,
} from './config-providers.mjs';
export { ConfigStore, createConfigStore } from './config-store.mjs';
export { loadEnvFile, loadJsonEnv, loadEnvSources, snapshotEnvironment } from './env-loader.mjs';
export {
  KIKX_HOST_PATH,
  KIKX_PORT_PATH,
  AEORDB_URL_PATH,
  AEORDB_TOKEN_PATH,
  KIKX_PLUGIN_PATHS_PATH,
  KIKX_CONTEXT_WINDOW_TOKENS_PATH,
  KIKX_COMPACTION_AGENT_ID_PATH,
  KIKX_COMPACTION_AGENT_CONTEXT_TOKENS_PATH,
  KIKX_CONTEXT_PROMPT_RESERVE_TOKENS_PATH,
  KIKX_COMPACTION_TRIGGER_RATIO_PATH,
  KIKX_COMPACTION_HARD_RATIO_PATH,
  AEOR_WEB_COMPONENTS_DIR_PATH,
  DATABASE_DRIVER_PATH,
  KIKX_DATABASE_DRIVER_PATH,
  DATABASE_PATH_PATH,
  KIKX_DATABASE_PATH,
  DATABASE_URL_PATH,
  KIKX_DATABASE_URL,
  KIKX_ADMIN_EMAIL_PATH,
  KIKX_ADMIN_NAME_PATH,
  KIKX_AUTH_PUBLIC_URL_PATH,
  KIKX_AUTH_MAILER_MODE_PATH,
  KIKX_AUTH_MAILER_SMTP_URL_PATH,
  KIKX_AUTH_MAILER_FROM_PATH,
  KIKX_AUTH_ACCESS_TTL_SECONDS_PATH,
  KIKX_AUTH_REFRESH_TTL_SECONDS_PATH,
  KIKX_AUTH_MAGIC_LINK_TTL_SECONDS_PATH,
} from './config-paths.mjs';
