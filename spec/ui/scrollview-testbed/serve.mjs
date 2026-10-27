'use strict';

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const AEOR_ROOT = process.env.AEOR_ROOT || '/home/wyatt/Projects/aeor-web-components';
const PORT = Number(process.env.PORT || 3110);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};

async function serveFile(response, filePath) {
  try {
    let body = await fs.readFile(filePath);
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    response.end(body);
  } catch (_error) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}

function resolveWithin(root, relative) {
  let candidate = path.resolve(root, relative);
  let rel = path.relative(path.resolve(root), candidate);
  return !rel.startsWith('..') && !path.isAbsolute(rel) ? candidate : null;
}

let server = http.createServer(async (request, response) => {
  let url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/vendor/')) {
    let file = resolveWithin(AEOR_ROOT, url.pathname.slice('/vendor/'.length));
    await serveFile(response, file || path.join(AEOR_ROOT, '__missing__'));
    return;
  }
  let pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  let file = resolveWithin(ROOT, pathname.slice(1));
  await serveFile(response, file || path.join(ROOT, '__missing__'));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`scrollview testbed: http://127.0.0.1:${PORT}/`);
});
