'use strict';

import { Router } from 'express';
import { getDatabase } from '../database.mjs';
import { requireAuth } from '../middleware/auth.mjs';
import { getAllAssertionTypes } from '../lib/assertions/index.mjs';
import { getAbilitiesBySource } from '../lib/abilities/registry.mjs';
import { getAllSystemMethods } from '../lib/interactions/functions/system.mjs';

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * Built-in commands list.
 */
const BUILTIN_COMMANDS = [
  { name: 'help',    description: 'Show this help information. Usage: /help [filter]' },
  { name: 'clear',   description: 'Clear the current chat' },
  { name: 'session', description: 'Show session info or switch sessions' },
  { name: 'archive', description: 'Archive the current session' },
  { name: 'stream',  description: 'Toggle streaming mode (on/off)' },
  { name: 'ability', description: 'Manage abilities (create/list/view/delete)' },
  { name: 'start',   description: 'Re-send startup instructions to the AI agent' },
  { name: 'compact', description: 'Compact conversation history into a summary' },
];

/**
 * Apply regex filter to an array of items.
 *
 * @param {Array} items - Items to filter
 * @param {RegExp|null} regex - Regex to apply
 * @param {Array<string>} fields - Fields to check
 * @returns {Array} Filtered items
 */
function applyFilter(items, regex, fields = ['name', 'description']) {
  if (!regex) {
    return items;
  }

  return items.filter((item) => {
    for (let field of fields) {
      if (item[field] && regex.test(item[field])) {
        return true;
      }
    }
    return false;
  });
}

/**
 * GET /api/help
 * Get comprehensive help data including handlers, assertions, and abilities.
 *
 * Query params:
 * - filter: Regex pattern to filter results by name or description
 * - category: Category to return (all, commands, functions, abilities, assertions)
 * - detailed: Include detailed information (true/false)
 */
router.get('/', (req, res) => {
  let db = getDatabase();

  // Parse query params
  let { filter, category = 'all', detailed } = req.query;
  let regex = null;

  // Compile regex if filter provided
  if (filter) {
    try {
      regex = new RegExp(filter, 'i');
    } catch (e) {
      return res.status(400).json({
        error: `Invalid regex pattern: ${e.message}`,
      });
    }
  }

  let isDetailed = (detailed === 'true' || detailed === '1');

  // Build response based on category
  let response = {};

  // System functions (previously systemMethods)
  if (category === 'all' || category === 'functions') {
    let systemMethods = getAllSystemMethods();
    response.systemMethods = applyFilter(systemMethods, regex, ['name', 'description']);

    // If detailed, include schema and examples
    if (!isDetailed) {
      response.systemMethods = response.systemMethods.map((m) => ({
        name:        m.name,
        description: m.description,
        permission:  m.permission,
      }));
    }
  }

  // Assertions
  if (category === 'all' || category === 'assertions') {
    let assertions = getAllAssertionTypes();
    response.assertions = applyFilter(assertions, regex, ['type', 'description']);
  }

  // Abilities (processes for backwards compatibility)
  if (category === 'all' || category === 'abilities') {
    // Get system abilities from registry
    let systemAbilities  = getAbilitiesBySource('system');
    let builtinAbilities = getAbilitiesBySource('builtin');
    let allSystemAbilities = [...systemAbilities, ...builtinAbilities];

    // Get user abilities from database
    let userAbilities = db.prepare(`
      SELECT id, name, description
      FROM abilities
      WHERE user_id = ?
      ORDER BY name
    `).all(req.user.id);

    // Apply filter
    allSystemAbilities = applyFilter(allSystemAbilities, regex);
    userAbilities      = applyFilter(userAbilities, regex);

    response.processes = {
      system: allSystemAbilities.map((a) => {
        let item = {
          name:        a.name,
          description: a.description,
        };
        if (isDetailed && a.inputSchema) {
          item.inputSchema = a.inputSchema;
        }
        return item;
      }),
      user: userAbilities.map((a) => ({
        id:          a.id,
        name:        a.name,
        description: a.description,
      })),
    };
  }

  // Commands
  if (category === 'all' || category === 'commands') {
    // Get user commands
    let userCommands = db.prepare(`
      SELECT id, name, description
      FROM commands
      WHERE user_id = ?
      ORDER BY name
    `).all(req.user.id);

    // Apply filter
    let filteredBuiltin = applyFilter(BUILTIN_COMMANDS, regex);
    let filteredUser    = applyFilter(userCommands, regex);

    response.commands = {
      builtin: filteredBuiltin,
      user:    filteredUser.map((c) => ({
        id:          c.id,
        name:        c.name,
        description: c.description,
      })),
    };
  }

  return res.json(response);
});

export default router;
