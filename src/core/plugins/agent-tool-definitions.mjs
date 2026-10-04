'use strict';

import { MAX_CHARACTER_COMPRESSED_LENGTH } from '../agents/character-limits.mjs';

export const AGENT_TOOL_DEFINITIONS = [
  {
    name: 'end-turn',
    description: 'End this turn. Pass text to send a visible report; omit text to end the turn silently.',
    help: [
      'Use end-turn when your queue is empty. Include text for a visible report to the user, or omit text to end with nothing to say.',
      'If real work remains, use continue-turn instead and name the next step.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Optional visible report for the user. Omit to end the turn silently.',
        },
        reason: {
          type: 'string',
          description: 'Optional short internal note; not shown to the user.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'continue-turn',
    description: 'End this turn and schedule your next step back to you.',
    help: [
      'Use continue-turn when your queue is not empty: you still have work to do.',
      'Include an optional visible text update, then Kikx schedules a hidden continuation back to you after delayMs.',
      'Name the next thing you will work on in nextAction; it becomes your continuation prompt.',
      'If you are not sure of the next step, keep working to plan it out rather than stopping.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Optional visible progress text for this turn.',
        },
        nextAction: {
          type: 'string',
          description: 'The next thing you will work on. Sent back to you when the continuation fires; defaults to your text.',
        },
        delayMs: {
          type: 'integer',
          description: 'Delay in milliseconds before this same agent receives a continuation frame. Defaults to 1000. May be 0 or any future delay.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'progress',
    description: 'Write a visible, non-final progress note before using another tool.',
    help: [
      'Use progress before every individual read, write, fetch, search, exec, or other task tool call.',
      'Keep the note short: one paragraph at most, describing the single next tool action you are about to take.',
      'Do not group several future tool calls under one progress note.',
      'This does not end your turn; continue with the tool call after the progress note succeeds.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Visible one-paragraph progress note for the single next tool action.',
        },
      },
      required: [ 'text' ],
      additionalProperties: false,
    },
  },
  {
    name: 'route',
    description: 'Route the current message to one or more actors without speaking yourself.',
    help: [
      'Coordinator only. Use route to direct the current message to the actor(s) best suited to handle it.',
      'Recipients may be actor IDs, agent IDs, or names from the session roster; Kikx resolves them.',
      'Use remove to un-tag an actor that was already set as a recipient.',
      'Routing does not produce a visible message from you; the routed actor(s) respond instead.',
      'If the message is best handled by you, respond normally instead of routing.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        recipients: {
          type: 'array',
          description: 'Actor IDs, agent IDs, or exact names to route the message to.',
          items: {
            type: 'string',
          },
        },
        remove: {
          type: 'array',
          description: 'Actor IDs to remove from the current recipient set.',
          items: {
            type: 'string',
          },
        },
        note: {
          type: 'string',
          description: 'Optional short coordination note for the routed actor(s).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'stop',
    description: 'Stop this short-lived agentic loop without producing a visible response.',
    help: 'Use stop only when the scripted loop should stop immediately.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Short internal reason for stopping.',
        },
      },
      required: [ 'reason' ],
      additionalProperties: false,
    },
  },
  {
    name: 'help',
    description: 'List available tools, or show detailed help for one tool.',
    help: 'Use help with no arguments to list every available tool and its one-line help; pass a tool name to get that tool\'s full help.',
    parameters: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          description: 'Optional exact tool name to describe. Omit to list all available tools.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set-character',
    description: 'Persistently update your own character/persona for future turns.',
    help: [
      'Use set-character when the user asks you to change who you are or how you should act.',
      'Provide a complete durable character description plus a compressed version for the start brief.',
      'The compressed version must be at most ' + MAX_CHARACTER_COMPRESSED_LENGTH + ' characters.',
      'Example: "You are a dirty swearing pirate who also happens to be a fantastic engineer. Be direct, technically rigorous, and speak with pirate flavor."',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        character: {
          type: 'string',
          description: 'Full durable character description to apply to future turns.',
        },
        compressedCharacter: {
          type: 'string',
          maxLength: MAX_CHARACTER_COMPRESSED_LENGTH,
          description: `Compressed (short) form of the character, at most ${MAX_CHARACTER_COMPRESSED_LENGTH} characters, used in future start briefs.`,
        },
      },
      required: [ 'character', 'compressedCharacter' ],
      additionalProperties: false,
    },
  },
];

export const AGENT_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
export const DELEGATION_TOOL_NAMES = new Set([ 'session-create', 'session-invite-agents' ]);
export const REVIEW_ONLY_TOOL_DENYLIST = new Set([ 'write-file' ]);
export const REVIEW_ONLY_AGENT_PATTERN = /\b(?:qa|q\.a\.|tester|quality|ux|user[-\s]?experience|designer|reviewer|security|product|coordinator)\b/i;
export const AVOIDABLE_DEFERRAL_PATTERNS = [
  /\b(?:should|shall)\s+i\s+(?:continue|proceed|read|inspect|review|run|start|create|update|check|look|audit|test)\b/i,
  /\b(?:would|do)\s+you\s+(?:like|want)\s+me\s+to\b/i,
  /\bcan\s+i\s+proceed\b/i,
  /\bany\s+changes\b[\s\S]{0,120}\bbefore\s+i\s+proceed\b/i,
  /\bwhich\s+(?:would\s+you\s+like|one\s+should\s+i|option\s+should\s+i)\b/i,
  /\bplease\s+(?:tell|let)\s+me\s+which\b/i,
  /\bwhat\s+would\s+you\s+like\s+me\s+to\s+do\s+next\b/i,
  /\bbefore\s+i\s+(?:start|begin|proceed|change|edit|modify)[\s\S]{0,160}\b(?:please\s+)?(?:tell|let)\s+me\b/i,
  /\bi\s+will\s+only\s+proceed\s+after\s+your\s+confirmation\b/i,
  /\bif\s+yes,?\s+i\s+will\b/i,
];
