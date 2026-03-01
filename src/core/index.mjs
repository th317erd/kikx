'use strict';

// =============================================================================
// Kikx Core — Public API
// =============================================================================
// Entry point for the embeddable Kikx engine.
// Zero HTTP dependencies. Can run in CLI, Discord bot, Electron, etc.
// =============================================================================

export { KikxCore }                            from './kikx-core.mjs';
export { CascadingContext, createContext }      from './context/index.mjs';
export { DEFAULT_CONFIG, mergeConfig }         from './config/index.mjs';
export { DEFAULT_MODELS }                      from './models/index.mjs';
export {
  ModelBase,
  Organization,
  User,
  Role,
  Agent,
  Session,
  Participant,
  Frame,
}  from './models/index.mjs';

import { KikxCore } from './kikx-core.mjs';

export function createKikxCore(config) {
  return new KikxCore(config);
}
