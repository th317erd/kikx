'use strict';

// =============================================================================
// InteractionController — sendMessage, cancel, approve, deny
// =============================================================================

import { ControllerAuthBase }   from './controller-auth-base.mjs';
import { parseShellCommands }   from '../../core/internal-plugins/shell/command-parser.mjs';

export class InteractionController extends ControllerAuthBase {
  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions/:sessionId/interact
  // ---------------------------------------------------------------------------

  async sendMessage({ params, body }) {
    let { message, agentId } = body || {};

    if (!message)
      this.throwBadRequestError('message is required');

    if (!agentId)
      this.throwBadRequestError('agentId is required');

    let { Agent }       = this.getCoreModels();
    let core            = this.getCore();
    let keystore        = this.getKeystore();
    let interactionLoop = this.getInteractionLoop();

    // Look up agent
    let agent = await Agent.where.id.EQ(agentId).first();
    if (!agent)
      this.throwNotFoundError('Agent not found');

    // Get agent plugin class and instantiate
    let AgentClass = core.getAgentType(agent.pluginID);
    if (!AgentClass)
      this.throwBadRequestError(`No agent plugin registered for: ${agent.pluginID}`);

    let agentPlugin = new AgentClass(core.getContext());

    // Resolve API key if encrypted
    let resolvedAgent = { ...agent.toJSON ? agent.toJSON() : agent };
    if (agent.encryptedAPIKey) {
      try {
        let umk       = this.request.getUMK();
        let userKey   = keystore.deriveUserKey(umk, this.request.userId);
        let encrypted = JSON.parse(agent.encryptedAPIKey);

        resolvedAgent.apiKey = keystore.decrypt(encrypted, userKey).toString('utf8');
      } catch (_error) {
        this.throwBadRequestError('Failed to decrypt agent API key');
      }
    }

    // Build permission + tool execution callbacks
    let permissionEngine = core.getPermissionEngine();
    let pluginRegistry   = core.getPluginRegistry();

    let checkPermission = async (featureName, toolArgs) => {
      // Translate system:command tool calls to per-command feature names
      if (featureName === 'system:command' && toolArgs && toolArgs.command)
        featureName = `command:${toolArgs.command.toLowerCase().trim()}`;

      // For now: authenticated users are always permitted for commands
      if (featureName.startsWith('command:') && toolArgs && toolArgs.authorType === 'user')
        return false; // allowed

      if (!permissionEngine)
        return true; // No engine = needs approval

      // Per-command permission evaluation for shell:execute
      if (featureName === 'shell:execute' && toolArgs && toolArgs.command) {
        let parsed = parseShellCommands(toolArgs.command);

        if (parsed.length > 0) {
          let permissionOptions = {
            organizationID: agent.organizationID,
            scope:          'session',
            scopeID:        params.sessionId,
          };

          let anyNeedsApproval = false;
          let commandStatuses  = [];

          for (let cmd of parsed) {
            let perCommandFeature = `shell:${cmd.command}`;
            let status            = 'needs-approval';

            try {
              let needsPermission = await permissionEngine.checkPermission(perCommandFeature, cmd, permissionOptions);

              if (!needsPermission)
                status = 'allowed';
              else
                anyNeedsApproval = true;
            } catch (permError) {
              if (permError.name === 'PermissionDeniedError')
                throw permError; // Deny-forever rule — block entire pipeline

              throw permError;
            }

            commandStatuses.push({ command: cmd.command, arguments: cmd.arguments, status });
          }

          // Attach parsed commands with statuses for frame enrichment
          toolArgs._parsedCommands = commandStatuses;

          // If all commands are allowed, no approval needed
          if (!anyNeedsApproval)
            return false;

          return true;
        }
      }

      let ToolClass = pluginRegistry.getTool(featureName);

      return permissionEngine.checkPermission(featureName, toolArgs, {
        organizationID: agent.organizationID,
        scope:          'session',
        scopeID:        params.sessionId,
        toolClass:      ToolClass,
      });
    };

    let executeTool = async (toolName, toolArgs) => {
      let ToolClass = pluginRegistry.getTool(toolName);
      if (!ToolClass)
        throw new Error(`Unknown tool: ${toolName}`);

      let toolInstance = new ToolClass(core.getContext());

      // Inject session context for system:command
      if (toolName === 'system:command') {
        let augmentedArgs = {
          ...toolArgs,
          _sessionID: params.sessionId,
          _authorID:  this.request.userId,
          _agent:     resolvedAgent,
        };

        let result = await toolInstance.execute(augmentedArgs);

        if (result && result.injectPrimer)
          interactionLoop.requestPrimerRefresh(params.sessionId);

        return result;
      }

      return toolInstance.execute(toolArgs);
    };

    // Start interaction (non-blocking — frames emitted via SSE)
    let interactionID = await interactionLoop.startInteraction(params.sessionId, {
      agentPlugin,
      agent:       resolvedAgent,
      userMessage: message,
      authorType:  'user',
      authorID:    this.request.userId,
      checkPermission,
      executeTool,
    });

    this.setStatusCode(202);

    return { data: { interactionID } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions/:sessionId/interact/cancel
  // ---------------------------------------------------------------------------

  async cancel({ params }) {
    let interactionLoop = this.getInteractionLoop();
    let queued          = await interactionLoop.cancelInteraction(params.sessionId);

    return { data: { cancelled: true, queuedMessages: queued } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions/:sessionId/interact/approve/:frameId
  // ---------------------------------------------------------------------------
  // Unified approve/deny endpoint. Accepts optional { decisions } body:
  //   decisions: [{ command: 'ls', decision: 'allow-forever' }, ...]
  //
  // Decision values: 'allow-once', 'allow-forever', 'deny-once', 'deny-forever'
  //
  // If any decision is deny-once or deny-forever → denyPermission()
  // Otherwise → approvePermission() (existing flow)
  // Forever decisions create session-scoped permission rules.
  // No body / empty decisions → approve-all (backward compat)
  // ---------------------------------------------------------------------------

  async approve({ params, body }) {
    let interactionLoop  = this.getInteractionLoop();
    let decisions        = (body && Array.isArray(body.decisions)) ? body.decisions : [];
    let hasDeny          = decisions.some((d) => d.decision === 'deny-once' || d.decision === 'deny-forever');

    // Create persistent rules for "forever" decisions
    if (decisions.length > 0) {
      let core             = this.getCore();
      let permissionEngine = core.getPermissionEngine();

      if (permissionEngine) {
        let { Agent } = this.getCoreModels();

        // Resolve organizationID — look up from permission-waiting state or agent
        let organizationID = null;

        // Try to get from waiting state's agent params
        let waiting = interactionLoop._permissionWaiting.get(params.sessionId);
        if (waiting && waiting.params && waiting.params.agent)
          organizationID = waiting.params.agent.organizationID;

        for (let decision of decisions) {
          if (!decision.command || !decision.decision)
            continue;

          let effect = null;
          if (decision.decision === 'allow-forever')
            effect = 'allow';
          else if (decision.decision === 'deny-forever')
            effect = 'deny';

          if (!effect)
            continue; // allow-once / deny-once create no rules

          await permissionEngine.createRule({
            organizationID,
            featureName: `shell:${decision.command}`,
            effect,
            scope:       'session',
            scopeID:     params.sessionId,
            createdBy:   this.request.userId,
          });
        }
      }
    }

    if (hasDeny) {
      await interactionLoop.denyPermission(params.sessionId, params.frameId);

      return { data: { denied: true } };
    }

    let interactionID = await interactionLoop.approvePermission(
      params.sessionId,
      params.frameId,
    );

    return { data: { approved: true, interactionID } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions/:sessionId/interact/deny/:frameId
  // ---------------------------------------------------------------------------

  async deny({ params }) {
    let interactionLoop = this.getInteractionLoop();

    await interactionLoop.denyPermission(
      params.sessionId,
      params.frameId,
    );

    return { data: { denied: true } };
  }
}
