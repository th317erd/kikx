#!/usr/bin/env node
'use strict';

import { createInterface } from 'readline';
import { updateUserEncryption, getUserByUsername } from '../auth.mjs';
import { closeDatabase } from '../database.mjs';

/**
 * Prompt for input with optional hidden mode for passwords.
 */
function prompt(question, hidden = false) {
  return new Promise((resolve) => {
    let rl = createInterface({
      input:  process.stdin,
      output: process.stdout,
    });

    if (hidden) {
      process.stdout.write(question);

      let input = '';

      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      let onData = (char) => {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          rl.close();
          resolve(input);
        } else if (char === '\u0003') {
          process.stdout.write('\n');
          process.exit(1);
        } else if (char === '\u007F' || char === '\b') {
          if (input.length > 0)
            input = input.slice(0, -1);
        } else {
          input += char;
        }
      };

      process.stdin.on('data', onData);
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

async function main() {
  let args     = process.argv.slice(2);
  let username = args[0];

  console.log('Hero - Update User Encryption\n');
  console.log('This will generate new encryption keys and re-encrypt all user data.');
  console.log('Use this if you suspect your encryption keys have been compromised.\n');

  // Get username if not provided
  if (!username)
    username = await prompt('Username: ');

  if (!username || username.trim() === '') {
    console.error('Error: Username is required');
    process.exit(1);
  }

  username = username.trim();

  // Check if user exists
  let user = getUserByUsername(username);

  if (!user) {
    console.error(`Error: User "${username}" not found`);
    process.exit(1);
  }

  // Get password
  let password = await prompt('Password: ', true);

  if (!password) {
    console.error('Error: Password is required');
    process.exit(1);
  }

  // Confirm
  let confirm = await prompt('\nAre you sure you want to re-encrypt all data? (yes/no): ');

  if (confirm.toLowerCase() !== 'yes') {
    console.log('Cancelled.');
    process.exit(0);
  }

  try {
    console.log('\nRe-encrypting user data...');
    await updateUserEncryption(username, password);
    console.log(`\nEncryption keys updated successfully for user "${username}"`);
    console.log('Note: You will need to log in again as existing sessions have been invalidated.');
  } catch (error) {
    console.error(`\nError: ${error.message}`);
    process.exit(1);
  } finally {
    closeDatabase();
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
