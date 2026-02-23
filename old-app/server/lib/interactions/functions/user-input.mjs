'use strict';

// ============================================================================
// User Input Function
// ============================================================================
// Built-in function for requesting user input via the interaction bus.

import { InteractionFunction } from '../function.mjs';
import { getInteractionBus, TARGETS } from '../bus.mjs';

/**
 * Function for requesting user input.
 * Supports text, number, choice, and confirmation inputs.
 */
export class UserInputFunction extends InteractionFunction {
  constructor(name, context) {
    super(name || 'user_input', context);

    this.inputType  = null;
    this.prompt     = null;
    this.options    = null;
    this.validation = null;
  }

  /**
   * Execute the user input request.
   *
   * @param {Object} params - Parameters
   * @param {string} params.type - Input type: 'text', 'number', 'choice', 'confirm'
   * @param {string} params.prompt - Prompt to show user
   * @param {Array} [params.options] - Options for choice type
   * @param {Object} [params.validation] - Validation rules
   * @param {number} [params.timeout=0] - Timeout in ms
   * @returns {Promise<*>} User input
   */
  async execute(params) {
    let { type, prompt, options, validation, timeout } = params;

    this.inputType  = type || 'text';
    this.prompt     = prompt;
    this.options    = options;
    this.validation = validation;

    let bus         = getInteractionBus();
    let interaction = bus.create(TARGETS.USER, `input:${this.inputType}`, {
      prompt:     this.prompt,
      options:    this.options,
      validation: this.validation,
      functionId: this.id,
    }, {
      sourceId:  this.id,
      sessionId: this.context.sessionId,
      userId:    this.context.userId,
    });

    // Request user input and wait for response
    let response = await bus.request(interaction, timeout || 0);

    return response;
  }

  /**
   * Handle incoming interactions (not used for this function type).
   */
  async handle(interaction) {
    // User input function doesn't handle incoming interactions
    throw new Error('UserInputFunction does not handle interactions');
  }
}

/**
 * Ask user for text input.
 *
 * @param {string} prompt - Prompt
 * @param {Object} context - Context (userId, sessionId)
 * @param {Object} [options] - Options
 * @returns {Promise<string>} User input
 */
export async function askText(prompt, context, options = {}) {
  let func = new UserInputFunction('ask_text', context);
  return await func.start({
    type:       'text',
    prompt:     prompt,
    validation: options.validation,
    timeout:    options.timeout,
  });
}

/**
 * Ask user for a number.
 *
 * @param {string} prompt - Prompt
 * @param {Object} context - Context (userId, sessionId)
 * @param {Object} [options] - Options (min, max)
 * @returns {Promise<number>} User input
 */
export async function askNumber(prompt, context, options = {}) {
  let func = new UserInputFunction('ask_number', context);
  return await func.start({
    type:   'number',
    prompt: prompt,
    validation: {
      min: options.min,
      max: options.max,
    },
    timeout: options.timeout,
  });
}

/**
 * Ask user to choose from options.
 *
 * @param {string} prompt - Prompt
 * @param {Array<{label: string, value: any}>} choices - Choices
 * @param {Object} context - Context (userId, sessionId)
 * @param {Object} [options] - Options
 * @returns {Promise<*>} Selected value
 */
export async function askChoice(prompt, choices, context, options = {}) {
  let func = new UserInputFunction('ask_choice', context);
  return await func.start({
    type:    'choice',
    prompt:  prompt,
    options: choices,
    timeout: options.timeout,
  });
}

/**
 * Ask user for confirmation (yes/no).
 *
 * @param {string} prompt - Prompt
 * @param {Object} context - Context (userId, sessionId)
 * @param {Object} [options] - Options
 * @returns {Promise<boolean>} True if confirmed
 */
export async function askConfirm(prompt, context, options = {}) {
  let func = new UserInputFunction('ask_confirm', context);
  return await func.start({
    type:    'confirm',
    prompt:  prompt,
    timeout: options.timeout,
  });
}

export default {
  UserInputFunction,
  askText,
  askNumber,
  askChoice,
  askConfirm,
};
