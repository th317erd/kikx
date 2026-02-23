#!/usr/bin/env node
'use strict';

import { createInterface } from 'readline';
import { changePassword, getUserByUsername } from '../auth.mjs';
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

  console.log('Hero - Change Password\n');

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

  // Get current password
  let oldPassword = await prompt('Current password: ', true);

  if (!oldPassword) {
    console.error('Error: Current password is required');
    process.exit(1);
  }

  // Get new password
  let newPassword = await prompt('New password: ', true);

  if (!newPassword || newPassword.length < 8) {
    console.error('Error: New password must be at least 8 characters');
    process.exit(1);
  }

  // Confirm new password
  let confirmPassword = await prompt('Confirm new password: ', true);

  if (newPassword !== confirmPassword) {
    console.error('Error: Passwords do not match');
    process.exit(1);
  }

  try {
    await changePassword(username, oldPassword, newPassword);
    console.log(`\nPassword changed successfully for user "${username}"`);
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
