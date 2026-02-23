'use strict';

// ============================================================================
// Help Function
// ============================================================================
// Provides help information about available commands, abilities, and functions.
// This function is always allowed (no permission check) so agents can use it
// to discover available capabilities.

import { InteractionFunction, PERMISSION } from '../function.mjs';
import { getAllRegisteredFunctions } from './system.mjs';
import { getAllAssertionTypes } from '../../assertions/index.mjs';
import { getAbilitiesBySource } from '../../abilities/registry.mjs';
import { getDatabase } from '../../../database.mjs';

/**
 * Help Function class.
 * Returns comprehensive help information about available commands, abilities,
 * and system functions. Supports regex filtering for targeted lookups.
 */
export class HelpFunction extends InteractionFunction {
  /**
   * Register the help function with the interaction system.
   *
   * @returns {Object} Registration info
   */
  static register() {
    return {
      name:        'help',
      description: 'Get help information about available commands, abilities, and functions. Supports regex filtering.',
      target:      '@system',
      permission:  PERMISSION.ALWAYS,  // No permission needed - agents can always ask for help
      schema: {
        type:       'object',
        properties: {
          filter: {
            type:        'string',
            description: 'Regular expression pattern to filter results by name or description',
          },
          category: {
            type:        'string',
            enum:        ['all', 'commands', 'functions', 'abilities', 'assertions'],
            description: 'Category of help to return',
            default:     'all',
          },
          detailed: {
            type:        'boolean',
            description: 'Include detailed information (schemas, examples)',
            default:     false,
          },
        },
      },
      examples: [
        {
          description: 'Get all help information',
          payload:     {},
        },
        {
          description: 'Filter by regex pattern',
          payload:     { filter: 'web|search' },
        },
        {
          description: 'Get help for a specific category',
          payload:     { category: 'functions', detailed: true },
        },
      ],
    };
  }

  constructor(context = {}) {
    super('help', context);
  }

  /**
   * Help function is always allowed.
   *
   * @param {Object} payload - The payload to check
   * @param {Object} context - Execution context
   * @returns {Promise<{allowed: boolean}>}
   */
  async allowed(payload, context = {}) {
    return { allowed: true };
  }

  /**
   * Execute the help function.
   *
   * @param {Object} params - Parameters
   * @param {string} [params.filter] - Regex pattern to filter results
   * @param {string} [params.category='all'] - Category to return
   * @param {boolean} [params.detailed=false] - Include detailed info
   * @returns {Promise<Object>} Help information
   */
  async execute(params = {}) {
    let { filter, category = 'all', detailed = false } = params;
    let regex = null;

    // Compile regex if filter provided
    if (filter) {
      try {
        regex = new RegExp(filter, 'i');
      } catch (e) {
        return {
          success: false,
          error:   `Invalid regex pattern: ${e.message}`,
        };
      }
    }

    let result = {
      success: true,
    };

    // Get commands
    if (category === 'all' || category === 'commands') {
      result.commands = this._getCommands(regex, detailed);
    }

    // Get system functions
    if (category === 'all' || category === 'functions') {
      result.functions = this._getFunctions(regex, detailed);
    }

    // Get abilities
    if (category === 'all' || category === 'abilities') {
      result.abilities = this._getAbilities(regex, detailed);
    }

    // Get assertion types
    if (category === 'all' || category === 'assertions') {
      result.assertions = this._getAssertions(regex, detailed);
    }

    return result;
  }

  /**
   * Get builtin commands.
   * @private
   */
  _getCommands(regex, detailed) {
    let builtinCommands = [
      { name: 'help',    description: 'Show help information. Usage: /help [filter]' },
      { name: 'clear',   description: 'Clear the current chat' },
      { name: 'session', description: 'Show session info or switch sessions' },
      { name: 'archive', description: 'Archive the current session' },
      { name: 'stream',  description: 'Toggle streaming mode (on/off)' },
      { name: 'ability', description: 'Manage abilities (create/list/view/delete)' },
    ];

    // Filter if regex provided
    if (regex) {
      builtinCommands = builtinCommands.filter(
        (cmd) => regex.test(cmd.name) || regex.test(cmd.description)
      );
    }

    // Get user commands from database if context has userId
    let userCommands = [];
    if (this.context.userId) {
      try {
        let db = getDatabase();
        userCommands = db.prepare(`
          SELECT id, name, description
          FROM commands
          WHERE user_id = ?
          ORDER BY name
        `).all(this.context.userId);

        if (regex) {
          userCommands = userCommands.filter(
            (cmd) => regex.test(cmd.name) || regex.test(cmd.description || '')
          );
        }
      } catch (e) {
        // Database might not be available in all contexts
      }
    }

    return {
      builtin: builtinCommands,
      user:    userCommands,
    };
  }

  /**
   * Get system functions.
   * @private
   */
  _getFunctions(regex, detailed) {
    let functions = getAllRegisteredFunctions();

    // Filter if regex provided
    if (regex) {
      functions = functions.filter(
        (fn) => regex.test(fn.name) || regex.test(fn.description || '')
      );
    }

    // Map to appropriate detail level
    return functions.map((fn) => {
      let item = {
        name:        fn.name,
        description: fn.description || '',
        permission:  fn.permission,
      };

      if (detailed) {
        item.schema   = fn.schema || null;
        item.examples = fn.examples || [];
      }

      return item;
    });
  }

  /**
   * Get abilities.
   * @private
   */
  _getAbilities(regex, detailed) {
    let systemAbilities  = getAbilitiesBySource('system');
    let builtinAbilities = getAbilitiesBySource('builtin');
    let allSystemAbilities = [...systemAbilities, ...builtinAbilities];

    // Filter system abilities
    if (regex) {
      allSystemAbilities = allSystemAbilities.filter(
        (a) => regex.test(a.name) || regex.test(a.description || '')
      );
    }

    // Get user abilities from database if context has userId
    let userAbilities = [];
    if (this.context.userId) {
      try {
        let db = getDatabase();
        userAbilities = db.prepare(`
          SELECT id, name, description
          FROM abilities
          WHERE user_id = ?
          ORDER BY name
        `).all(this.context.userId);

        if (regex) {
          userAbilities = userAbilities.filter(
            (a) => regex.test(a.name) || regex.test(a.description || '')
          );
        }
      } catch (e) {
        // Database might not be available
      }
    }

    // Map to appropriate detail level
    let mapAbility = (a) => {
      let item = {
        name:        a.name,
        description: a.description || '',
      };

      if (detailed && a.inputSchema) {
        item.inputSchema = a.inputSchema;
      }

      if (detailed && a.permissions) {
        item.permissions = a.permissions;
      }

      return item;
    };

    return {
      system: allSystemAbilities.map(mapAbility),
      user:   userAbilities.map(mapAbility),
    };
  }

  /**
   * Get assertion types.
   * @private
   */
  _getAssertions(regex, detailed) {
    let assertions = getAllAssertionTypes();

    // Filter if regex provided
    if (regex) {
      assertions = assertions.filter(
        (a) => regex.test(a.type) || regex.test(a.description || '')
      );
    }

    return assertions;
  }
}

export default HelpFunction;
