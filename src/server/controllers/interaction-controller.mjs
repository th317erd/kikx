'use strict';

// =============================================================================
// InteractionController — sendMessage, cancel, approve, deny
// =============================================================================

import { ControllerAuthBase }   from './controller-auth-base.mjs';
import { parseShellCommands }   from '../../core/internal-plugins/shell/command-parser.mjs';

export class InteractionController extends ControllerAuthBase {
  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions/:sessionID/interact
  // ---------------------------------------------------------------------------

  async sendMessage({ params, body }) {
    let { message, agentID, parentID, convertMarkdown } = body || {};

    if (!message)
      this.throwBadRequestError('message is required');

    let interactionLoop = this.getInteractionLoop();

    // When no agent is specified, just persist the message and broadcast.
    // This supports sessions with no agents, or users chatting to each other.
    if (!agentID) {
      let result = await interactionLoop.postMessage(params.sessionID, {
        text:       message,
        authorType: 'user',
        authorID:   this.request.userID,
        parentID,
        convertMarkdown,
      });

      this.setStatusCode(201);

      return { data: { interactionID: result.interactionID, frameID: result.frameID } };
    }

    let { Agent }       = this.getCoreModels();
    let core            = this.getCore();
    let keystore        = this.getKeystore();

    // Look up agent
    let agent = await Agent.where.id.EQ(agentID).first();
    if (!agent)
      this.throwNotFoundError('Agent not found');

    // Get agent plugin class and instantiate
    let AgentClass = core.getAgentType(agent.pluginID);
    if (!AgentClass)
      this.throwBadRequestError(`No agent plugin registered for: ${agent.pluginID}`);

    let agentPlugin = new AgentClass(core.getContext());

    // Resolve API key if encrypted
    let resolvedAgent = { ...agent.toJSON ? agent.toJSON() : agent };

    // Preserve abilities convenience methods for PrimerAssembler
    if (typeof agent.hasAbilities === 'function') {
      resolvedAgent.hasAbilities = () => agent.hasAbilities();
      resolvedAgent.getAbilities = () => agent.getAbilities();
      resolvedAgent.getConfig    = () => agent.getConfig();
    }

    if (agent.encryptedAPIKey) {
      try {
        let umk       = this.request.getUMK();
        let userKey   = keystore.deriveUserKey(umk, this.request.userID);
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
          // Look up ShellTool class so the engine can use ShellPermissions.matchesRule()
          let ShellToolClass  = pluginRegistry.getTool('shell:execute');
          let permissionOptions = {
            organizationID: agent.organizationID,
            scope:          'session',
            scopeID:        params.sessionID,
            toolClass:      ShellToolClass,
            agent:          resolvedAgent,
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

      // For capabilities, check if it exists for permission routing
      if (!ToolClass) {
        let capability = pluginRegistry.getCapability(featureName);
        if (capability && capability.riskLevel === 'low')
          return false; // Low-risk capabilities auto-allowed
      }

      return permissionEngine.checkPermission(featureName, toolArgs, {
        organizationID: agent.organizationID,
        scope:          'session',
        scopeID:        params.sessionID,
        toolClass:      ToolClass,
        agent:          resolvedAgent,
      });
    };

    let executeTool = async (toolName, toolArgs) => {
      let ToolClass = pluginRegistry.getTool(toolName);

      if (!ToolClass) {
        // Try capabilities before giving up
        let capability = pluginRegistry.getCapability(toolName);
        if (capability) {
          let result = await capability.handler({
            params:     toolArgs,
            sessionID:  params.sessionID,
            context:    core.getContext(),
            authorType: 'agent',
            authorID:   this.request.userID,
            agent:      resolvedAgent,
          });

          if (result && result.injectPrimer)
            interactionLoop.requestPrimerRefresh(params.sessionID);

          return (result && result.content) || result;
        }

        throw new Error(`Unknown tool: ${toolName}`);
      }

      let toolInstance = new ToolClass(core.getContext());

      // Inject session/agent context into all tool calls
      let augmentedArgs = {
        ...toolArgs,
        _sessionID: params.sessionID,
        _authorID:  this.request.userID,
        _agent:     resolvedAgent,
      };

      // Inject agentID for tools that need to identify the calling agent
      if (resolvedAgent && resolvedAgent.id)
        augmentedArgs.agentID = toolArgs.agentID || resolvedAgent.id;

      let result = await toolInstance.execute(augmentedArgs);

      if (result && result.injectPrimer)
        interactionLoop.requestPrimerRefresh(params.sessionID);

      return result;
    };

    // Stash resolve context on the scheduler so it can decrypt API keys
    // for re-triggered or secondary agents.
    let sessionManager   = this.getSessionManager();
    let sessionScheduler = this.getSessionScheduler();
    let participants     = await sessionManager.getParticipants(params.sessionID);
    let agentCount       = (participants && participants.length > 0) ? participants.length : 1;

    if (sessionScheduler) {
      let umk = this.request.getUMK();
      sessionScheduler.setResolveContext(params.sessionID, {
        keystore,
        umk,
        userID: this.request.userID,
      });

      // Mark the primary agent as active BEFORE starting the interaction,
      // so the scheduling plugin's onCommit skips it (prevents double-trigger).
      sessionScheduler.markActive(params.sessionID, agentID);
    }

    // Start interaction (non-blocking — frames emitted via SSE)
    let interactionID = await interactionLoop.startInteraction(params.sessionID, {
      agentPlugin,
      agent:       resolvedAgent,
      userMessage: message,
      authorType:  'user',
      authorID:    this.request.userID,
      agentCount,
      parentID,
      convertMarkdown,
      checkPermission,
      executeTool,
    });

    this.setStatusCode(202);

    return { data: { interactionID } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions/:sessionID/interact/cancel
  // ---------------------------------------------------------------------------

  async cancel({ params }) {
    let interactionLoop = this.getInteractionLoop();
    let queued          = await interactionLoop.cancelInteraction(params.sessionID);

    return { data: { cancelled: true, queuedMessages: queued } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions/:sessionID/interact/approve/:frameID
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

        // Try to get from waiting state's agent params (uses composite key lookup)
        let waiting = interactionLoop.getPermissionWaiting(params.sessionID);
        if (waiting && waiting.params && waiting.params.agent)
          organizationID = waiting.params.agent.organizationID;

        // Fallback: use the authenticated user's organization from JWT
        if (!organizationID)
          organizationID = this.request.organizationID;

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
            featureName: (decision.command.includes(':')) ? decision.command : `shell:${decision.command}`,
            effect,
            scope:       'session',
            scopeID:     params.sessionID,
            createdBy:   this.request.userID,
            metadata:    {
              command:   decision.command,
              arguments: decision.arguments || [],
            },
          });
        }
      }
    }

    if (hasDeny) {
      await interactionLoop.denyPermission(params.sessionID, params.frameID);

      return { data: { denied: true } };
    }

    let interactionID = await interactionLoop.approvePermission(
      params.sessionID,
      params.frameID,
    );

    return { data: { approved: true, interactionID } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v2/sessions/:sessionID/interact/deny/:frameID
  // ---------------------------------------------------------------------------

  async deny({ params }) {
    let interactionLoop = this.getInteractionLoop();

    await interactionLoop.denyPermission(
      params.sessionID,
      params.frameID,
    );

    return { data: { denied: true } };
  }
}
