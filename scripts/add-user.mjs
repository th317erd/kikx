#!/usr/bin/env node

'use strict';

// =============================================================================
// add-user — CLI script to create a Kikx user
// =============================================================================
// Usage: npm run add-user
//
// Prompts for email and password (masked) from stdin.
// Accepts optional flags:
//   --db <path>       Database file path (default: ~/.config/kikx/kikx.db)
//   --org <name>      Organization name (default: derived from email)
//   --first <name>    First name
//   --last <name>     Last name
//
// Environment:
//   KIKX_DB           Same as --db
// =============================================================================

import path from 'node:path';
import os   from 'node:os';
import readline from 'node:readline';

import { KikxCore }    from '../src/core/kikx-core.mjs';
import { Keystore }    from '../src/core/crypto/keystore.mjs';
import { AuthService } from '../src/server/auth/index.mjs';

// --- Argument Parsing ---

function parseArgs(argv) {
  let args = {};
  let i    = 2; // skip node and script path

  while (i < argv.length) {
    let arg = argv[i];

    if (arg === '--db' && argv[i + 1]) {
      args.db = argv[++i];
    } else if (arg === '--org' && argv[i + 1]) {
      args.org = argv[++i];
    } else if (arg === '--first' && argv[i + 1]) {
      args.firstName = argv[++i];
    } else if (arg === '--last' && argv[i + 1]) {
      args.lastName = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm run add-user [-- --db <path>] [-- --org <name>] [-- --first <name>] [-- --last <name>]');
      console.log('');
      console.log('Prompts for email and password (masked) interactively.');
      console.log('');
      console.log('Options:');
      console.log('  --db <path>     Database file (default: ~/.config/kikx/kikx.db, env: KIKX_DB)');
      console.log('  --org <name>    Organization name (default: derived from email)');
      console.log('  --first <name>  First name');
      console.log('  --last <name>   Last name');
      process.exit(0);
    }

    i++;
  }

  return args;
}

// --- Interactive Prompts ---

// Collect all lines from stdin into an array (for piped input).
function readAllLines() {
  return new Promise((resolve) => {
    let lines = [];
    let rl    = readline.createInterface({ input: process.stdin });

    rl.on('line', (line) => lines.push(line.trim()));
    rl.on('close', () => resolve(lines));
  });
}

// Single readline question (TTY mode, for email)
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

// Password prompt with masking (TTY mode only)
function promptPasswordTTY(question) {
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

        case '\u007F': // Backspace (most terminals)
        case '\b':     // Backspace (alternative)
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

  let email, password, confirm;

  if (process.stdin.isTTY) {
    // Interactive TTY: readline for email, raw mode for passwords
    email = await askQuestion('Email: ');
    if (!email)
      fail('email is required.');

    password = await promptPasswordTTY('Password: ');
    if (!password)
      fail('password is required.');

    confirm = await promptPasswordTTY('Confirm password: ');
  } else {
    // Piped input: buffer all lines, then validate
    let lines = await readAllLines();

    email    = lines[0] || '';
    password = lines[1] || '';
    confirm  = lines[2] || '';

    if (!email)
      fail('email is required.');

    if (!password)
      fail('password is required.');
  }

  if (password !== confirm)
    fail('passwords do not match.');

  // Boot KikxCore with the specified database
  let core;

  try {
    core = new KikxCore({
      database: { filename: dbPath },
    });

    await core.start();

    // Initialize keystore + auth service
    let keystore = new Keystore();
    keystore.initialize();

    let authService = new AuthService({
      context:  core.getContext(),
      keystore,
    });

    // Register user
    let options = {};
    if (args.org)
      options.organizationName = args.org;

    if (args.firstName)
      options.firstName = args.firstName;

    if (args.lastName)
      options.lastName = args.lastName;

    let { user, organization } = await authService.register(email, password, options);

    console.log('');
    console.log('User created successfully.');
    console.log(`  ID:           ${user.id}`);
    console.log(`  Email:        ${user.email}`);
    console.log(`  Organization: ${organization.name} (${organization.id})`);

    if (user.firstName || user.lastName)
      console.log(`  Name:         ${user.getDisplayName()}`);

    // Clean up
    keystore.destroy();
    await core.stop();
  } catch (error) {
    if (error.code === 'DUPLICATE_EMAIL') {
      console.error(`\nError: "${email}" is already registered.`);
      process.exit(1);
    }

    if (error.code === 'INVALID_EMAIL') {
      console.error(`\nError: ${error.message}`);
      process.exit(1);
    }

    if (error.code === 'INVALID_PASSWORD') {
      console.error(`\nError: ${error.message}`);
      process.exit(1);
    }

    console.error(`\nError: ${error.message}`);

    if (core && core.isStarted())
      await core.stop();

    process.exit(1);
  }
}

main();
