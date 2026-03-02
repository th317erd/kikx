'use strict';

// =============================================================================
// DmController — DM session management for agent abilities
// =============================================================================
// Manages direct message sessions that configure agent behavior.
// DM conversations are summarized into instructions injected into
// the agent's system prompt for regular chat sessions.
// =============================================================================

import { ControllerAuthBase } from './controller-auth-base.mjs';
import { DmSummarizer }      from '../../core/dm/index.mjs';

export class DmController extends ControllerAuthBase {
  // ---------------------------------------------------------------------------
  // POST /api/v2/agents/:id/dm — get or create DM session
  // ---------------------------------------------------------------------------

  async getOrCreate({ params }) {
    let agentId        = params.id;
    let { Agent }      = this.getCoreModels();
    let sessionManager = this.getSessionManager();

    // Verify agent exists
    let agent = await Agent.where.id.EQ(agentId).first();
    if (!agent)
      this.throwNotFoundError('Agent not found');

    // Look for existing DM session
    let { Session } = this.getCoreModels();
    let existing    = await Session.where
      .type.EQ('dm')
      .dmAgentID.EQ(agentId)
      .organizationID.EQ(agent.organizationID)
      .first();

    if (existing)
      return { data: { session: existing } };

    // Create new DM session
    let session = await sessionManager.createSession(agent.organizationID, {
      name:      `DM: ${agent.name}`,
      type:      'dm',
      dmAgentID: agentId,
    });

    this.setStatusCode(201);

    return { data: { session } };
  }

  // ---------------------------------------------------------------------------
  // GET /api/v2/agents/:id/dm/summary — read current DM summary
  // ---------------------------------------------------------------------------

  async getSummary({ params }) {
    let agentId   = params.id;
    let { Agent } = this.getCoreModels();

    let agent = await Agent.where.id.EQ(agentId).first();
    if (!agent)
      this.throwNotFoundError('Agent not found');

    return { data: { summary: agent.dmSummary || null } };
  }

  // ---------------------------------------------------------------------------
  // PUT /api/v2/agents/:id/dm/summary — direct edit DM summary
  // ---------------------------------------------------------------------------

  async updateSummary({ params, body }) {
    let agentId   = params.id;
    let { Agent } = this.getCoreModels();

    let agent = await Agent.where.id.EQ(agentId).first();
    if (!agent)
      this.throwNotFoundError('Agent not found');

    let summary = (body && body.summary !== undefined) ? body.summary : null;
    agent.dmSummary = summary;
    await agent.save();

    return { data: { summary: agent.dmSummary } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/agents/:id/dm/summarize — trigger manual re-summarization
  // ---------------------------------------------------------------------------

  async summarize({ params }) {
    let agentId   = params.id;
    let core      = this.getCore();
    let { Agent } = this.getCoreModels();

    let agent = await Agent.where.id.EQ(agentId).first();
    if (!agent)
      this.throwNotFoundError('Agent not found');

    // Find DM session
    let { Session } = this.getCoreModels();
    let dmSession   = await Session.where
      .type.EQ('dm')
      .dmAgentID.EQ(agentId)
      .organizationID.EQ(agent.organizationID)
      .first();

    if (!dmSession)
      this.throwNotFoundError('No DM session found for this agent');

    // Get agent plugin
    let AgentClass = core.getAgentType(agent.pluginID);
    if (!AgentClass)
      this.throwBadRequestError(`No agent plugin registered for: ${agent.pluginID}`);

    let agentPlugin = new AgentClass(core.getContext());

    // Run summarization
    let summarizer = new DmSummarizer(core.getContext());
    let resolvedAgent = agent.toJSON ? agent.toJSON() : { ...agent };
    let summary    = await summarizer.summarize(agentPlugin, resolvedAgent, dmSession.id);

    return { data: { summary } };
  }
}
