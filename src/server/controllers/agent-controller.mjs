'use strict';

// =============================================================================
// AgentController — Agent CRUD with API key encryption
// =============================================================================

import { ControllerAuthBase } from './controller-auth-base.mjs';

export class AgentController extends ControllerAuthBase {
  // ---------------------------------------------------------------------------
  // GET /api/v2/agents
  // ---------------------------------------------------------------------------

  async list() {
    let { Agent } = this.getCoreModels();
    let agents    = await Agent.where.organizationID.EQ(this.request.organizationId).all();

    return { data: { agents } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/agents
  // ---------------------------------------------------------------------------

  async create({ body }) {
    let { name, pluginID, instructions, apiKey } = body || {};

    if (!name)
      this.throwBadRequestError('name is required');

    if (!pluginID)
      this.throwBadRequestError('pluginID is required');

    let { Agent }  = this.getCoreModels();
    let keystore   = this.getKeystore();

    let agentData = {
      organizationID: this.request.organizationId,
      name,
      pluginID,
      instructions: instructions || null,
    };

    // Encrypt API key if provided
    if (apiKey) {
      let umk       = this.request.getUMK();
      let userKey   = keystore.deriveUserKey(umk, this.request.userId);
      let encrypted = keystore.encrypt(apiKey, userKey);

      agentData.encryptedAPIKey = JSON.stringify(encrypted);
    }

    let agent = await Agent.create(agentData);

    this.setStatusCode(201);

    return { data: { agent } };
  }

  // ---------------------------------------------------------------------------
  // GET /api/v2/agents/:id
  // ---------------------------------------------------------------------------

  async show({ params }) {
    let { Agent } = this.getCoreModels();
    let agent     = await Agent.where.id.EQ(params.id).first();

    if (!agent)
      this.throwNotFoundError('Agent not found');

    return { data: { agent } };
  }

  // ---------------------------------------------------------------------------
  // PUT /api/v2/agents/:id
  // ---------------------------------------------------------------------------

  async update({ params, body }) {
    let { Agent } = this.getCoreModels();
    let agent     = await Agent.where.id.EQ(params.id).first();

    if (!agent)
      this.throwNotFoundError('Agent not found');

    let { name, pluginID, instructions, apiKey } = body || {};

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
        let userKey   = keystore.deriveUserKey(umk, this.request.userId);
        let encrypted = keystore.encrypt(apiKey, userKey);

        agent.encryptedAPIKey = JSON.stringify(encrypted);
      } else {
        agent.encryptedAPIKey = null;
      }
    }

    await agent.save();

    return { data: { agent } };
  }

  // ---------------------------------------------------------------------------
  // DELETE /api/v2/agents/:id
  // ---------------------------------------------------------------------------

  async destroy({ params }) {
    let { Agent } = this.getCoreModels();
    let agent     = await Agent.where.id.EQ(params.id).first();

    if (!agent)
      this.throwNotFoundError('Agent not found');

    await agent.destroy();

    return { data: { deleted: true } };
  }
}
