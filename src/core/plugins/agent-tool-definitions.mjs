'use strict';

export const AGENT_TOOL_DEFINITIONS = [
  {
    name: 'agent-respond',
    description: 'Finalize this turn with a visible response from this agent after required work is complete.',
    help: 'Use agent-respond only after you have completed any needed tool work for this turn. Do not use it to announce future tool work.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Visible response text.',
        },
      },
      required: [ 'text' ],
      additionalProperties: false,
    },
  },
  {
    name: 'agent-respond-and-continue',
    description: 'Finalize this turn with a visible response, then schedule a delayed continuation back to this same agent.',
    help: [
      'Use agent-respond-and-continue when you need to tell the user or other agents what you did now, then resume your own work at a scheduled time.',
      'This is a boomerang: your visible response ends this turn, and Kikx will route a hidden continuation frame back to you after delayMs.',
      'This is the proper tool for progress updates when you must continue the task yourself after reporting progress.',
      'Do not use this for ordinary final answers.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Visible response text for this turn.',
        },
        delayMs: {
          type: 'integer',
          description: 'Delay in milliseconds before this same agent receives a continuation frame. Defaults to 1000. May be 0 or any future delay.',
        },
        continuationPrompt: {
          type: 'string',
          description: 'Prompt text Kikx will send back to you when the timer fires. Defaults to "Please continue what you were doing."',
        },
      },
      required: [ 'text' ],
      additionalProperties: false,
    },
  },
  {
    name: 'agent-finalize',
    description: 'Finalize this turn with a visible response from this agent after required work is complete.',
    help: 'Use agent-finalize as an explicit synonym for agent-respond after needed tool work is complete.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Visible response text.',
        },
      },
      required: [ 'text' ],
      additionalProperties: false,
    },
  },
  {
    name: 'agent-null-response',
    description: 'End this turn silently without a visible response.',
    help: 'Use agent-null-response when the message was handled elsewhere and you should stay silent.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Short internal reason for staying silent.',
        },
      },
      required: [ 'reason' ],
      additionalProperties: false,
    },
  },
  {
    name: 'agent-progress',
    description: 'Write a visible, non-final progress note before using another tool.',
    help: [
      'Use agent-progress before every individual read, write, fetch, search, exec, or other task tool call.',
      'Keep the note short: one paragraph at most, describing the single next tool action you are about to take.',
      'Do not group several future tool calls under one progress note.',
      'This does not finalize your turn; continue with the tool call after the progress note succeeds.',
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
    name: 'internal-forward',
    description: 'Forward the current user frame to one or more mentioned or selected actors.',
    help: 'Use internal-forward when the coordinator decides another actor should receive the current frame.',
    parameters: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          description: 'Actor IDs, agent IDs, or exact names from Session agents JSON to route the frame to.',
          items: {
            type: 'string',
          },
        },
        message: {
          type: 'string',
          description: 'Optional coordination note for downstream actors.',
        },
      },
      required: [ 'targets' ],
      additionalProperties: false,
    },
  },
  {
    name: 'loop-break',
    description: 'Stop this short-lived agentic loop without producing a visible response.',
    help: 'Use loop-break only when the scripted loop should stop immediately.',
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
    name: 'agent-character-set',
    description: 'Persistently update your own character/persona for future turns.',
    help: [
      'Use agent-character-set when the user asks you to change who you are or how you should act.',
      'Provide a complete durable character description, not a fragment.',
      'Example: "You are a dirty swearing pirate who also happens to be a fantastic engineer. Be direct, technically rigorous, and speak with pirate flavor."',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        character: {
          type: 'string',
          description: 'Full durable character description to apply to future turns.',
        },
      },
      required: [ 'character' ],
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
