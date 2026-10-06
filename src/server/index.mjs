'use strict';

import { createConfigStore, KIKX_HOST_PATH, KIKX_PORT_PATH } from '../core/config/index.mjs';
import { createServer } from './create-server.mjs';
import { shutdownHTTPServer } from './shutdown.mjs';

let shuttingDown = false;
let server;

// Register handlers before `main()` runs so a signal during startup cannot kill
// the process before shutdown wiring exists. `shutdown()` is a no-op until the
// server is assigned.
for (let signal of [ 'SIGINT', 'SIGTERM' ]) {
  process.on(signal, () => {
    shutdown(signal).catch((error) => {
      console.error(`Kikx shutdown failed after ${signal}:`, error);
      process.exit(1);
    });
  });
}

async function main() {
  let config = await createConfigStore({});
  let host = await config.get(KIKX_HOST_PATH) || '127.0.0.1';
  let port = Number.parseInt(await config.get(KIKX_PORT_PATH) || '3000', 10);
  server = await createServer({ config });

  server.listen(port, host, () => {
    console.log(`Kikx listening on http://${host}:${port}`);
  });
}

await main();

async function shutdown(signal) {
  if (shuttingDown || !server)
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
