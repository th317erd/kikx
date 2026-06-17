'use strict';

import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';

import { createParentExitMonitor } from './parent-exit-monitor.mjs';

loadEnvFile('.env.dev');

let aeorDBURL = new URL(process.env.AEORDB_URL || 'http://127.0.0.1:6830');
let aeorDBHost = process.env.AEORDB_HOST || aeorDBURL.hostname || '127.0.0.1';
let aeorDBPort = Number.parseInt(process.env.AEORDB_PORT || aeorDBURL.port || '6830', 10);
let kikxHost = process.env.KIKX_HOST || '127.0.0.1';
let kikxPort = Number.parseInt(process.env.KIKX_PORT || '3000', 10);
let children = [];
let shuttingDown = false;
let parentMonitor = null;

if (!(await isListening(aeorDBHost, aeorDBPort))) {
  startChild('AeorDB', [ 'run', 'start:aeordb:dev' ]);
} else {
  console.log(`AeorDB already listening on ${aeorDBHost}:${aeorDBPort}`);
}
await waitForAeorDBReady(aeorDBURL);

if (!(await isListening(kikxHost, kikxPort))) {
  startChild('Kikx', [ 'run', 'start:kikx:dev' ]);
  await waitForListening('Kikx', kikxHost, kikxPort);
} else {
  console.log(`Kikx already listening on ${kikxHost}:${kikxPort}`);
}

console.log(`Dev stack ready: http://${kikxHost}:${kikxPort}`);

if (children.length === 0)
  process.exit(0);

parentMonitor = createParentExitMonitor({
  onParentExit: ({ parentPID, currentParentPID }) => {
    console.error(`Dev stack parent ${parentPID} exited; current parent is ${currentParentPID}. Shutting down child processes.`);
    shutdown('SIGTERM');
  },
});

for (let signal of [ 'SIGINT', 'SIGTERM' ])
  process.on(signal, () => shutdown(signal));

process.stdin.resume();

function startChild(name, args) {
  let child = spawn('npm', args, {
    stdio: 'inherit',
    detached: true,
    env: process.env,
  });

  children.push({ name, child });
  child.on('exit', (code, signal) => {
    children = children.filter((entry) => entry.child !== child);
    if (!shuttingDown && code !== 0) {
      console.error(`${name} exited unexpectedly${signal ? ` from ${signal}` : ` with code ${code}`}`);
      shutdown('SIGTERM');
    }
  });
}

async function shutdown(signal) {
  if (shuttingDown)
    return;

  shuttingDown = true;
  parentMonitor?.stop();
  let active = children.slice();
  for (let { child } of active)
    signalChildGroup(child, signal);

  await Promise.all(active.map(({ child }) => waitForExit(child)));
  process.exit(0);
}

function signalChildGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH')
      throw error;
  }
}

function waitForExit(child) {
  if (child.exitCode != null || child.signalCode != null)
    return Promise.resolve();

  return new Promise((resolve) => child.once('exit', resolve));
}

async function waitForListening(name, host, port) {
  let deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await isListening(host, port)) {
      console.log(`${name} listening on ${host}:${port}`);
      return;
    }

    await sleep(250);
  }

  throw new Error(`${name} did not start listening on ${host}:${port} within 30s`);
}

async function waitForAeorDBReady(baseURL) {
  let deadline = Date.now() + 120000;
  let lastStatus = '';

  while (Date.now() < deadline) {
    let health = await getAeorDBHealth(baseURL);
    if (health?.status === 'healthy') {
      console.log(`AeorDB healthy at ${new URL('/system/health', baseURL)}`);
      return;
    }

    if (health?.status === 'failed')
      throw new Error(`AeorDB startup failed: ${health.message || 'unknown failure'}`);

    let status = describeAeorDBHealth(health);
    if (status !== lastStatus) {
      console.log(`AeorDB not ready yet: ${status}`);
      lastStatus = status;
    }

    await sleep(500);
  }

  throw new Error(`AeorDB did not report healthy at ${new URL('/system/health', baseURL)} within 120s`);
}

async function getAeorDBHealth(baseURL) {
  try {
    let response = await fetch(new URL('/system/health', baseURL));
    return await response.json();
  } catch (_error) {
    return null;
  }
}

function describeAeorDBHealth(health) {
  if (!health)
    return 'not reachable';

  let parts = [ String(health.status || 'unknown') ];
  if (health.phase)
    parts.push(String(health.phase));
  if (typeof health.progress === 'number')
    parts.push(`${Math.round(health.progress * 100)}%`);

  return parts.join(' ');
}

function isListening(host, port) {
  return new Promise((resolve) => {
    let socket = net.createConnection({ host, port });
    socket.setTimeout(500);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
