'use strict';

import fs from 'node:fs';
import { spawn } from 'node:child_process';

import { createParentExitMonitor } from './parent-exit-monitor.mjs';

loadEnvFile('.env.dev');

let aeorDBURL = process.env.AEORDB_URL || 'http://127.0.0.1:6830';
let rootKey = process.env.AEORDB_ROOT_KEY || '';
let shuttingDown = false;

if (rootKey) {
  let response = await fetch(new URL('/auth/token', aeorDBURL), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ api_key: rootKey }),
  });
  let body = await response.json().catch(() => ({}));

  if (!response.ok || !body.token)
    throw new Error(body?.error || body?.message || `Unable to exchange AeorDB root key: HTTP ${response.status}`);

  process.env.AEORDB_TOKEN = body.token;
}

let child = spawn(process.execPath, [ 'src/server/index.mjs' ], {
  stdio: 'inherit',
  env: process.env,
});
let parentMonitor = createParentExitMonitor({
  onParentExit: ({ parentPID, currentParentPID }) => {
    console.error(`Kikx dev wrapper parent ${parentPID} exited; current parent is ${currentParentPID}. Shutting down Kikx.`);
    shutdown('SIGTERM');
  },
});

for (let signal of [ 'SIGINT', 'SIGTERM' ]) {
  process.on(signal, () => {
    shutdown(signal);
  });
}

child.on('exit', (code, signal) => {
  parentMonitor.stop();
  if (shuttingDown) {
    process.exit(code ?? 0);
    return;
  }

  if (signal)
    process.kill(process.pid, signal);
  else
    process.exit(code ?? 0);
});

function shutdown(signal) {
  if (shuttingDown)
    return;

  shuttingDown = true;
  parentMonitor.stop();
  child.kill(signal);
}

function loadEnvFile(path) {
  if (!fs.existsSync(path))
    return;

  let text = fs.readFileSync(path, 'utf8');
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
}
