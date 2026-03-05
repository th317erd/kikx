#!/usr/bin/env node

'use strict';

// =============================================================================
// reset-password — CLI script to reset a Kikx user's password
// =============================================================================
// Usage: npm run reset-password
//
// Prompts for email (visible), current password, new password, and
// confirmation (all password fields masked).
//
// Options:
//   --db <path>   Database file path (default: ~/.config/kikx/kikx.db)
//
// Environment:
//   KIKX_DB       Same as --db
// =============================================================================

import path     from 'node:path';
import os       from 'node:os';
import readline from 'node:readline';

import { KikxCore }    from '../src/core/kikx-core.mjs';
import { Keystore }    from '../src/core/crypto/keystore.mjs';
import { AuthService } from '../src/server/auth/index.mjs';

// --- Argument Parsing ---

function parseArgs(argv) {
  let args = {};
  let i    = 2;

  while (i < argv.length) {
    let arg = argv[i];

    if (arg === '--db' && argv[i + 1]) {
      args.db = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm run reset-password [-- --db <path>]');
      console.log('');
      console.log('Prompts for email, current password, new password, and confirmation.');
      console.log('');
      console.log('Options:');
      console.log('  --db <path>   Database file (default: ~/.config/kikx/kikx.db, env: KIKX_DB)');
      process.exit(0);
    }

    i++;
  }

  return args;
}

// --- Interactive Prompts ---

function askQuestion(question) {
  let rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptPassword(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);

    let password = '';

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let handler = (ch) => {
      switch (ch) {
        case '\n':
        case '\r':
        case '\u0004': // Ctrl+D
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', handler);
          process.stdout.write('\n');
          resolve(password);
          break;

        case '\u0003': // Ctrl+C
          process.stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
          break;

        case '\u007F': // Backspace
        case '\b':
          if (password.length > 0) {
            password = password.slice(0, -1);
            process.stdout.write('\b \b');
          }
          break;

        default:
          password += ch;
          process.stdout.write('*');
          break;
      }
    };

    process.stdin.on('data', handler);
  });
}

// --- Fail helper ---

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

// --- Main ---

async function main() {
  let args   = parseArgs(process.argv);
  let dbPath = args.db || process.env.KIKX_DB || path.join(os.homedir(), '.config', 'kikx', 'kikx.db');

  console.log(`Database: ${dbPath}`);
  console.log('');

  if (!process.stdin.isTTY)
    fail('This script requires an interactive terminal (TTY).');

  let email       = await askQuestion('Email: ');
  if (!email)
    fail('email is required.');

  let oldPassword = await promptPassword('Current password: ');
  if (!oldPassword)
    fail('current password is required.');

  let newPassword = await promptPassword('New password: ');
  if (!newPassword)
    fail('new password is required.');

  let confirm     = await promptPassword('Confirm new password: ');

  if (newPassword !== confirm)
    fail('passwords do not match.');

  if (newPassword === oldPassword)
    fail('new password must be different from current password.');

  // Boot KikxCore
  let core;

  try {
    core = new KikxCore({
      database: { filename: dbPath },
    });

    await core.start();

    let keystore = new Keystore();
    keystore.initialize();

    let authService = new AuthService({
      context:  core.getContext(),
      keystore,
    });

    // Verify current credentials via login
    let { user } = await authService.login(email, oldPassword);

    // Open the old password slot to recover the UMK
    let passwordSlot = JSON.parse(user.passwordSlot);
    let umk          = await keystore.openPasswordSlot(passwordSlot, oldPassword);

    // Create new password slot wrapping the same UMK with the new password
    let newSlot = await keystore.createPasswordSlot(umk, newPassword);
    user.passwordSlot = JSON.stringify(newSlot);
    await user.save();

    console.log('');
    console.log('Password updated successfully.');
    console.log(`  Email: ${user.email}`);

    keystore.destroy();
    await core.stop();
  } catch (error) {
    if (error.code === 'INVALID_CREDENTIALS') {
      console.error('\nError: Invalid email or password.');
      if (core && core.isStarted()) await core.stop();
      process.exit(1);
    }

    if (error.code === 'INVALID_EMAIL') {
      console.error(`\nError: ${error.message}`);
      if (core && core.isStarted()) await core.stop();
      process.exit(1);
    }

    if (error.code === 'INVALID_PASSWORD') {
      console.error(`\nError: ${error.message}`);
      if (core && core.isStarted()) await core.stop();
      process.exit(1);
    }

    console.error(`\nError: ${error.message}`);

    if (core && core.isStarted())
      await core.stop();

    process.exit(1);
  }
}

main();
