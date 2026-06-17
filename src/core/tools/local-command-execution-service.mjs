'use strict';

import { spawn } from 'node:child_process';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const FORCE_KILL_DELAY_MS = 1000;
const DEFAULT_EXIT_STDIO_GRACE_MS = 250;
const RVM_NOUNSET_COMPAT_PROLOGUE = [
  '# Kikx exec: RVM hooks assume these globals exist when user commands enable nounset.',
  'rvm_saved_env=()',
  'rvm_bash_nounset=${rvm_bash_nounset:-0}',
  'rvm_zsh_clobber=${rvm_zsh_clobber:-1}',
  'rvm_zsh_nomatch=${rvm_zsh_nomatch:-1}',
].join('\n');

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
    this.exitStdioGraceMs = normalizeNonNegativeTimeout(options.exitStdioGraceMs ?? DEFAULT_EXIT_STDIO_GRACE_MS, 'exitStdioGraceMs');
  }

  async exec(params = {}) {
    return await runLoginShellCommand(this.startProcess(params, {
      defaultTimeoutMs: this.defaultTimeoutMs,
      allowNoTimeout: false,
    }));
  }

  startProcess(params = {}, options = {}) {
    let request = this.normalizeExecutionRequest(params, {
      defaultTimeoutMs: options.defaultTimeoutMs ?? null,
      allowNoTimeout: options.allowNoTimeout !== false,
    });

    return spawnLoginShellCommand(request);
  }

  normalizeExecutionRequest(params = {}, options = {}) {
    let defaultTimeoutMs = options.defaultTimeoutMs === undefined ? this.defaultTimeoutMs : options.defaultTimeoutMs;
    return {
      command: normalizeCommand(params.command),
      cwd: normalizeCWD(this.cwd, params.cwd),
      env: normalizeEnvironment(this.env, params.env),
      shell: this.shell,
      stdin: normalizeStdin(params.stdin),
      timeoutMs: normalizeRequestedTimeout(params.timeoutMs, defaultTimeoutMs, this.maxTimeoutMs, {
        allowNoTimeout: options.allowNoTimeout !== false,
      }),
      exitStdioGraceMs: this.exitStdioGraceMs,
      startedAt: Date.now(),
    };
  }
}

async function runLoginShellCommand(handle = {}) {
  return await new Promise((resolve, reject) => {
    let stdoutChunks = [];
    let stderrChunks = [];
    let child = handle.child;
    let settled = false;
    let exitStdioTimer = null;
    if (!child) {
      reject(new Error('command process handle is missing child'));
      return;
    }

    let settle = ({ exitCode = null, signal = null, stdioClosedByManager = false } = {}) => {
      if (settled)
        return;

      settled = true;
      clearTimeout(exitStdioTimer);
      handle.clearTimeout?.();

      if (stdioClosedByManager)
        closeChildStdio(child);

      let stdout = Buffer.concat(stdoutChunks);
      let stderr = Buffer.concat(stderrChunks);

      resolve({
        command: handle.command,
        shell: handle.shell,
        cwd: handle.cwd,
        exitCode,
        signal,
        timedOut: handle.timedOut === true,
        timeoutMs: handle.timeoutMs,
        durationMs: Date.now() - handle.startedAt,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
        stdioClosedByManager,
      });
    };

    child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on('error', (error) => {
      if (settled)
        return;

      settled = true;
      clearTimeout(exitStdioTimer);
      handle.clearTimeout?.();
      reject(error);
    });
    child.on('exit', (exitCode, signal) => {
      handle.clearTimeout?.();
      exitStdioTimer = setTimeout(() => {
        settle({ exitCode, signal, stdioClosedByManager: true });
      }, handle.exitStdioGraceMs);
      exitStdioTimer.unref?.();
    });
    child.on('close', (exitCode, signal) => {
      settle({ exitCode, signal, stdioClosedByManager: false });
    });
  });
}

function spawnLoginShellCommand(options = {}) {
  let timedOut = false;
  let timeout = null;
  let forceKillTimeout = null;
  let child = spawn(options.shell, [ '-lc', buildLoginShellCommand(options.command, options.shell) ], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: [ 'pipe', 'pipe', 'pipe' ],
  });

  if (options.timeoutMs != null) {
    timeout = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, 'SIGTERM');
      forceKillTimeout = setTimeout(() => {
        killProcessGroup(child, 'SIGKILL');
      }, FORCE_KILL_DELAY_MS);
      forceKillTimeout.unref?.();
    }, options.timeoutMs);
    timeout.unref?.();
  }

  child.stdin.on('error', () => {});
  if (options.stdin) {
    child.stdin.write(options.stdin);
    if (!options.stdin.endsWith('\n'))
      child.stdin.write('\n');
  }
  child.stdin.end();

  return {
    ...options,
    child,
    get timedOut() {
      return timedOut;
    },
    kill(signal = 'SIGTERM') {
      killProcessGroup(child, signal);
    },
    clearTimeout() {
      clearTimeout(timeout);
      clearTimeout(forceKillTimeout);
    },
  };
}

function buildLoginShellCommand(command, shell) {
  if (!isRVMCompatibleShell(shell))
    return command;

  return `${RVM_NOUNSET_COMPAT_PROLOGUE}\n${command}`;
}

function isRVMCompatibleShell(shell) {
  let shellName = path.basename(shell || '');
  return shellName === 'bash' || shellName === 'zsh';
}

function killProcessGroup(child, signal) {
  if (!child?.pid)
    return;

  try {
    process.kill(-child.pid, signal);
  } catch (_error) {}
}

function closeChildStdio(child) {
  for (let stream of [ child?.stdout, child?.stderr ]) {
    try {
      stream?.destroy?.();
    } catch (_error) {}
  }
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

function normalizeRequestedTimeout(value, defaultTimeoutMs, maxTimeoutMs, options = {}) {
  if (value == null || value === '') {
    if (defaultTimeoutMs == null && options.allowNoTimeout)
      return null;

    return defaultTimeoutMs;
  }

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

function normalizeNonNegativeTimeout(value, fieldName) {
  let number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    throw new TypeError(`${fieldName} must be a non-negative integer`);

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
