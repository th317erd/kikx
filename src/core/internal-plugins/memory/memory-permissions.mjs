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
//   Session context tools (getSessionContext, setSessionContext, updateSessionContext):
//     Always deferred to normal rule matching — these operate on sessions,
//     not agent-owned data, and the write variants have riskLevel: 'high'.
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
  async checkPermission(featureName, args, options) {
    if (!AGENT_OWNED_TOOLS.has(featureName))
      return null; // Session context tools — defer to normal rule matching

    // If agentID targets a different agent, defer to rules (require approval)
    let callingAgent = options && options.agent;
    if (callingAgent && args && args.agentID && args.agentID !== callingAgent.id)
      return null;

    return false; // Agent accessing its own data — auto-approved
  }
}
