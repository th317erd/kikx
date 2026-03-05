'use strict';

// =============================================================================
// Agent Resolver
// =============================================================================
// Factored out of InteractionController: resolves an agent record into the
// data needed to start an interaction (plugin instance, resolved agent record,
// permission/tool callbacks).
//
// Accepts injectable `resolveContext` for HTTP-specific concerns (UMK for key
// decryption, userId for permissions).
// =============================================================================

export class AgentResolver {
  constructor(core) {
    if (!core)
      throw new Error('AgentResolver requires a KikxCore instance');

    this._core = core;
  }

  // ---------------------------------------------------------------------------
  // resolve
  // ---------------------------------------------------------------------------
  // Resolves an agent ID into a fully ready interaction params object.
  //
  // resolveContext:
  //   keystore       — Keystore instance (for API key decryption)
  //   umk            — User master key (Buffer)
  //   userId         — authenticated user ID
  //   sessionID      — session scope for permissions
  //
  // Returns: { agentPlugin, resolvedAgent }
  // ---------------------------------------------------------------------------

  async resolve(agentID, resolveContext = {}) {
    let models = this._core.getModels();
    let { Agent } = models;

    let agent = await Agent.where.id.EQ(agentID).first();
    if (!agent)
      throw new Error(`Agent not found: ${agentID}`);

    // Get agent plugin class and instantiate
    let AgentClass = this._core.getAgentType(agent.pluginID);
    if (!AgentClass)
      throw new Error(`No agent plugin registered for: ${agent.pluginID}`);

    let agentPlugin = new AgentClass(this._core.getContext());

    // Build resolved agent record
    let resolvedAgent = { ...(agent.toJSON ? agent.toJSON() : agent) };

    // Decrypt API key if encrypted and context provides keys
    if (agent.encryptedAPIKey && resolveContext.keystore && resolveContext.umk && resolveContext.userId) {
      try {
        let userKey   = resolveContext.keystore.deriveUserKey(resolveContext.umk, resolveContext.userId);
        let encrypted = JSON.parse(agent.encryptedAPIKey);

        resolvedAgent.apiKey = resolveContext.keystore.decrypt(encrypted, userKey).toString('utf8');
      } catch (_error) {
        throw new Error(`Failed to decrypt API key for agent: ${agentID}`);
      }
    }

    return { agentPlugin, resolvedAgent };
  }
}
