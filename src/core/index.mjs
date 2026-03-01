'use strict';

// =============================================================================
// Hero Core — Public API
// =============================================================================
// Entry point for the embeddable Hero engine.
// Zero HTTP dependencies. Can run in CLI, Discord bot, Electron, etc.
// =============================================================================

export { HeroCore }                            from './hero-core.mjs';
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

import { HeroCore } from './hero-core.mjs';

export function createHeroCore(config) {
  return new HeroCore(config);
}
