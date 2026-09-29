'use strict';

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SPIKE_PORT || 8899);
const OUT = process.env.SPIKE_OUT || path.join(ROOT, 'spike-results-umbrafox.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

let resolveReport;
let reportPromise = new Promise((resolve) => {
  resolveReport = resolve;
});

let server = http.createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/report') {
    let chunks = [];
    for await (let chunk of request)
      chunks.push(chunk);

    let payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    await fs.writeFile(OUT, JSON.stringify(payload, null, 2));
    response.writeHead(204).end();
    resolveReport(payload);
    return;
  }

  let url = new URL(request.url, 'http://localhost');
  let filePath = path.join(ROOT, url.pathname === '/' ? '/index.html' : url.pathname);

  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403).end('forbidden');
    return;
  }

  try {
    let body = await fs.readFile(filePath);
    response.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    response.end(body);
  } catch (_error) {
    response.writeHead(404).end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`spike collector on http://127.0.0.1:${PORT}`);
  console.log(`suite URL: http://127.0.0.1:${PORT}/?suite=1&cards=${process.env.SPIKE_CARDS || 30}&hz=${process.env.SPIKE_HZ || 10}`);
});

// Auto-exit once a report arrives (or after a hard timeout).
let hardTimeout = setTimeout(() => {
  console.error('no report received before timeout');
  process.exit(2);
}, Number(process.env.SPIKE_TIMEOUT_MS || 120000));
hardTimeout.unref?.();

reportPromise.then((payload) => {
  clearTimeout(hardTimeout);
  console.log(JSON.stringify(payload, null, 2));
  server.close(() => process.exit(0));
});
