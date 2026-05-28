'use strict';

import { Permissions } from '../../permissions/permissions-base.mjs';

// =============================================================================
// MemoryPermissions
// =============================================================================
// Logic-based permission decisions for memory tools.
//
// Authority boundary: agent identity.
//
//   Agent-owned tools (getAgentConfig, setAgentConfig, updateAgentConfig,
//                      getValue, setValue, searchValues):
//     Auto-approved when the agent is accessing its OWN data — regardless of
//     scopeID, key, or any other arguments. All scopes belong to the agent.
//     If the agentID targets a DIFFERENT agent, defer to rules (per-situation).
//
//   Session context tools:
//     getSessionContext: auto-approved when reading the agent's current session
//       (no sessionID arg, or sessionID matches the current session scope).
//       Reading a different session defers to rules.
//     setSessionContext, updateSessionContext: always deferred to normal rule
//       matching — writes have riskLevel: 'high'.
// =============================================================================

const AGENT_OWNED_TOOLS = new Set([
  'memory:getAgentConfig',
  'memory:setAgentConfig',
  'memory:updateAgentConfig',
  'memory:getValue',
  'memory:setValue',
  'memory:searchValues',
]);

export class MemoryPermissions extends Permissions {
  /**
   * @param {string} featureName
   * @param {Record<string, any>} args
   * @param {{ scopeID?: string, agent?: import('../../types').Agent }} options
   * @returns {Promise<boolean | null>}
   */
  async checkPermission(featureName, args, options) {
    // Reading the current session's context is harmless — auto-approve
    if (featureName === 'memory:getSessionContext') {
      let currentSessionID = options && options.scopeID;
      let requestedSession = args && args.sessionID;

      // No explicit sessionID = current session, or explicit match
      if (!requestedSession || requestedSession === currentSessionID)
        return false;

      return null; // Different session — defer to rules
    }

    if (!AGENT_OWNED_TOOLS.has(featureName))
      return null; // Write session tools + unknown — defer to normal rule matching

    // If agentID targets a different agent, defer to rules (require approval)
    let callingAgent = options && options.agent;
    if (callingAgent && args && args.agentID && args.agentID !== callingAgent.id)
      return null;

    return false; // Agent accessing its own data — auto-approved
  }
}
