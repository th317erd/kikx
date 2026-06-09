'use strict';

import { spawn } from 'node:child_process';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const FORCE_KILL_DELAY_MS = 1000;

export class LocalCommandExecutionService {
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
    this.shell = options.shell || process.env.SHELL || '/bin/bash';
    this.env = {
      ...process.env,
      ...(options.env || {}),
    };
    this.defaultTimeoutMs = normalizeTimeout(options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, 'defaultTimeoutMs');
    this.maxTimeoutMs = normalizeTimeout(options.maxTimeoutMs ?? MAX_TIMEOUT_MS, 'maxTimeoutMs');
  }

  async exec(params = {}) {
    let command = normalizeCommand(params.command);
    let cwd = normalizeCWD(this.cwd, params.cwd);
    let timeoutMs = normalizeRequestedTimeout(params.timeoutMs, this.defaultTimeoutMs, this.maxTimeoutMs);
    let env = normalizeEnvironment(this.env, params.env);
    let startedAt = Date.now();

    return await runLoginShellCommand({
      command,
      cwd,
      env,
      shell: this.shell,
      stdin: normalizeStdin(params.stdin),
      timeoutMs,
      startedAt,
    });
  }
}

async function runLoginShellCommand(options = {}) {
  return await new Promise((resolve, reject) => {
    let stdoutChunks = [];
    let stderrChunks = [];
    let timedOut = false;
    let timeout = null;
    let forceKillTimeout = null;
    let child;

    try {
      child = spawn(options.shell, [ '-lc', options.command ], {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: [ 'pipe', 'pipe', 'pipe' ],
      });
    } catch (error) {
      reject(error);
      return;
    }

    timeout = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, 'SIGTERM');
      forceKillTimeout = setTimeout(() => {
        killProcessGroup(child, 'SIGKILL');
      }, FORCE_KILL_DELAY_MS);
      forceKillTimeout.unref?.();
    }, options.timeoutMs);
    timeout.unref?.();

    child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      clearTimeout(timeout);
      clearTimeout(forceKillTimeout);
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      clearTimeout(forceKillTimeout);
      let stdout = Buffer.concat(stdoutChunks);
      let stderr = Buffer.concat(stderrChunks);

      resolve({
        command: options.command,
        shell: options.shell,
        cwd: options.cwd,
        exitCode,
        signal,
        timedOut,
        timeoutMs: options.timeoutMs,
        durationMs: Date.now() - options.startedAt,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
      });
    });

    if (options.stdin) {
      child.stdin.write(options.stdin);
      if (!options.stdin.endsWith('\n'))
        child.stdin.write('\n');
    }

    child.stdin.end();
  });
}

function killProcessGroup(child, signal) {
  if (!child?.pid)
    return;

  try {
    process.kill(-child.pid, signal);
  } catch (_error) {}
}

function normalizeCommand(value) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError('command must be a non-empty string');

  return value;
}

function normalizeCWD(baseCWD, value) {
  if (value == null || value === '')
    return path.resolve(baseCWD);

  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError('cwd must be a non-empty string when provided');

  return path.resolve(baseCWD, value.trim());
}

function normalizeRequestedTimeout(value, defaultTimeoutMs, maxTimeoutMs) {
  if (value == null || value === '')
    return defaultTimeoutMs;

  let timeoutMs = normalizeTimeout(value, 'timeoutMs');
  if (timeoutMs > maxTimeoutMs)
    throw new TypeError(`timeoutMs must be less than or equal to ${maxTimeoutMs}`);

  return timeoutMs;
}

function normalizeTimeout(value, fieldName) {
  let number = Number(value);
  if (!Number.isFinite(number) || number < 1)
    throw new TypeError(`${fieldName} must be a positive integer`);

  return Math.trunc(number);
}

function normalizeEnvironment(baseEnv, extraEnv) {
  if (extraEnv == null)
    return { ...baseEnv };

  if (!extraEnv || typeof extraEnv !== 'object' || Array.isArray(extraEnv))
    throw new TypeError('env must be an object when provided');

  let env = { ...baseEnv };
  for (let [key, value] of Object.entries(extraEnv)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw new TypeError(`Invalid environment variable name: ${key}`);

    if (value == null) {
      delete env[key];
      continue;
    }

    env[key] = String(value);
  }

  return env;
}

function normalizeStdin(value) {
  if (value == null)
    return '';

  if (typeof value !== 'string')
    throw new TypeError('stdin must be a string when provided');

  return value;
}
