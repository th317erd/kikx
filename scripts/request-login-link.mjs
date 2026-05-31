#!/usr/bin/env node
'use strict';

import fs from 'node:fs/promises';

await loadEnvFile(process.env.KIKX_ENV_FILE || '.env.dev');

const DEFAULT_KIKX_HOST = process.env.KIKX_HOST || '127.0.0.1';
const DEFAULT_KIKX_PORT = process.env.KIKX_PORT || 3000;
const DEFAULT_KIKX_URL = `http://${DEFAULT_KIKX_HOST}:${DEFAULT_KIKX_PORT}`;
const DEFAULT_EMAIL = 'wegreenway@taraani.org';
const DEFAULT_AEORDB_LOG_PATH = '/tmp/codex/kikx/aeordb.log';
const DEFAULT_LINK_TIMEOUT_MS = 3000;

async function main() {
  let args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  let email = args[0] || process.env.KIKX_LOGIN_EMAIL || DEFAULT_EMAIL;

  let baseURL = (process.env.KIKX_URL || DEFAULT_KIKX_URL).replace(/\/+$/g, '');
  let publicURL = (process.env.KIKX_PUBLIC_URL || baseURL).replace(/\/+$/g, '');
  let aeorDBLogPath = process.env.AEORDB_LOG_PATH || DEFAULT_AEORDB_LOG_PATH;
  let logOffset = await fileSize(aeorDBLogPath);
  let response;

  try {
    response = await fetch(`${baseURL}/api/v1/auth/magic-link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email }),
    });
  } catch (error) {
    throw new Error(`Unable to reach Kikx at ${baseURL}: ${error.message}`);
  }

  let body = await readJSON(response);
  if (!response.ok)
    throw new Error(body?.error?.message || `Kikx returned HTTP ${response.status}`);

  let link = await waitForLoginLink({
    logPath: aeorDBLogPath,
    offset: logOffset,
    publicURL,
    timeoutMS: Number.parseInt(process.env.LOGIN_LINK_TIMEOUT_MS || `${DEFAULT_LINK_TIMEOUT_MS}`, 10),
  });

  console.log(link);
}

async function readJSON(response) {
  let text = await response.text();
  if (!text)
    return null;

  try {
    return JSON.parse(text);
  } catch (_error) {
    throw new Error(`Kikx returned a non-JSON response with HTTP ${response.status}`);
  }
}

function printUsage() {
  console.log([
    'Usage: npm run login-link -- <email>',
    '',
    'Environment:',
    `  KIKX_URL          Kikx server URL. Default: ${DEFAULT_KIKX_URL}`,
    `  KIKX_PUBLIC_URL   Public browser URL for generated links. Default: KIKX_URL`,
    `  KIKX_LOGIN_EMAIL  Email address if not passed as an argument. Default: ${DEFAULT_EMAIL}`,
    `  AEORDB_LOG_PATH   AeorDB log to scan for dev magic links. Default: ${DEFAULT_AEORDB_LOG_PATH}`,
    `  LOGIN_LINK_TIMEOUT_MS  How long to wait for the AeorDB log line. Default: ${DEFAULT_LINK_TIMEOUT_MS}`,
    '',
    'AeorDB must be started with AEORDB_LOG_MAGIC_LINKS=1 for this dev script to print a link.',
  ].join('\n'));
}

async function waitForLoginLink({ logPath, offset, publicURL, timeoutMS }) {
  let deadline = Date.now() + timeoutMS;

  while (Date.now() <= deadline) {
    let text = await readFileSlice(logPath, offset);
    let code = extractMagicLinkCode(text);
    if (code)
      return `${publicURL}/?code=${encodeURIComponent(code)}`;

    await sleep(100);
  }

  throw new Error([
    'Magic link was requested, but no dev login link appeared in the AeorDB log.',
    'Restart AeorDB with AEORDB_LOG_MAGIC_LINKS=1 and make sure AEORDB_LOG_PATH points to its log file.',
  ].join(' '));
}

function extractMagicLinkCode(text) {
  let patterns = [
    /\/auth\/magic-link\/verify\?code=([^"'\s,}]+)/,
    /magic_link_url=[^?]*\?code=([^"'\s,}]+)/,
    /code=([^"'\s,}]+)/,
  ];

  for (let pattern of patterns) {
    let match = pattern.exec(text);
    if (match)
      return decodeURIComponent(match[1]);
  }

  return '';
}

async function readFileSlice(path, offset) {
  try {
    let handle = await fs.open(path, 'r');
    try {
      let stats = await handle.stat();
      if (stats.size <= offset)
        return '';

      let length = stats.size - offset;
      let buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === 'ENOENT')
      return '';

    throw error;
  }
}

async function fileSize(path) {
  try {
    let stats = await fs.stat(path);
    return stats.size;
  } catch (error) {
    if (error.code === 'ENOENT')
      return 0;

    throw error;
  }
}

async function loadEnvFile(path) {
  try {
    let text = await fs.readFile(path, 'utf8');
    for (let line of text.split(/\r?\n/g)) {
      line = line.trim();
      if (!line || line.startsWith('#'))
        continue;

      let index = line.indexOf('=');
      if (index < 1)
        continue;

      let key = line.slice(0, index).trim();
      let value = line.slice(index + 1).trim();

      if (!(key in process.env))
        process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
