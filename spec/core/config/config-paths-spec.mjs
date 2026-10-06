'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { envKeyFor } from '../../../src/core/config/property-path.mjs';
import {
  AEORDB_TOKEN_PATH,
  AEORDB_URL_PATH,
  AEOR_WEB_COMPONENTS_DIR_PATH,
  KIKX_COMPACTION_AGENT_ID_PATH,
  KIKX_COMPACTION_AGENT_CONTEXT_TOKENS_PATH,
  KIKX_COMPACTION_HARD_RATIO_PATH,
  KIKX_COMPACTION_TRIGGER_RATIO_PATH,
  KIKX_CONTEXT_PROMPT_RESERVE_TOKENS_PATH,
  KIKX_CONTEXT_WINDOW_TOKENS_PATH,
  KIKX_HOST_PATH,
  KIKX_PLUGIN_PATHS_PATH,
  KIKX_PORT_PATH,
} from '../../../src/core/config/config-paths.mjs';

// Compatibility guard: each property path must derive the exact historical
// environment-variable name. If any mapping changes, the existing `.env` keys
// would stop resolving.
test('config paths derive the historical environment-variable names', () => {
  let cases = [
    [KIKX_HOST_PATH, 'KIKX_HOST'],
    [KIKX_PORT_PATH, 'KIKX_PORT'],
    [AEORDB_URL_PATH, 'AEORDB_URL'],
    [AEORDB_TOKEN_PATH, 'AEORDB_TOKEN'],
    [KIKX_PLUGIN_PATHS_PATH, 'KIKX_PLUGIN_PATHS'],
    [KIKX_CONTEXT_WINDOW_TOKENS_PATH, 'KIKX_CONTEXT_WINDOW_TOKENS'],
    [KIKX_COMPACTION_AGENT_ID_PATH, 'KIKX_COMPACTION_AGENT_ID'],
    [KIKX_COMPACTION_AGENT_CONTEXT_TOKENS_PATH, 'KIKX_COMPACTION_AGENT_CONTEXT_TOKENS'],
    [KIKX_CONTEXT_PROMPT_RESERVE_TOKENS_PATH, 'KIKX_CONTEXT_PROMPT_RESERVE_TOKENS'],
    [KIKX_COMPACTION_TRIGGER_RATIO_PATH, 'KIKX_COMPACTION_TRIGGER_RATIO'],
    [KIKX_COMPACTION_HARD_RATIO_PATH, 'KIKX_COMPACTION_HARD_RATIO'],
    [AEOR_WEB_COMPONENTS_DIR_PATH, 'AEOR_WEB_COMPONENTS_DIR'],
  ];

  for (const [propertyPath, expectedEnvKey] of cases)
    assert.equal(envKeyFor(propertyPath), expectedEnvKey, propertyPath);
});
