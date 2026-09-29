'use strict';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function findControlPath() {
  if (process.env.UMBRAFOX_CONTROL_JSON)
    return process.env.UMBRAFOX_CONTROL_JSON;

  let base = path.join(os.homedir(), '.config', 'umbrafox', 'umbrafox');
  return base;
}

async function readControl() {
  let explicit = process.env.UMBRAFOX_CONTROL_JSON;
  if (explicit)
    return JSON.parse(await fs.readFile(explicit, 'utf8'));

  let base = findControlPath();
  let profiles = await fs.readdir(base, { withFileTypes: true });
  for (let entry of profiles) {
    if (!entry.isDirectory())
      continue;

    let candidate = path.join(base, entry.name, 'umbrafox', 'control.json');
    try {
      return JSON.parse(await fs.readFile(candidate, 'utf8'));
    } catch (_error) {}
  }

  throw new Error('UmbraLink control.json not found');
}

async function call(control, method, params = {}, timeoutMs = 30000) {
  let socket = new WebSocket(control.websocketUrl);

  return await new Promise((resolve, reject) => {
    let id = 1;
    let timer = setTimeout(() => {
      try { socket.close(); } catch (_error) {}
      reject(new Error(`UmbraLink ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id, method, params }));
    });

    socket.addEventListener('message', (event) => {
      clearTimeout(timer);
      let payload;
      try {
        payload = JSON.parse(String(event.data));
      } catch (error) {
        reject(new Error(`Malformed UmbraLink response: ${error.message}`));
        return;
      }

      try { socket.close(); } catch (_error) {}
      if (payload.error)
        reject(new Error(`${payload.error.code}: ${payload.error.message}`));
      else
        resolve(payload.result);
    });

    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`UmbraLink ${method} connection error`));
    });
  });
}

let method = process.argv[2];
let paramsArg = process.argv[3];
let params = paramsArg ? JSON.parse(paramsArg) : {};

let control = await readControl();
let result = await call(control, method, params);
console.log(JSON.stringify(result, null, 2));
