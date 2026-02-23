'use strict';

// ============================================================================
// Session Setup
// ============================================================================
// Encapsulates the session/agent initialization logic shared between
// messages.mjs and messages-stream.mjs routes.

import { getDatabase } from '../../database.mjs';
import { decryptWithKey } from '../../encryption.mjs';
import { createAgent } from '../agents/index.mjs';
import { getSystemProcess, isSystemProcess, injectProcesses } from '../processes/index.mjs';
import { loadUserAbilities } from '../abilities/loaders/user.mjs';

/**
 * Set up a session's agent with decrypted credentials, loaded processes,
 * and content injection.
 *
 * @param {object} options
 * @param {object} options.session - Session row from DB (with agent fields joined)
 * @param {number} options.userId - User ID
 * @param {string} options.dataKey - Decryption key from auth middleware
 * @param {string} options.content - Raw user message content
 * @returns {{ agent: object, processedContent: string, processMap: Map }}
 */
export function setupSessionAgent({ session, userId, dataKey, content }) {
  let db = getDatabase();

  // Load user abilities
  loadUserAbilities(userId, dataKey);

  // Decrypt agent credentials
  let apiKey      = (session.encrypted_api_key) ? decryptWithKey(session.encrypted_api_key, dataKey) : null;
  let agentConfig = {};
  if (session.encrypted_config) {
    try {
      agentConfig = JSON.parse(decryptWithKey(session.encrypted_config, dataKey));
    } catch (error) {
      console.error(`Failed to decrypt/parse agent config for session ${session.id}:`, error.message);
    }
  }

  // Build process map for injection
  let defaultProcesses = [];
  try {
    defaultProcesses = JSON.parse(session.default_processes || '[]');
  } catch (error) {
    console.error(`Failed to parse default_processes for session ${session.id}:`, error.message);
  }
  let processMap = new Map();

  for (let processName of defaultProcesses) {
    if (isSystemProcess(processName)) {
      let processContent = getSystemProcess(processName);
      if (processContent)
        processMap.set(processName, processContent);
    }
  }

  // Load user processes
  let userProcessNames = defaultProcesses.filter((n) => !isSystemProcess(n));
  if (userProcessNames.length > 0) {
    let placeholders  = userProcessNames.map(() => '?').join(',');
    let userProcesses = db.prepare(`
      SELECT name, encrypted_content
      FROM processes
      WHERE user_id = ? AND name IN (${placeholders})
    `).all(userId, ...userProcessNames);

    for (let p of userProcesses) {
      let decryptedContent = decryptWithKey(p.encrypted_content, dataKey);
      processMap.set(p.name, decryptedContent);
    }
  }

  // Inject processes into user message content
  let processedContent = injectProcesses(content, processMap);

  // Create agent
  let agent = createAgent(session.agent_type, {
    apiKey: apiKey,
    apiUrl: session.agent_api_url,
    system: session.system_prompt,
    ...agentConfig,
  });

  return { agent, processedContent, processMap };
}
