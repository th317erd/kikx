'use strict';

import { parseShellCommands }  from '../internal-plugins/shell/command-parser.mjs';
import { Permissions }         from '../permissions/permissions-base.mjs';
import { ShellPermissions }    from '../internal-plugins/shell/shell-permissions.mjs';

// =============================================================================
// Agent Resolver
// =============================================================================
// Factored out of InteractionController: resolves an agent record into the
// data needed to start an interaction (plugin instance, resolved agent record,
// permission/tool callbacks).
//
// Accepts injectable `resolveContext` for HTTP-specific concerns (UMK for key
// decryption, userID for permissions).
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
  //   userID         — authenticated user ID
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

    // Preserve behaviors/config convenience methods for PrimerAssembler
    // and post-truncation re-injection (same as InteractionController does)
    if (typeof agent.hasBehaviors === 'function') {
      resolvedAgent.hasBehaviors = () => agent.hasBehaviors();
      resolvedAgent.getBehaviors = () => agent.getBehaviors();
      resolvedAgent.getConfig    = () => agent.getConfig();
    }

    // Decrypt API key if encrypted and context provides keys
    if (agent.encryptedAPIKey && resolveContext.keystore && resolveContext.umk && resolveContext.userID) {
      try {
        let userKey   = resolveContext.keystore.deriveUserKey(resolveContext.umk, resolveContext.userID);
        let encrypted = JSON.parse(agent.encryptedAPIKey);

        resolvedAgent.apiKey = resolveContext.keystore.decrypt(encrypted, userKey).toString('utf8');
      } catch (_error) {
        throw new Error(`Failed to decrypt API key for agent: ${agentID}`);
      }
    }

    return { agentPlugin, resolvedAgent };
  }

  // ---------------------------------------------------------------------------
  // buildCallbacks
  // ---------------------------------------------------------------------------
  // Constructs checkPermission and executeTool callbacks for an agent, usable
  // outside of HTTP context (e.g., SchedulerOrchestrator triggering secondary
  // agents). Mirrors the callback logic in InteractionController.sendMessage().
  //
  // Returns: { checkPermission, executeTool }
  // ---------------------------------------------------------------------------

  buildCallbacks(resolvedAgent, sessionID) {
    let core            = this._core;
    let pluginRegistry  = core.getPluginRegistry();
    let interactionLoop = core.getContext().getProperty('interactionLoop');
    let context         = core.getContext();

    let checkPermission = async (featureName, toolArgs) => {
      if (featureName === 'system:command' && toolArgs && toolArgs.command)
        featureName = `command:${toolArgs.command.toLowerCase().trim()}`;

      if (featureName.startsWith('command:') && toolArgs && toolArgs.authorType === 'user')
        return false;

      let permissionOptions = {
        organizationID: resolvedAgent.organizationID,
        scope:          'session',
        scopeID:        sessionID,
        agent:          resolvedAgent,
      };

      // Per-command permission evaluation for shell:execute
      if (featureName === 'shell:execute' && toolArgs && toolArgs.command) {
        let parsed = parseShellCommands(toolArgs.command);

        if (parsed.length > 0) {
          let ShellToolClass = pluginRegistry.getTool('shell:execute');
          let shellOptions   = { ...permissionOptions, toolClass: ShellToolClass };
          let shellPerms     = new ShellPermissions(context);

          let anyNeedsApproval = false;
          let commandStatuses  = [];

          for (let cmd of parsed) {
            let perCommandFeature = `shell:${cmd.command}`;
            let status            = 'needs-approval';

            try {
              let needsPermission = await shellPerms.evaluate(perCommandFeature, cmd, shellOptions);

              if (!needsPermission)
                status = 'allowed';
              else
                anyNeedsApproval = true;
            } catch (permError) {
              if (permError.name === 'PermissionDeniedError')
                throw permError;

              throw permError;
            }

            commandStatuses.push({ command: cmd.command, arguments: cmd.arguments, status });
          }

          toolArgs._parsedCommands = commandStatuses;

          if (!anyNeedsApproval)
            return false;

          return true;
        }
      }

      let ToolClass   = pluginRegistry.getTool(featureName);
      let PermClass   = null;

      // Discover the PermissionsClass from the tool if available
      if (ToolClass) {
        let tempInstance = new ToolClass(context);
        PermClass = (typeof tempInstance.getPermissionsClass === 'function')
          ? tempInstance.getPermissionsClass()
          : null;
      }

      let permissions = new (PermClass || Permissions)(context);

      // Check custom checkPermission first
      let customResult = await permissions.checkPermission(
        featureName, toolArgs, { ...permissionOptions, toolClass: ToolClass },
      );

      if (customResult === false)
        return false;

      if (customResult === true)
        return true;

      // Defer to evaluate()
      return permissions.evaluate(
        featureName, toolArgs, { ...permissionOptions, toolClass: ToolClass },
      );
    };

    let executeTool = async (toolName, toolArgs) => {
      let ToolClass = pluginRegistry.getTool(toolName);
      if (!ToolClass)
        throw new Error(`Unknown tool: ${toolName}`);

      let toolInstance = new ToolClass(core.getContext());

      // Always augment with _sessionID and _agent so that
      // PluginInterface._permissionOptions() can locate session-scoped
      // permission rules (e.g., one-time allow rules from approval flow).
      // Activity frame for live tool status — tool calls _commitActivity(html)
      // to create/update a visible ToolActivity frame. Silent commits so the
      // FrameRouter doesn't trigger. Client receives via SSE and renders.
      let activityFrameID = null;

      let _commitActivity = async (html) => {
        let interactionLoopRef = core.getContext().getProperty('interactionLoop');
        let framePersistence   = core.getContext().getProperty('framePersistence');
        let sessionManager     = core.getContext().getProperty('sessionManager');

        if (!interactionLoopRef || !framePersistence || !sessionManager)
          return;

        let fm = sessionManager.getFrameManager(sessionID);
        if (!fm)
          return;

        if (!activityFrameID) {
          // Create new activity frame
          let XID = (await import('xid-js')).default;
          activityFrameID = `frm_${XID.next()}`;

          let frameData = {
            id:            activityFrameID,
            type:          'ToolActivity',
            content:       { toolName, html },
            timestamp:     Date.now(),
            authorType:    'system',
            hidden:        false,
            deleted:       false,
            processed:     false,
          };

          fm.merge([frameData], { silent: false });
          await framePersistence.saveFrames(sessionID, [frameData]);
        } else {
          // Update existing activity frame
          fm.merge([{
            id:      activityFrameID,
            type:    'ToolActivity',
            content: { toolName, html },
          }], { silent: true });

          // Persist the update
          try {
            // Update activity frame through FrameManager (silent — UI-only update)
            fm.merge([{
              id:      activityFrameID,
              type:    'ToolActivity',
              content: { toolName, html },
            }], { silent: true });

            let framePersistenceRef = core.getContext().getProperty('framePersistence');
            if (framePersistenceRef)
              await framePersistenceRef.saveFrames(sessionID, [{ id: activityFrameID, type: 'ToolActivity', content: { toolName, html } }]);
          } catch (_e) {
            // Best-effort
          }
        }
      };

      let augmentedArgs = {
        ...toolArgs,
        _sessionID: sessionID,
        _agent:     resolvedAgent,
        _commitActivity,
      };

      let result = await toolInstance.execute(augmentedArgs);

      // system:command may request a primer refresh after execution
      if (toolName === 'system:command' && result && result.injectPrimer && interactionLoop)
        interactionLoop.requestPrimerRefresh(sessionID);

      return result;
    };

    return { checkPermission, executeTool };
  }
}
