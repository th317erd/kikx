#!/usr/bin/env node
'use strict';

import { createInterface } from 'readline';
import { createUser } from '../auth.mjs';
import { closeDatabase } from '../database.mjs';

/**
 * Check if stdin is a TTY (interactive terminal).
 */
function isTTY() {
  return process.stdin.isTTY === true;
}

/**
 * Prompt for input with optional hidden mode for passwords.
 * Falls back to simple readline if not in a TTY.
 */
function prompt(question, hidden = false) {
  return new Promise((resolve) => {
    let rl = createInterface({
      input:  process.stdin,
      output: process.stdout,
    });

    if (hidden && isTTY()) {
      // For hidden input in TTY mode, handle character by character
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
          // Ctrl+C
          process.stdout.write('\n');
          process.exit(1);
        } else if (char === '\u007F' || char === '\b') {
          // Backspace
          if (input.length > 0)
            input = input.slice(0, -1);
        } else {
          input += char;
        }
      };

      process.stdin.on('data', onData);
    } else {
      // Non-TTY mode or non-hidden: use simple readline
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
  let password = args[1];

  console.log('Hero - Add User\n');

  // Get username if not provided
  if (!username)
    username = await prompt('Username: ');

  if (!username || username.trim() === '') {
    console.error('Error: Username is required');
    process.exit(1);
  }

  username = username.trim();

  // Validate username
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    console.error('Error: Username can only contain letters, numbers, underscores, and hyphens');
    process.exit(1);
  }

  // Get password if not provided via args
  if (!password)
    password = await prompt('Password: ', true);

  if (!password || password.length < 8) {
    console.error('Error: Password must be at least 8 characters');
    process.exit(1);
  }

  // Confirm password (skip if provided via args)
  if (!args[1]) {
    let confirmPassword = await prompt('Confirm password: ', true);

    if (password !== confirmPassword) {
      console.error('Error: Passwords do not match');
      process.exit(1);
    }
  }

  try {
    let user = await createUser(username, password);
    console.log(`\nUser "${user.username}" created successfully (ID: ${user.id})`);
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
