'use strict';

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

// =============================================================================
// Helpers
// =============================================================================

const SCRIPT = path.resolve('scripts/add-user.mjs');

// Check if node:sqlite is available (required for DB-dependent tests)
let hasSqlite = false;

function runAddUser(args = [], input = '', timeout = 30000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timer  = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Timeout after ${timeout}ms\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeout);

    let child = spawn('node', [SCRIPT, ...args], {
      env:   { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    // Feed input (email\npassword\nconfirm\n)
    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('add-user script', () => {
  before(async () => {
    try {
      await import('node:sqlite');
      hasSqlite = true;
    } catch (_error) {
      hasSqlite = false;
    }
  });

  // ---- Help output (no DB needed) ----

  it('should show help with --help', async () => {
    let result = await runAddUser(['--help']);
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes('Usage:'));
    assert.ok(result.stdout.includes('--db'));
    assert.ok(result.stdout.includes('--org'));
  });

  it('should show help with -h', async () => {
    let result = await runAddUser(['-h']);
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes('Usage:'));
  });

  // ---- Input validation (no DB needed) ----

  it('should fail when email is empty', async () => {
    let result = await runAddUser(['--db', '/tmp/unused.db'], '\n');
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes('email is required'));
  });

  it('should fail when passwords do not match', async () => {
    let result = await runAddUser(
      ['--db', '/tmp/unused.db'],
      'test@example.com\npassword123\ndifferent456\n',
    );
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes('passwords do not match'));
  });

  it('should fail when password is empty', async () => {
    let result = await runAddUser(
      ['--db', '/tmp/unused.db'],
      'test@example.com\n\n',
    );
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes('password is required'));
  });

  it('should show database path from --db flag', async () => {
    let result = await runAddUser(['--db', '/tmp/custom.db'], '\n');
    assert.ok(result.stdout.includes('Database: /tmp/custom.db'));
  });

  it('should use KIKX_DB environment variable', async () => {
    let child = spawn('node', [SCRIPT], {
      env:   { ...process.env, NODE_NO_WARNINGS: '1', KIKX_DB: '/tmp/env-test.db' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stdin.end('\n'); // empty email → will exit with error

    await new Promise((resolve) => child.on('close', resolve));

    assert.ok(stdout.includes('Database: /tmp/env-test.db'));
  });

  // ---- DB-dependent tests (require node:sqlite / Node 22.5+) ----

  it('should create a user successfully', async (t) => {
    if (!hasSqlite)
      return t.skip('Requires node:sqlite (Node 22.5+)');

    let tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kikx-add-user-'));
    let dbPath = path.join(tmpDir, 'test.db');

    try {
      let result = await runAddUser(
        ['--db', dbPath],
        'admin@example.com\nsecurePass123\nsecurePass123\n',
      );

      assert.equal(result.code, 0, `Expected exit 0, got ${result.code}. stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes('User created successfully'));
      assert.ok(result.stdout.includes('admin@example.com'));
      assert.ok(result.stdout.includes('usr_'));
      assert.ok(result.stdout.includes('Organization'));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('should accept --org, --first, --last flags', async (t) => {
    if (!hasSqlite)
      return t.skip('Requires node:sqlite (Node 22.5+)');

    let tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kikx-add-user-'));
    let dbPath = path.join(tmpDir, 'test.db');

    try {
      let result = await runAddUser(
        ['--db', dbPath, '--org', 'TestCorp', '--first', 'Jane', '--last', 'Doe'],
        'jane@testcorp.com\nsecurePass123\nsecurePass123\n',
      );

      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes('User created successfully'));
      assert.ok(result.stdout.includes('jane@testcorp.com'));
      assert.ok(result.stdout.includes('TestCorp'));
      assert.ok(result.stdout.includes('Jane Doe'));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('should reject duplicate email', async (t) => {
    if (!hasSqlite)
      return t.skip('Requires node:sqlite (Node 22.5+)');

    let tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kikx-add-user-'));
    let dbPath = path.join(tmpDir, 'test.db');

    try {
      // First user
      let result1 = await runAddUser(
        ['--db', dbPath],
        'dup@example.com\nsecurePass123\nsecurePass123\n',
      );
      assert.equal(result1.code, 0, `First user failed: ${result1.stderr}`);

      // Duplicate
      let result2 = await runAddUser(
        ['--db', dbPath],
        'dup@example.com\nsecurePass123\nsecurePass123\n',
      );
      assert.notEqual(result2.code, 0);
      assert.ok(result2.stderr.includes('already registered'));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('should reject invalid email format', async (t) => {
    if (!hasSqlite)
      return t.skip('Requires node:sqlite (Node 22.5+)');

    let tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kikx-add-user-'));
    let dbPath = path.join(tmpDir, 'test.db');

    try {
      let result = await runAddUser(
        ['--db', dbPath],
        'not-an-email\nsecurePass123\nsecurePass123\n',
      );
      assert.notEqual(result.code, 0);
      assert.ok(
        result.stderr.includes('email') || result.stderr.includes('Email'),
        `Expected email error, got: ${result.stderr}`,
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('should reject short password', async (t) => {
    if (!hasSqlite)
      return t.skip('Requires node:sqlite (Node 22.5+)');

    let tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kikx-add-user-'));
    let dbPath = path.join(tmpDir, 'test.db');

    try {
      let result = await runAddUser(
        ['--db', dbPath],
        'test@example.com\nshort\nshort\n',
      );
      assert.notEqual(result.code, 0);
      assert.ok(result.stderr.includes('at least'), `Expected length error, got: ${result.stderr}`);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
