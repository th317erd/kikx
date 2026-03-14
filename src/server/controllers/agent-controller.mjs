'use strict';

// =============================================================================
// AgentController — Agent CRUD with API key encryption
// =============================================================================

import { ControllerAuthBase } from './controller-auth-base.mjs';

let VALID_RISK_LEVELS = new Set(['strict', 'normal', 'permissive']);

export class AgentController extends ControllerAuthBase {
  // ---------------------------------------------------------------------------
  // GET /api/v2/agents
  // ---------------------------------------------------------------------------

  async list() {
    let { Agent } = this.getCoreModels();
    let agents    = await Agent.where.organizationID.EQ(this.request.organizationID).all();

    return { data: { agents } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/agents
  // ---------------------------------------------------------------------------

  async create({ body }) {
    let { name, pluginID, instructions, apiKey, riskLevel } = body || {};

    if (!name)
      this.throwBadRequestError('name is required');

    if (!pluginID)
      this.throwBadRequestError('pluginID is required');

    if (riskLevel && !VALID_RISK_LEVELS.has(riskLevel))
      this.throwBadRequestError(`Invalid riskLevel: "${riskLevel}". Must be one of: strict, normal, permissive`);

    let { Agent }  = this.getCoreModels();
    let keystore   = this.getKeystore();

    let agentData = {
      organizationID: this.request.organizationID,
      name,
      pluginID,
      instructions: instructions || null,
    };

    // Encrypt API key if provided
    if (apiKey) {
      let umk       = this.request.getUMK();
      let userKey   = keystore.deriveUserKey(umk, this.request.userID);
      let encrypted = keystore.encrypt(apiKey, userKey);

      agentData.encryptedAPIKey = JSON.stringify(encrypted);
    }

    let agent = await Agent.create(agentData);

    // Generate Ed25519 signing key pair for agent
    let { publicKey: signingPublicKey, privateKey: signingPrivateKey } = keystore.generateSigningKeyPair();
    let encryptedSigningKey = keystore.encryptActorPrivateKey(signingPrivateKey, agent.id);

    agent.publicKey           = signingPublicKey;
    agent.encryptedPrivateKey = JSON.stringify(encryptedSigningKey);
    await agent.save();

    // Store riskLevel in agent config if provided
    if (riskLevel)
      await agent.updateConfig({ riskLevel });

    this.setStatusCode(201);

    let config = await agent.getConfig();

    return { data: { agent, riskLevel: config.riskLevel || null } };
  }

  // ---------------------------------------------------------------------------
  // GET /api/v2/agents/:id
  // ---------------------------------------------------------------------------

  async show({ params }) {
    let { Agent } = this.getCoreModels();
    let agent     = await Agent.where.id.EQ(params.agentID).first();

    if (!agent)
      this.throwNotFoundError('Agent not found');

    let config = await agent.getConfig();

    return { data: { agent, riskLevel: config.riskLevel || null } };
  }

  // ---------------------------------------------------------------------------
  // PUT /api/v2/agents/:id
  // ---------------------------------------------------------------------------

  async update({ params, body }) {
    let { Agent } = this.getCoreModels();
    let agent     = await Agent.where.id.EQ(params.agentID).first();

    if (!agent)
      this.throwNotFoundError('Agent not found');

    let { name, pluginID, instructions, apiKey, riskLevel } = body || {};

    if (name !== undefined)
      agent.name = name;

    if (pluginID !== undefined)
      agent.pluginID = pluginID;

    if (instructions !== undefined)
      agent.instructions = instructions;

    // Encrypt new API key if provided
    if (apiKey !== undefined) {
      if (apiKey) {
        let keystore  = this.getKeystore();
        let umk       = this.request.getUMK();
        let userKey   = keystore.deriveUserKey(umk, this.request.userID);
        let encrypted = keystore.encrypt(apiKey, userKey);

        agent.encryptedAPIKey = JSON.stringify(encrypted);
      } else {
        agent.encryptedAPIKey = null;
      }
    }

    await agent.save();

    // Update riskLevel in agent config if provided
    if (riskLevel !== undefined) {
      if (riskLevel === null || riskLevel === '') {
        await agent.updateConfig({ riskLevel: null });
      } else {
        if (!VALID_RISK_LEVELS.has(riskLevel))
          this.throwBadRequestError(`Invalid riskLevel: "${riskLevel}". Must be one of: strict, normal, permissive`);

        await agent.updateConfig({ riskLevel });
      }
    }

    let config = await agent.getConfig();

    return { data: { agent, riskLevel: config.riskLevel || null } };
  }

  // ---------------------------------------------------------------------------
  // DELETE /api/v2/agents/:id
  // ---------------------------------------------------------------------------

  async destroy({ params }) {
    let { Agent } = this.getCoreModels();
    let agent     = await Agent.where.id.EQ(params.agentID).first();

    if (!agent)
      this.throwNotFoundError('Agent not found');

    await agent.destroy();

    return { data: { deleted: true } };
  }
}
