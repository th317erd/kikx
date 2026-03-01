'use strict';

// =============================================================================
// Hero V2 Models — Index
// =============================================================================
// All models exported for registration with the ORM connection.
// IMPORTANT: Never import models directly in application code.
// Always get them from context: core.getModels() or context.getProperty('models')
// =============================================================================

export { ModelBase, Model, Types } from './model-base.mjs';
export { Organization }            from './organization-model.mjs';
export { User }                    from './user-model.mjs';
export { Role }                    from './role-model.mjs';
export { Agent }                   from './agent-model.mjs';
export { Session }                 from './session-model.mjs';
export { Participant }             from './participant-model.mjs';
export { Frame }                   from './frame-model.mjs';

import { Organization } from './organization-model.mjs';
import { User }         from './user-model.mjs';
import { Role }         from './role-model.mjs';
import { Agent }        from './agent-model.mjs';
import { Session }      from './session-model.mjs';
import { Participant }  from './participant-model.mjs';
import { Frame }        from './frame-model.mjs';

// Default model set for core
export const DEFAULT_MODELS = [
  Organization,
  User,
  Role,
  Agent,
  Session,
  Participant,
  Frame,
];
