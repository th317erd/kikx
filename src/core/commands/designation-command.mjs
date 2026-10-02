'use strict';

import { resolveService } from '../runtime/frame-runtime-normalize.mjs';

// Shared machinery for the per-session bot-designation slash commands
// (compaction P2, ruling R8):
//
//   /set-coordinator-bot <agent>   /clear-coordinator-bot
//   /set-compaction-bot <agent>    /clear-compaction-bot
//
// The four concrete commands are thin subclasses that declare which session
// field they own (`static field`), their exact usage string and a human label.
// Argless `set-*` returns usage and mutates nothing; clearing is only ever done
// by an explicit `clear-*` command. A `set-*` target must be a current session
// participant — `FrameRuntime.updateSession` enforces this too, but the command
// checks first so it can list the current participants in the error.

export class SetDesignationCommand {
  static field = null;
  static label = '';
  static usage = '';

  constructor(context = {}) {
    this.context = context;
  }

  async execute({ args, frame, session, services }) {
    let usage = this.constructor.usage;
    let argument = typeof args === 'string' ? args.trim() : '';
    if (argument === '')
      return { status: 'error', message: `Usage: ${usage}` };

    let agentManager = resolveService(services, 'agentManager');
    if (!agentManager)
      throw new Error(`${commandName(usage)} requires an agent manager`);

    let frameRuntime = resolveService(services, 'frameRuntime');
    if (!frameRuntime)
      throw new Error(`${commandName(usage)} requires a frame runtime`);

    let reference = unquote(argument);
    let agent = await agentManager.resolveAgent(reference);
    if (!agent?.id) {
      let error = new Error(`Agent not found: ${reference}`);
      error.status = 404;
      throw error;
    }

    let currentSession = resolveCurrentSession({ session, frameRuntime, frame });
    let participantAgentIDs = normalizeParticipants(currentSession);
    if (!participantAgentIDs.includes(agent.id)) {
      let error = new Error(
        `${this.constructor.label} must be a session participant: ${reference}. Current participants: ${formatParticipants(participantAgentIDs)}.`,
      );
      error.status = 400;
      throw error;
    }

    let input = {};
    input[this.constructor.field] = agent.id;
    await frameRuntime.updateSession(frame.sessionID, input);

    return {
      status: 'ok',
      message: `${this.constructor.label} set to ${agent.name || agent.id}.`,
      data: {
        sessionID: frame.sessionID,
        agentID: agent.id,
        agentName: agent.name || agent.id,
      },
    };
  }
}

export class ClearDesignationCommand {
  static field = null;
  static label = '';
  static usage = '';

  constructor(context = {}) {
    this.context = context;
  }

  async execute({ frame, session, services }) {
    let frameRuntime = resolveService(services, 'frameRuntime');
    if (!frameRuntime)
      throw new Error(`${commandName(this.constructor.usage)} requires a frame runtime`);

    let currentSession = resolveCurrentSession({ session, frameRuntime, frame });
    let previousAgentID = normalizeString(currentSession?.[this.constructor.field]);

    let input = {};
    input[this.constructor.field] = null;
    await frameRuntime.updateSession(frame.sessionID, input);

    return {
      status: 'ok',
      message: previousAgentID
        ? `${this.constructor.label} cleared.`
        : `No ${this.constructor.label.toLowerCase()} was set.`,
      data: {
        sessionID: frame.sessionID,
        previousAgentID,
      },
    };
  }
}

export function resolveCurrentSession({ session, frameRuntime, frame }) {
  if (session?.id && Array.isArray(session.participantAgentIDs))
    return session;

  let loaded = frameRuntime?.getSession?.(frame.sessionID);
  return loaded || session || null;
}

export function normalizeParticipants(session) {
  let values = Array.isArray(session?.participantAgentIDs) ? session.participantAgentIDs : [];
  let participants = [];
  for (let value of values) {
    if (typeof value !== 'string' || value.trim() === '')
      continue;

    let item = value.trim();
    if (!participants.includes(item))
      participants.push(item);
  }

  return participants;
}

export function formatParticipants(participantAgentIDs) {
  return participantAgentIDs.length > 0 ? participantAgentIDs.join(', ') : 'none';
}

export function unquote(reference) {
  let quote = reference[0];
  if ((quote === '"' || quote === "'") && reference.at(-1) === quote)
    return reference.slice(1, -1).replaceAll(`\\${quote}`, quote).replaceAll('\\\\', '\\').trim();

  if (quote === '"' || quote === "'")
    throw new Error(`Malformed quoted reference: ${reference}`);

  return reference;
}

function commandName(usage) {
  let match = String(usage || '').match(/^\/\S+/);
  return match ? match[0] : 'this command';
}

function normalizeString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
