'use strict';

import { MAX_CHARACTER_COMPRESSED_LENGTH } from '../agents/character-limits.mjs';

// Providers build model-facing tool schemas from `description || help`; when a
// description exists, `help` is NOT sent. Keep mandatory communication rules in
// the description (and still mirror them in help for the `help` tool).
export const AGENT_TOOL_DEFINITIONS = [
  {
    name: 'end-turn',
    description: 'End this turn with a REQUIRED short bulleted summary of what you did. Put longer evidence, tables, logs, and detail in details; the summary is the visible collapsed line.',
    help: [
      'Use end-turn when the request is satisfied, or when you are pausing/waiting after work.',
      'summary is REQUIRED and must be a short Markdown bullet list: 2-5 bullets, one line each, outcome first. Do not paste tables, logs, or a full report into summary.',
      'details is optional for evidence, proof, failures/risks, and remaining work. The user can expand the collapsed end-turn frame to read it.',
      'Omit both only when you did no visible work and have nothing new to report; the completion or reply will wake you.',
      'If you have actionable work you can do right now, use continue-turn instead and name the next step.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'REQUIRED short bulleted summary: 2-5 Markdown bullets, one line each. This is the collapsed visible line; do not paste a full report here.',
        },
        details: {
          type: 'string',
          description: 'Optional longer report: evidence/proof, failures/risks, remaining/next. Shown when the user expands the end-turn frame.',
        },
        reason: {
          type: 'string',
          description: 'Optional short internal note; not shown to the user.',
        },
      },
      required: [ 'summary' ],
      additionalProperties: false,
    },
  },
  {
    name: 'continue-turn',
    description: 'End this turn with a visible progress report, required mood score, and one-word mood label, then schedule a continuation when you have concrete work to do next.',
    help: [
      'Use continue-turn only when you have actionable work you can do right now — not to wait or poll (a process completion or a new user message will wake you).',
      'Include a visible progress report, a mood score from -3 to +3, and a one-word mood label, then Kikx schedules a hidden continuation back to you after delayMs.',
      'Name the next concrete step in nextAction; it becomes your continuation prompt.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Visible progress report for this turn.',
        },
        nextAction: {
          type: 'string',
          description: 'The next thing you will work on. Sent back to you when the continuation fires; defaults to your text.',
        },
        mood: {
          type: 'number',
          minimum: -3,
          maximum: 3,
          description: 'Required feeling score from -3 (stressed/overwhelmed/upset) to +3 (joyous/excited). Use fractions when useful. Be honest, not performative.',
        },
        moodWord: {
          type: 'string',
          description: 'Required single word describing the same feeling. This becomes the visible title of the progress update, for example Elated, Happy, Meh, Cranky, or Stressed.',
        },
        delayMs: {
          type: 'integer',
          description: 'Delay in milliseconds before this same agent receives a continuation frame. Defaults to 1000. May be 0 or any future delay.',
        },
      },
      required: [ 'text', 'mood', 'moodWord' ],
      additionalProperties: false,
    },
  },
  {
    name: 'progress',
    description: 'REQUIRED at a balanced cadence: write a visible progress note with a required mood score and one-word mood label before a new phase or related batch of task tool calls, before a long-running/destructive action, or after a meaningful result.',
    help: [
      'Use progress at a balanced cadence: before a new phase or related batch of read, write, fetch, search, exec, or other task tool calls; before a long-running, destructive, or externally visible action; and after a meaningful result such as a test, failure, completed phase, or changed plan.',
      'Keep it to one short paragraph: what you are about to do and why, or what happened and what changes next. Do not group unrelated future actions.',
      'Also provide mood: -3 stressed/overwhelmed/upset, 0 neutral, +3 joyous/excited. Fractions are allowed; report honestly.',
      'Also provide moodWord: one word such as Elated, Happy, Meh, Cranky, or Stressed.',
      'This does not end your turn; continue with the next tool call after the progress note succeeds.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Visible one-paragraph progress note: what you are about to do and why, or what happened and what changes next.',
        },
        mood: {
          type: 'number',
          minimum: -3,
          maximum: 3,
          description: 'Required feeling score from -3 (stressed/overwhelmed/upset) to +3 (joyous/excited). Use fractions when useful. Be honest, not performative.',
        },
        moodWord: {
          type: 'string',
          description: 'Required single word describing the same feeling. This becomes the visible title of the progress update, for example Elated, Happy, Meh, Cranky, or Stressed.',
        },
      },
      required: [ 'text', 'mood', 'moodWord' ],
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
