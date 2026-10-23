'use strict';

import { createConfigStore, KIKX_HOST_PATH, KIKX_PORT_PATH } from '../core/config/index.mjs';
import { createServer } from './create-server.mjs';
import { installProcessErrorPolicy } from './process-error-policy.mjs';
import { shutdownHTTPServer } from './shutdown.mjs';

const TOOL_INFLIGHT_SHUTDOWN_GRACE_MS = 30_000;
const CHILD_PROCESS_SHUTDOWN_GRACE_MS = 30_000;
const CHILD_PROCESS_SHUTDOWN_TIMEOUT_MS = 35_000;

let shuttingDown = false;
let server;

// Install the process error policy before anything else: a throw during startup
// must follow the same log-then-shutdown path as one under load. Rejections are
// logged but never terminate the server (a single stray promise must not drop
// every connected client); an uncaught exception drains and exits non-zero.
installProcessErrorPolicy({
  processRef: process,
  logger: console,
  onFatal: (error, type) => {
    if (type !== 'uncaughtException')
      return;

    console.error('Kikx shutting down after uncaughtException:', error);
    shutdown('uncaughtException', 1)
      .catch((shutdownError) => console.error('Kikx shutdown failed after uncaughtException:', shutdownError))
      .finally(() => process.exit(1));
  },
});

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

  // Wait for the best-effort auth bootstrap so the first-run admin magic link is
  // logged before the port opens (it never rejects; failures are swallowed).
  await server.kikxContext?.get?.('authBootstrapPromise');

  server.listen(port, host, () => {
    console.log(`Kikx listening on http://${host}:${port}`);
  });
}

await main();

async function shutdown(signal, exitCode = 0) {
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

  process.exit(exitCode);
}

async function shutdownRuntimeServices(server) {
  let context = server.kikxContext;
  if (!context)
    return;

  // Set the global signal first. Any tool request that has not durably marked
  // itself as started will stay pending for boot recovery instead of starting
  // during shutdown.
  let shutdownState = context.require?.('toolShutdownState') || null;
  try {
    shutdownState?.begin?.();
  } catch (error) {
    console.error('Kikx tool shutdown signal failed:', error);
  }

  // Start asking managed command children to terminate while we await the
  // in-process tool executions. Both drains share the same wall-clock window.
  let processShutdown = Promise.resolve().then(async () => {
    if (typeof context.require?.('processManager')?.shutdown !== 'function')
      return null;
    return await context.require('processManager').shutdown({
      signal: 'SIGTERM',
      forceSignal: 'SIGKILL',
      forceAfterMS: CHILD_PROCESS_SHUTDOWN_GRACE_MS,
      timeoutMS: CHILD_PROCESS_SHUTDOWN_TIMEOUT_MS,
    });
  }).catch((error) => {
    console.error('Kikx process manager shutdown failed:', error);
    return null;
  });

  try {
    let result = shutdownState
      ? await shutdownState.waitForInflight({ timeoutMS: TOOL_INFLIGHT_SHUTDOWN_GRACE_MS })
      : { timedOut: false, remaining: [], waitedMS: 0 };
    if (result.timedOut || result.remaining.length > 0) {
      console.error(`Kikx shutdown left ${result.remaining.length} tool call(s) in flight after ${TOOL_INFLIGHT_SHUTDOWN_GRACE_MS}ms`);
      let remaining = shutdownState.abandonRemaining?.() || result.remaining;
      await context.require?.('toolExecutor')?.failInterruptedToolCalls?.(remaining, {
        message: 'Execution interrupted. Command was NOT completed successfully.',
      });
    }
  } catch (error) {
    console.error('Kikx tool-call drain failed:', error);
  }

  try {
    let result = await processShutdown;
    if (result?.remaining > 0)
      console.error(`Kikx shutdown left ${result.remaining} child process(es) running after ${CHILD_PROCESS_SHUTDOWN_TIMEOUT_MS}ms`);
  } catch (error) {
    console.error('Kikx child-process drain failed:', error);
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

  try {
    await context.require?.('db')?.close?.();
  } catch (error) {
    console.error('Kikx database shutdown failed:', error);
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
