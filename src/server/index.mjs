'use strict';

import { createServer } from './create-server.mjs';
import { shutdownHTTPServer } from './shutdown.mjs';

let host = process.env.KIKX_HOST || '127.0.0.1';
let port = Number.parseInt(process.env.KIKX_PORT || '3000', 10);
let shuttingDown = false;

let server = createServer();

server.listen(port, host, () => {
  console.log(`Kikx listening on http://${host}:${port}`);
});

for (let signal of [ 'SIGINT', 'SIGTERM' ]) {
  process.on(signal, () => {
    shutdown(signal).catch((error) => {
      console.error(`Kikx shutdown failed after ${signal}:`, error);
      process.exit(1);
    });
  });
}

async function shutdown(signal) {
  if (shuttingDown)
    return;

  shuttingDown = true;
  let result = await shutdownHTTPServer(server);

  if (result.error) {
    console.error(`Kikx shutdown failed after ${signal}:`, result.error);
    process.exit(1);
  }

  if (result.timedOut) {
    console.error(`Kikx shutdown timed out after ${signal}`);
    process.exit(1);
  }

  process.exit(0);
}
