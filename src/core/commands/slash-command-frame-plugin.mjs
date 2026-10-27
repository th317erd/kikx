'use strict';

import { BaseFramePlugin } from '../routing/index.mjs';
import { hasCoordinatorAuthority, resolveSessionCoordinator } from '../agents/coordinator-scope.mjs';

export class SlashCommandFramePlugin extends BaseFramePlugin {
  static pluginID = 'internal:slash-command-router';

  async process(next, done) {
    if (this.context.newFrame?.hidden === true) {
      await next(this.context);
      return;
    }

    let frame = this.context.newFrame;
    let parsed = parseSlashCommand(frame?.content?.text);
    if (!parsed) {
      await next(this.context);
      return;
    }

    // Bot-authored command frames reach here only because the plugin is also
    // registered for Type:AgentMessage. A bot may not simply type /halt: it must
    // hold coordinator authority over the session the command would act on.
    // Opening the parser without this gate would hand every bot a stop button.
    let isAgentAuthored = frame?.authorType === 'agent';
    if (isAgentAuthored) {
      let gate = checkAgentCommandAuthority({
        parsed,
        frame,
        context: this.context,
      });
      if (!gate.allowed) {
        this.appendCommandResult({
          command: parsed.name,
          status: 'error',
          text: gate.message,
        });
        done();
        return;
      }
    }

    let commandRegistry = this.context.services?.commandRegistry
      || this.context.services?.context?.require?.('commandRegistry');
    let descriptor = commandRegistry?.getCommand?.(parsed.name);

    if (!descriptor) {
      this.appendCommandResult({
        command: parsed.name,
        status: 'error',
        text: `Unknown command: /${parsed.name}`,
      });
      done();
      return;
    }

    try {
      let command = new descriptor.CommandClass(this.context);
      let result = await command.execute({
        command: descriptor.name,
        args: parsed.args,
        raw: parsed.raw,
        frame: this.context.newFrame,
        session: this.context.session,
        services: this.context.services,
      });

      if (result?.suppressCommandResult === true) {
        done();
        return;
      }

      this.appendCommandResult({
        command: descriptor.name,
        status: result?.status || 'ok',
        text: result?.message || `/${descriptor.name} handled`,
        data: result?.data || null,
      });
    } catch (error) {
      this.appendCommandResult({
        command: descriptor.name,
        status: 'error',
        text: error.message || `/${descriptor.name} failed`,
      });
    }

    done();
  }

  appendCommandResult({ command, status, text, data = null }) {
    let frame = this.context.newFrame;
    let now = this.context.services?.clock?.() || Date.now();

    this.context.engine.merge([{
      id: this.context.engine.idGenerator(),
      type: 'CommandResult',
      sessionID: frame.sessionID,
      interactionID: frame.interactionID,
      parentID: frame.id,
      authorType: 'system',
      authorID: 'internal:slash-command-router',
      timestamp: now,
      createdAt: now,
      updatedAt: now,
      hidden: false,
      deleted: false,
      content: {
        command,
        status,
        text,
        data,
      },
    }], {
      authorType: 'system',
      authorID: 'internal:slash-command-router',
    });
  }
}

// Commands a bot is allowed to issue, and the session each one acts on. A command
// not listed here is not available to bots at all: the default must stay closed,
// because this plugin now parses agent-authored frames for every command.
const AGENT_COMMANDS = new Set([ 'cancel', 'stop', 'suspend', 'halt' ]);

/**
 * Decide whether a bot may run `parsed` against `frame`. Read-only: it never
 * mutates the tree (promotion is deterministic, so a read-only authority check
 * agrees with what a persisting resolve would have decided).
 */
export function checkAgentCommandAuthority({ parsed, frame, context = {} }) {
  let name = String(parsed?.name || '').toLowerCase();
  if (!AGENT_COMMANDS.has(name)) {
    return {
      allowed: false,
      message: `/${name} is not available to bots. Human commands can only be run from the composer.`,
    };
  }

  let services = context.services || {};
  let frameRuntime = context.frameRuntime || services.frameRuntime;
  if (!frameRuntime?.getSession) {
    return { allowed: false, message: `/${name} requires a frame runtime to resolve session authority.` };
  }

  let actorAgentID = frame?.authorID || context.agent?.id || null;
  let currentSessionID = frame?.sessionID || context.session?.id || null;

  // A bare /halt means "my session". A named argument is a session or an agent,
  // resolved below by the command itself; authority is checked against the
  // session the command actually targets.
  let targetSessionID = resolveCommandTargetSession(parsed.args, currentSessionID, frameRuntime);

  let authority = hasCoordinatorAuthority({
    agentID: actorAgentID,
    targetSessionID,
    getSession: (id) => frameRuntime.getSession?.(id) || null,
  });

  if (authority.allowed)
    return { allowed: true, targetSessionID, authority };

  let owner = resolveSessionCoordinator({
    sessionID: targetSessionID,
    getSession: (id) => frameRuntime.getSession?.(id) || null,
  }).coordinatorAgentID;

  let hint = owner && owner !== actorAgentID ? ` Its coordinator is ${owner}.` : '';

  return {
    allowed: false,
    targetSessionID,
    authority,
    message: `/${name} refused for ${targetSessionID}: ${actorAgentID || 'this bot'} does not coordinate `
      + `that session or any of its ancestors.${hint} Coordinator authority flows down the session tree, `
      + 'so a bot may halt its own session and its descendants, never a parent or an unrelated branch.',
  };
}

/**
 * The session a command's argument names. An argument that matches a known
 * session id is a session; anything else (an agent name) leaves the command
 * acting on the caller's own session.
 */
function resolveCommandTargetSession(args, currentSessionID, frameRuntime) {
  let reference = typeof args === 'string' ? args.trim() : '';
  if (reference === '')
    return currentSessionID;

  // Strip quotes so /halt "my session id" works the same as /halt id.
  let unquoted = reference.replace(/^["']|["']$/g, '').trim();
  if (unquoted && frameRuntime.getSession?.(unquoted))
    return unquoted;

  return currentSessionID;
}

export function parseSlashCommand(text) {
  if (typeof text !== 'string')
    return null;

  let trimmed = text.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//'))
    return null;

  let match = trimmed.match(/^\/([A-Za-z][A-Za-z0-9:_-]*)(?:\s+([\s\S]*))?$/);
  if (!match)
    return null;

  return {
    name: match[1].toLowerCase(),
    args: (match[2] || '').trim(),
    raw: trimmed,
  };
}
