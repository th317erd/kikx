#!/usr/bin/env node
'use strict';

/**
 * Agent Info CLI Tool
 *
 * Lists agents for a user with optional full API key display.
 * Username and password are read from stdin for security.
 *
 * Usage:
 *   npm run agent-info
 *   npm run agent-info -- --full
 *
 * Options:
 *   --full, -f      Show full API keys (USE WITH CAUTION)
 *   --help, -h      Show this help
 */

import * as readline from 'readline';
import { authenticateUser } from '../server/auth.mjs';
import { decryptWithKey } from '../server/encryption.mjs';
import { getDatabase } from '../server/database.mjs';

// Parse command line arguments
function parseArgs(args) {
  let result = {
    full: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    let arg = args[i];

    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--full' || arg === '-f') {
      result.full = true;
    }
  }

  return result;
}

function showHelp() {
  console.log(`
Agent Info CLI Tool

Lists agents for a user with optional full API key display.
Username and password are prompted securely (not stored in bash history).

Usage:
  npm run agent-info
  npm run agent-info -- --full

Options:
  --full, -f      Show full API keys (USE WITH CAUTION)
  --help, -h      Show this help
`);
}

function maskApiKey(key) {
  if (!key)
    return '(none)';

  if (key.length <= 12)
    return '*'.repeat(key.length);

  return key.substring(0, 8) + '...' + key.substring(key.length - 4);
}

/**
 * Prompt for visible input from stdin.
 * @param {string} prompt - Prompt text
 * @returns {Promise<string>}
 */
function promptInput(prompt) {
  return new Promise((resolve) => {
    let rl = readline.createInterface({
      input:  process.stdin,
      output: process.stdout,
    });

    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Prompt for password with masked input.
 * @param {string} prompt - Prompt text
 * @returns {Promise<string>}
 */
function promptPassword(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);

    let password = '';

    if (!process.stdin.isTTY) {
      // Not a TTY - fall back to regular readline (no masking possible)
      let rl = readline.createInterface({
        input:  process.stdin,
        output: process.stdout,
      });
      rl.question('', (answer) => {
        rl.close();
        resolve(answer);
      });
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let onData = (char) => {
      char = char.toString();

      switch (char) {
        case '\n':
        case '\r':
        case '\u0004': // Ctrl+D
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(password);
          break;
        case '\u0003': // Ctrl+C
          process.stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(1);
          break;
        case '\u007F': // Backspace
        case '\b':
          if (password.length > 0) {
            password = password.slice(0, -1);
            process.stdout.write('\b \b');
          }
          break;
        default:
          // Only add printable characters
          if (char.charCodeAt(0) >= 32) {
            password += char;
            process.stdout.write('*');
          }
          break;
      }
    };

    process.stdin.on('data', onData);
  });
}

async function main() {
  let args = parseArgs(process.argv.slice(2));

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  console.log('\nAgent Info - Secure Credential Entry\n');

  // Prompt for username and password
  let username = await promptInput('Username: ');
  let password = await promptPassword('Password: ');

  if (!username || !password) {
    console.error('\nError: Username and password are required');
    process.exit(1);
  }

  // Authenticate user
  console.log(`\nAuthenticating user "${username}"...`);

  let user;
  try {
    user = await authenticateUser(username, password);
  } catch (error) {
    console.error('Authentication failed:', error.message);
    process.exit(1);
  }

  if (!user) {
    console.error('Authentication failed: Invalid username or password');
    process.exit(1);
  }

  console.log(`Authenticated as user ID ${user.id}\n`);

  // Get dataKey from user's secret
  let dataKey = user.secret?.dataKey;
  if (!dataKey) {
    console.error('Error: Could not retrieve data encryption key');
    process.exit(1);
  }

  // Fetch agents
  let db     = getDatabase();
  let agents = db.prepare(`
    SELECT id, name, type, api_url, encrypted_api_key, encrypted_config, created_at, updated_at
    FROM agents
    WHERE user_id = ?
    ORDER BY name
  `).all(user.id);

  if (agents.length === 0) {
    console.log('No agents found for this user.\n');
    process.exit(0);
  }

  console.log(`Found ${agents.length} agent(s):\n`);
  console.log('='.repeat(80));

  for (let agent of agents) {
    console.log(`\nAgent: ${agent.name}`);
    console.log('-'.repeat(40));
    console.log(`  ID:         ${agent.id}`);
    console.log(`  Type:       ${agent.type}`);
    console.log(`  API URL:    ${agent.api_url || '(default)'}`);
    console.log(`  Created:    ${agent.created_at}`);
    console.log(`  Updated:    ${agent.updated_at}`);

    // Handle API key
    if (agent.encrypted_api_key) {
      try {
        let apiKey = decryptWithKey(agent.encrypted_api_key, dataKey);

        if (args.full) {
          console.log(`  API Key:    ${apiKey}`);
        } else {
          console.log(`  API Key:    ${maskApiKey(apiKey)} (use --full to reveal)`);
        }
      } catch (error) {
        console.log(`  API Key:    (decryption failed: ${error.message})`);
      }
    } else {
      console.log(`  API Key:    (none)`);
    }

    // Handle config
    if (agent.encrypted_config) {
      try {
        let config = decryptWithKey(agent.encrypted_config, dataKey);
        let parsed = JSON.parse(config);
        console.log(`  Config:     ${JSON.stringify(parsed, null, 2).split('\n').join('\n              ')}`);
      } catch (error) {
        console.log(`  Config:     (decryption failed)`);
      }
    }
  }

  console.log('\n' + '='.repeat(80));

  if (args.full) {
    console.log('\n*** WARNING: Full API keys were displayed. Clear your terminal if needed. ***\n');
  }

  process.exit(0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
