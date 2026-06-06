'use strict';

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const DEFAULT_WATCH_ENTRIES = [
  'src',
  'scripts',
  'package.json',
  '.env.dev',
];
const WATCHABLE_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.mjs',
]);
const WATCHABLE_BASENAMES = new Set([
  '.env.dev',
  'package.json',
]);
const IGNORED_SEGMENTS = new Set([
  '.aeordb',
  '.git',
  '.stagehand',
  'coverage',
  'node_modules',
  'old-app',
]);
const START_COMMAND = [ process.execPath, [ 'scripts/start-kikx-dev.mjs' ] ];

let currentChild = null;
let shuttingDown = false;

export function shouldIgnoreWatchPath(filePath) {
  let segments = path.normalize(filePath).split(path.sep).filter(Boolean);
  return segments.some((segment) => IGNORED_SEGMENTS.has(segment));
}

export function isWatchableFile(filePath) {
  if (shouldIgnoreWatchPath(filePath))
    return false;

  let baseName = path.basename(filePath);
  if (WATCHABLE_BASENAMES.has(baseName))
    return true;

  return WATCHABLE_EXTENSIONS.has(path.extname(filePath));
}

export async function collectWatchFiles(entries = DEFAULT_WATCH_ENTRIES, options = {}) {
  let cwd = options.cwd || process.cwd();
  let files = [];

  for (let entry of entries) {
    let entryPath = path.resolve(cwd, entry);
    await collectWatchPath(entryPath, files);
  }

  return files.sort();
}

export async function fingerprintFiles(files, options = {}) {
  let stat = options.stat || fs.stat;
  let parts = [];

  for (let filePath of [ ...files ].sort()) {
    try {
      let stats = await stat(filePath);
      parts.push(`${filePath}:${Number(stats.mtimeMs).toFixed(3)}:${stats.size}`);
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw error;

      parts.push(`${filePath}:missing`);
    }
  }

  return parts.join('\n');
}

export function buildHealthURL(host, port) {
  return `http://${host}:${port}/health`;
}

async function main() {
  let host = process.env.KIKX_HOST || '127.0.0.1';
  let port = Number.parseInt(process.env.KIKX_PORT || '3000', 10);
  let healthURL = buildHealthURL(host, Number.isInteger(port) ? port : 3000);
  let watchEntries = parseWatchEntries(process.env.KIKX_WATCH_PATHS);
  let lastFingerprint = '';

  for (let signal of [ 'SIGINT', 'SIGTERM' ])
    process.on(signal, () => cleanup(signal));

  process.on('exit', () => {
    if (currentChild)
      stopChild(currentChild, { force: true });
  });

  await startKikx(healthURL);
  lastFingerprint = await fingerprintWatchEntries(watchEntries);
  console.log(`[dev-watch] Watching ${watchEntries.join(', ')} for changes... (Ctrl+C to stop)`);

  while (!shuttingDown) {
    await sleep(1000);

    if (currentChild && currentChild.exitCode != null && !shuttingDown) {
      console.log('[dev-watch] Kikx exited unexpectedly -- restarting...');
      await startKikx(healthURL);
      lastFingerprint = await fingerprintWatchEntries(watchEntries);
      continue;
    }

    let currentFingerprint = await fingerprintWatchEntries(watchEntries);
    if (currentFingerprint === lastFingerprint)
      continue;

    await sleep(250);
    currentFingerprint = await fingerprintWatchEntries(watchEntries);
    if (currentFingerprint === lastFingerprint)
      continue;

    console.log('');
    console.log('[dev-watch] Source changed -- restarting Kikx...');
    lastFingerprint = currentFingerprint;
    await startKikx(healthURL);
  }
}

async function collectWatchPath(entryPath, files) {
  if (shouldIgnoreWatchPath(entryPath))
    return;

  let stats;
  try {
    stats = await fs.stat(entryPath);
  } catch (error) {
    if (error.code === 'ENOENT')
      return;

    throw error;
  }

  if (stats.isFile()) {
    if (isWatchableFile(entryPath))
      files.push(entryPath);
    return;
  }

  if (!stats.isDirectory())
    return;

  let dirEntries = await fs.readdir(entryPath, { withFileTypes: true });
  for (let dirEntry of dirEntries)
    await collectWatchPath(path.join(entryPath, dirEntry.name), files);
}

async function fingerprintWatchEntries(watchEntries) {
  let files = await collectWatchFiles(watchEntries);
  return await fingerprintFiles(files);
}

async function startKikx(healthURL) {
  if (currentChild)
    await stopChild(currentChild);
  else if (await isHealthy(healthURL))
    throw new Error(`Kikx is already responding at ${healthURL}. Stop the existing server before running dev:watch, or use a different KIKX_PORT.`);

  console.log('[dev-watch] Starting Kikx...');
  currentChild = spawn(START_COMMAND[0], START_COMMAND[1], {
    cwd: process.cwd(),
    detached: true,
    env: process.env,
    stdio: 'inherit',
  });
  let child = currentChild;
  child.unref();

  child.on('exit', (code, signal) => {
    if (!shuttingDown && !child._devWatchStopping) {
      console.log(`[dev-watch] Kikx process exited${signal ? ` from ${signal}` : ` with code ${code}`}`);
    }
  });

  await waitForHealth(healthURL, child);
  console.log(`[dev-watch] Kikx ready at ${healthURL.replace(/\/health$/u, '')}`);
}

async function stopChild(child, options = {}) {
  if (!child || child.exitCode != null)
    return;

  console.log(`[dev-watch] Stopping Kikx process group ${child.pid}...`);
  child._devWatchStopping = true;
  signalChildGroup(child, 'SIGTERM');

  if (!options.force && await waitForExit(child, 3000))
    return;

  signalChildGroup(child, 'SIGKILL');
  await waitForExit(child, 1000);
}

function signalChildGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH')
      throw error;
  }
}

function waitForExit(child, timeoutMS) {
  if (child.exitCode != null)
    return true;

  return new Promise((resolve) => {
    let timeout = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMS);
    timeout.unref?.();

    function onExit() {
      clearTimeout(timeout);
      resolve(true);
    }

    child.once('exit', onExit);
  });
}

async function waitForHealth(healthURL, child = null) {
  let deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child?.exitCode != null)
      throw new Error(`Kikx exited before passing health check at ${healthURL}`);

    try {
      if (await isHealthy(healthURL))
        return;
    } catch (_error) {
      // Keep polling until the process either serves health or the deadline expires.
    }

    await sleep(250);
  }

  throw new Error(`Kikx did not pass health check at ${healthURL} within 30s`);
}

async function isHealthy(healthURL) {
  let response = await fetch(healthURL);
  return response.ok;
}

async function cleanup(signal) {
  if (shuttingDown)
    return;

  shuttingDown = true;
  await stopChild(currentChild);
  process.exit(0);
}

function parseWatchEntries(value) {
  if (!value)
    return DEFAULT_WATCH_ENTRIES.slice();

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
