#!/usr/bin/env node
'use strict';

const DEFAULT_KIKX_URL = 'http://127.0.0.1:3000';
const DEFAULT_EMAIL = 'wegreenway@taraani.org';

async function main() {
  let args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  let email = args[0] || process.env.KIKX_LOGIN_EMAIL || DEFAULT_EMAIL;

  let baseURL = (process.env.KIKX_URL || DEFAULT_KIKX_URL).replace(/\/+$/g, '');
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

  let message = body?.data?.message || 'Magic link requested.';
  console.log(message);
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
    `  KIKX_LOGIN_EMAIL  Email address if not passed as an argument. Default: ${DEFAULT_EMAIL}`,
  ].join('\n'));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
