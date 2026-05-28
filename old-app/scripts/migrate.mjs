#!/usr/bin/env node

'use strict';

// =============================================================================
// migrate — Run pending schema migrations against the Kikx V2 database
// =============================================================================
// Usage: node scripts/migrate.mjs [--db <path>]
//
// Migrations are defined inline below. Each has a unique ID, a description,
// and an `up` function that receives the raw SQLite connection.
// A `_migrations` table tracks which migrations have been applied.
//
// Environment:
//   KIKX_DB    Database file path (default: ~/.config/kikx/kikx.db)
// =============================================================================

import path from 'node:path';
import os   from 'node:os';

import { KikxCore } from '../src/core/kikx-core.mjs';

// ---------------------------------------------------------------------------
// Migration definitions — append new migrations to the end of this array
// ---------------------------------------------------------------------------

const MIGRATIONS = [
  {
    id:          '20260302-001',
    description: 'Add avatar column to users table',
    up:          async (connection) => {
      try {
        await connection.query('ALTER TABLE users ADD COLUMN "avatar" TEXT');
      } catch (error) {
        // SQLite throws if column already exists — that's fine
        if (!error.message.includes('duplicate column'))
          throw error;
      }
    },
  },
];

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let args = {};

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--db' && argv[i + 1])
      args.db = argv[++i];

    if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/migrate.mjs [--db <path>]');
      console.log('');
      console.log('Runs pending schema migrations against the Kikx V2 database.');
      console.log('');
      console.log('Options:');
      console.log('  --db <path>   Database file (default: ~/.config/kikx/kikx.db, env: KIKX_DB)');
      process.exit(0);
    }
  }

  return args;
}

async function ensureMigrationTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          TEXT PRIMARY KEY,
      description TEXT,
      applied_at  TEXT DEFAULT (datetime('now'))
    )
  `);
}

async function getAppliedMigrations(connection) {
  let rows = await connection.query('SELECT id FROM _migrations');
  let ids  = new Set();

  if (Array.isArray(rows)) {
    for (let row of rows)
      ids.add(row.id);
  }

  return ids;
}

async function recordMigration(connection, migration) {
  await connection.query(
    'INSERT INTO _migrations (id, description) VALUES (?, ?)',
    [migration.id, migration.description],
  );
}

async function main() {
  let args   = parseArgs(process.argv);
  let dbPath = args.db || process.env.KIKX_DB || path.join(os.homedir(), '.config', 'kikx', 'kikx.db');

  console.log(`Database: ${dbPath}`);
  console.log('');

  let core;

  try {
    core = new KikxCore({
      database: { filename: dbPath },
    });

    await core.start();

    let connection = core.getConnection();

    await ensureMigrationTable(connection);
    let applied = await getAppliedMigrations(connection);

    let pending = MIGRATIONS.filter((migration) => !applied.has(migration.id));

    if (pending.length === 0) {
      console.log('No pending migrations.');
      await core.stop();
      return;
    }

    console.log(`${pending.length} pending migration(s):\n`);

    for (let migration of pending) {
      console.log(`  Running: ${migration.id} — ${migration.description}`);

      await migration.up(connection);
      await recordMigration(connection, migration);

      console.log(`  Done.`);
    }

    console.log('\nAll migrations applied successfully.');

    await core.stop();
  } catch (error) {
    console.error(`\nMigration failed: ${error.message}`);

    if (core)
      await core.stop();

    process.exit(1);
  }
}

main();
