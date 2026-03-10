'use strict';

import XID from 'xid-js';

// =============================================================================
// CommandHandler
// =============================================================================
// Handles slash-command dispatch for the InteractionLoop:
//   - Parse messages for /command syntax
//   - Resolve command handlers from plugin registry
//   - Execute commands with permission checks
//
// Extracted from InteractionLoop to reduce file size.
// =============================================================================

function generateID(prefix) {
  return `${prefix}${XID.next()}`;
}

export class CommandHandler {
  constructor(loop) {
    this._loop = loop;
  }

  // ---------------------------------------------------------------------------
  // parse — check if message is a /command
  // ---------------------------------------------------------------------------

  parse(message) {
    if (!message || typeof message !== 'string')
      return null;

    let match = message.match(/^\s*\/([\w_-]+)(.*)$/);
    if (!match)
      return null;

    return {
      commandName: match[1].toLowerCase(),
      arguments:   (match[2] || '').trim(),
    };
  }

  // ---------------------------------------------------------------------------
  // resolve — look up command handler from plugin registry
  // ---------------------------------------------------------------------------

  resolve(commandName) {
    let registry = this._loop._context.getProperty('pluginRegistry');
    if (!registry)
      return null;

    // Traditional commands take precedence
    let handler = registry.getCommand(commandName);
    if (handler)
      return handler;

    // Fall back to capabilities with matching slash command
    let capability = registry.getCapabilityBySlashCommand(commandName);
    if (capability) {
      // Return a wrapper function with __capability attached so execute() can detect it
      let wrapper = () => {};
      wrapper.__capability = capability;

      return wrapper;
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // execute — run a slash command
  // ---------------------------------------------------------------------------

  async execute(sessionID, params, commandMatch) {
    let loop            = this._loop;
    let framePersistence = loop._getFramePersistence();
    let interactionID    = generateID('int_');
    let order            = await framePersistence.getNextOrder(sessionID);

    loop.emit('interaction:start', { sessionID, interactionID });

    // Create user-message frame so the command shows in chat history.
    // Hidden: command inputs are visible in the UI but excluded from
    // the agent's message history (the agent should never see "/reload" etc.)
    let userFrame = {
      id:            generateID('frm_'),
      type:          'user-message',
      content:       { text: params.userMessage },
      order:         order++,
      timestamp:     Date.now(),
      interactionID,
      authorType:    params.authorType || 'user',
      authorID:      params.authorID || null,
      hidden:        true,
      deleted:       false,
      processed:     false,
    };

    await framePersistence.saveFrames(sessionID, [userFrame]);
    loop.emit('frame', { sessionID, frame: userFrame });

    // Resolve the command handler
    let handler = this.resolve(commandMatch.commandName);

    let resultContent;
    let resultFlags = {};

    // Check command permission if callback is available
    if (handler && typeof params.checkPermission === 'function') {
      let featureName = `command:${commandMatch.commandName}`;

      try {
        let needsPermission = await params.checkPermission(featureName, {
          command:    commandMatch.commandName,
          args:       commandMatch.arguments,
          authorType: params.authorType || 'user',
        });

        if (needsPermission) {
          // Permission hard-break for commands
          let requestFrame = {
            id:            generateID('frm_'),
            type:          'permission-request',
            content:       { commandName: commandMatch.commandName, arguments: commandMatch.arguments, featureName },
            order:         order++,
            timestamp:     Date.now(),
            interactionID,
            authorType:    'system',
            authorID:      null,
            hidden:        false,
            deleted:       false,
            processed:     false,
          };

          await framePersistence.saveFrames(sessionID, [requestFrame]);
          loop.emit('frame', { sessionID, frame: requestFrame });
          loop.emit('permission:request', { sessionID, frameID: requestFrame.id, commandName: commandMatch.commandName });
          loop.emit('interaction:end', { sessionID, interactionID });

          return interactionID;
        }
      } catch (permError) {
        if (permError.name === 'PermissionDeniedError') {
          resultContent = { html: `<p>Permission denied: <code>/${commandMatch.commandName}</code></p>` };
          // Skip handler execution, fall through to create command-result frame
        } else {
          throw permError;
        }
      }
    }

    if (!resultContent) {
      if (!handler) {
        resultContent = { html: `<p>Unknown command: <code>/${commandMatch.commandName}</code></p>` };
      } else if (handler.__capability) {
        // Unified capability execution
        let capability = handler.__capability;

        try {
          let structuredParams;

          if (typeof capability.parseArgs === 'function') {
            structuredParams = capability.parseArgs(commandMatch.arguments);

            if (!structuredParams) {
              let usage = capability.schema
                ? `<p>Usage: <code>/${commandMatch.commandName}</code> — could not parse arguments.</p>`
                : `<p>Usage: <code>/${commandMatch.commandName}</code></p>`;
              resultContent = { html: usage };
            }
          } else {
            // No parseArgs — pass raw text as { text }
            structuredParams = { text: commandMatch.arguments };
          }

          if (!resultContent) {
            let result = await capability.handler({
              params:     structuredParams,
              sessionID,
              context:    loop._context,
              authorType: params.authorType || 'user',
              authorID:   params.authorID || null,
              agent:      params.agent,
            });

            resultContent = (result && result.content) || { html: '<p>Command executed.</p>' };
            resultFlags   = result || {};
          }
        } catch (error) {
          resultContent = { html: `<p>Command error: ${error.message}</p>` };
        }
      } else {
        try {
          let result = await handler({
            sessionID,
            arguments:  commandMatch.arguments,
            context:    loop._context,
            authorType: params.authorType || 'user',
            authorID:   params.authorID || null,
            agent:      params.agent,
          });

          resultContent = (result && result.content) || { html: '<p>Command executed.</p>' };
          resultFlags   = result || {};
        } catch (error) {
          resultContent = { html: `<p>Command error: ${error.message}</p>` };
        }
      }
    }

    // Create command-result frame
    let resultFrame = {
      id:            generateID('frm_'),
      type:          'command-result',
      content:       resultContent,
      order:         order++,
      timestamp:     Date.now(),
      interactionID,
      authorType:    'system',
      authorID:      null,
      hidden:        false,
      deleted:       false,
      processed:     false,
    };

    await framePersistence.saveFrames(sessionID, [resultFrame]);
    loop.emit('frame', { sessionID, frame: resultFrame });

    // Handle flags from command result
    if (resultFlags.injectPrimer)
      loop._primerNeeded.add(sessionID);

    loop.emit('interaction:end', { sessionID, interactionID });

    return interactionID;
  }
}
