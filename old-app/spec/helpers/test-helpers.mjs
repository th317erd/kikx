'use strict';

import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

/**
 * Create a temporary test directory.
 *
 * @returns {string} Path to temp directory
 */
export function createTempDir() {
  let tempDir = join(tmpdir(), `hero-test-${randomBytes(8).toString('hex')}`);
  mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

/**
 * Remove a temporary test directory.
 *
 * @param {string} tempDir - Path to temp directory
 */
export function removeTempDir(tempDir) {
  if (existsSync(tempDir))
    rmSync(tempDir, { recursive: true, force: true });
}

/**
 * Generate a random string.
 *
 * @param {number} length - Length in bytes (output will be 2x in hex)
 * @returns {string} Random hex string
 */
export function randomString(length = 16) {
  return randomBytes(length).toString('hex');
}

/**
 * Wait for a specified time.
 *
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mock console.error to suppress expected errors in tests.
 *
 * @returns {function} Restore function
 */
export function mockConsoleError() {
  let original    = console.error;
  console.error   = () => {};

  return () => {
    console.error = original;
  };
}

/**
 * Mock console.warn to suppress expected warnings in tests.
 *
 * @returns {function} Restore function
 */
export function mockConsoleWarn() {
  let original   = console.warn;
  console.warn   = () => {};

  return () => {
    console.warn = original;
  };
}

export default {
  createTempDir,
  removeTempDir,
  randomString,
  wait,
  mockConsoleError,
  mockConsoleWarn,
};
