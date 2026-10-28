'use strict';

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { snapshotEnvironment } from '../config/index.mjs';

// Owner decision 2026-10-27: a shell command is bounded by default, but the bound
// is generous and any agent may replace it with a larger value or with no deadline
// at all. The previous 60s default plus a hard 10-minute ceiling meant a real build
// could not be started, and an explicit "never timeout" request was rejected.
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
// No ceiling by default: "anything, including Infinity" is the contract. A finite
// maximum remains available as an option for embedders that want a guard rail.
const MAX_TIMEOUT_MS = Infinity;
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
    this.cwd = options.cwd || os.homedir();
    let ambient = snapshotEnvironment();
    this.shell = options.shell || ambient.SHELL || '/bin/bash';
    this.env = {
      ...ambient,
      ...(options.env || {}),
    };
    this.defaultTimeoutMs = normalizeTimeout(options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, 'defaultTimeoutMs');
    this.maxTimeoutMs = normalizeOptionalTimeout(options.maxTimeoutMs ?? MAX_TIMEOUT_MS, 'maxTimeoutMs');
    this.exitStdioGraceMs = normalizeNonNegativeTimeout(options.exitStdioGraceMs ?? DEFAULT_EXIT_STDIO_GRACE_MS, 'exitStdioGraceMs');
  }

  async exec(params = {}) {
    // `exec` awaits the full output, so it has no independent policy of its own:
    // it honours the same contract as startProcess, including an explicit request
    // for no deadline. Leaving allowNoTimeout false here made `exec(cmd, {
    // timeoutMs: 0 })` throw while the identical call through ProcessManager
    // succeeded, which is the kind of split a caller cannot reason about.
    return await runLoginShellCommand(this.startProcess(params, {
      allowNoTimeout: true,
    }));
  }

  startProcess(params = {}, options = {}) {
    // Only an explicitly supplied defaultTimeoutMs may override the service
    // default. `?? null` looked equivalent but was not: an absent option became
    // null, which normalizeRequestedTimeout reads as "no deadline", so every
    // caller that did not opt in silently lost the 15-minute default.
    let request = this.normalizeExecutionRequest(params, {
      defaultTimeoutMs: options.defaultTimeoutMs === undefined ? undefined : options.defaultTimeoutMs,
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
  let allowNoTimeout = options.allowNoTimeout !== false;

  if (value == null || value === '') {
    if (defaultTimeoutMs == null && allowNoTimeout)
      return null;

    return defaultTimeoutMs;
  }

  let timeoutMs = parseTimeoutValue(value, 'timeoutMs');
  if (timeoutMs === null) {
    if (!allowNoTimeout)
      throw new TypeError('this command executor requires a bounded timeoutMs; omit the parameter to use its default');

    return null;
  }

  if (maxTimeoutMs != null && timeoutMs > maxTimeoutMs)
    throw new TypeError(`timeoutMs must be less than or equal to ${maxTimeoutMs}`);

  return timeoutMs;
}

// "No deadline" is `null` everywhere downstream: spawnLoginShellCommand only arms
// a timer when timeoutMs != null. Infinity must never reach setTimeout, because
// Node clamps it to 1ms and warns TimeoutOverflowWarning, which would kill every
// process the instant it started. So every "never" spelling normalises to null.
const NO_TIMEOUT_SENTINELS = new Set([ 'infinity', 'infinite', 'inf', 'none', 'never', 'no-timeout', 'notimeout' ]);

function parseTimeoutValue(value, fieldName) {
  if (typeof value === 'string' && NO_TIMEOUT_SENTINELS.has(value.trim().toLowerCase()))
    return null;

  let number = Number(value);
  if (!Number.isFinite(number)) {
    if (number === Infinity)
      return null;

    throw new TypeError(`${fieldName} must be a positive integer, 0, or Infinity`);
  }

  if (number < 0 || (number > 0 && number < 1))
    throw new TypeError(`${fieldName} must be a positive integer, 0, or Infinity`);

  // Zero is accepted as "no deadline": a model reasoning "no timeout" reaches for
  // 0 as readily as for Infinity, and the two mean the same thing to the caller.
  if (number === 0)
    return null;

  return Math.trunc(number);
}

function normalizeTimeout(value, fieldName) {
  let number = Number(value);
  if (!Number.isFinite(number) || number < 1)
    throw new TypeError(`${fieldName} must be a positive integer`);

  return Math.trunc(number);
}

// Unlike normalizeTimeout, this accepts Infinity: it configures a ceiling, and an
// infinite ceiling is the documented way to say "no ceiling".
function normalizeOptionalTimeout(value, fieldName) {
  if (value == null)
    return null;

  let number = Number(value);
  if (number === Infinity)
    return Infinity;

  if (!Number.isFinite(number) || number < 1)
    throw new TypeError(`${fieldName} must be a positive integer or Infinity`);

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
