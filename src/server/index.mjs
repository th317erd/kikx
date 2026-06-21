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
  await shutdownRuntimeServices(server);
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

async function shutdownRuntimeServices(server) {
  let context = server.kikxContext;
  if (!context)
    return;

  try {
    await context.require?.('processManager')?.shutdown?.({
      signal: 'SIGTERM',
      forceSignal: 'SIGKILL',
      forceAfterMS: 1000,
      timeoutMS: 3000,
    });
  } catch (error) {
    console.error('Kikx process manager shutdown failed:', error);
  }

  try {
    await withTimeout(context.require?.('frameRouter')?.flush?.({ background: true }), 1000);
    await withTimeout(context.require?.('frameRuntime')?.frameStore?.flush?.(), 1000);
  } catch (error) {
    console.error('Kikx runtime drain failed:', error);
  }

  try {
    context.require?.('frameRuntime')?.disconnect?.();
  } catch (error) {
    console.error('Kikx frame runtime shutdown failed:', error);
  }
}

async function withTimeout(promise, timeoutMS) {
  if (!promise)
    return null;

  let timeout;
  return await Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMS}ms`)), timeoutMS);
      timeout.unref?.();
    }),
  ]).finally(() => clearTimeout(timeout));
}
