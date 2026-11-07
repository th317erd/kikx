'use strict';

import {
  getRequestAccount,
  parseBoolean,
  parseOptionalNonNegativeInteger,
  parseOptionalPositiveInteger,
  readJSON,
  totalTokensUsed,
  writeJSON,
} from '../http-helpers.mjs';
import { matchToolOutputRoute } from './route-matchers.mjs';
import { streamRuntimeEvents, writeSSE } from '../events.mjs';
import { createScrollTelemetryStore } from '../scroll-telemetry-store.mjs';

const DEFAULT_TOOL_OUTPUT_API_BYTES = 128 * 1024;

function scrollTelemetryStore(context) {
  if (!context.has('scrollTelemetryStore'))
    context.set('scrollTelemetryStore', createScrollTelemetryStore());
  return context.require('scrollTelemetryStore');
}

export async function handleInfraRoutes({ request, response, url, context }) {
  // Scroll telemetry (owner ask, 2026-11-07): authenticated batch ingest in,
  // SSE tail out — the agent watches page-loads/writes/focal offsets stream
  // while the owner reproduces the scroll jump. Auth first: diagnostics of a
  // real session still disclose message ids and layout.
  if (url.pathname === '/api/v1/debug/scroll-events') {
    let account = await getRequestAccount(context, request);
    if (!account) {
      writeJSON(response, 401, { error: { message: 'Sign in required for scroll telemetry' } });
      return true;
    }

    let store = scrollTelemetryStore(context);

    if (request.method === 'POST') {
      let body = await readJSON(request); // hard-capped at 1MB by http-helpers
      let events = Array.isArray(body?.events) ? body.events : [];
      let result = store.record(events);
      writeJSON(response, 202, { data: result });
      return true;
    }

    if (request.method === 'GET') {
      let since = Number.parseInt(url.searchParams.get('since') ?? '0', 10);
      if (!Number.isFinite(since) || since < 0)
        since = 0;
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      writeSSE(response, 'connected', { ok: true, since, latest: store.latest() });
      for (let event of store.since(since))
        writeSSE(response, 'scroll', event);
      let unsubscribe = store.subscribe((event) => writeSSE(response, 'scroll', event));
      let heartbeat = setInterval(() => writeSSE(response, 'ping', { t: Date.now() }), 15000);
      let cleanup = () => {
        unsubscribe();
        clearInterval(heartbeat);
      };
      response.on('close', cleanup);
      response.on('error', cleanup);
      return true; // held open: the caller must not end the response
    }

    writeJSON(response, 405, { error: { message: 'GET or POST only' } });
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/health') {
    // `ready` is false until startup recovery and the scheduled-frame worker
    // have settled, so probes (and the deploy verifier) never observe the
    // window before persisted scheduled frames are loaded.
    writeJSON(response, 200, {
      ok: true,
      ready: context.get?.('startupReady') === true,
      // Instance identity for the fleet view (owner task, 2026-11-07): one
      // memoized string — KIKX_VERSION, else git short hash (+dirty), else
      // 'unknown'. Unauthenticated like the rest of /health: it is a deploy
      // verifier surface and carries no secret.
      version: (await import('../version.mjs')).resolveKikxVersion(),
      services: {
        // Driver-neutral: PostgreSQL in the default deployment, AeorDB only as
        // a legacy driver. Reads the canonical `db` slot; `aeordb` is a mirror of
        // it (create-server.mjs) and naming it here made the payload read as if
        // AeorDB were the live service.
        database: context.has('db'),
      },
      // Compact summary only (no sample ring) so the probe stays cheap. Absent
      // when the server was composed without the sampler.
      memory: context.has('memorySampler')
        ? context.require('memorySampler').snapshot()
        : null,
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/infra/memory') {
    // Same unauthenticated infra surface as `/health` (deploy verifier). The
    // ring is only returned when `?samples=1`, so routine calls stay bounded.
    let sampler = context.has('memorySampler') ? context.require('memorySampler') : null;
    let includeSamples = parseBoolean(url.searchParams.get('samples'), false);
    writeJSON(response, 200, {
      data: {
        memory: sampler
          ? sampler.snapshot({ includeSamples })
          : { enabled: false, running: false, sampleCount: 0, warningCount: 0, latest: null, samples: [] },
      },
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/aeordb/events-url') {
    let aeordb = context.require('aeordb');
    writeJSON(response, 200, {
      data: {
        url: aeordb.eventsURL({
          events: url.searchParams.get('events'),
          path_prefix: url.searchParams.get('path_prefix'),
        }),
      },
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/tokens') {
    let tokenUsage = context.require('tokenUsage');
    let snapshot = typeof tokenUsage.snapshot === 'function' ? tokenUsage.snapshot() : {};
    writeJSON(response, 200, {
      data: {
        tokenUsage: snapshot,
        totalTokensUsed: typeof tokenUsage.totalTokensUsed === 'function'
          ? tokenUsage.totalTokensUsed()
          : totalTokensUsed(snapshot),
      },
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/events') {
    let frameRuntime = context.require('frameRuntime');
    streamRuntimeEvents({
      request,
      response,
      frameRuntime,
      eventGateway: context.has('runtimeEventGateway') ? context.require('runtimeEventGateway') : null,
      sessionID: url.searchParams.get('sessionID') || '',
      coalesce: true,
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/client-components') {
    let pluginRegistry = context.require('pluginRegistry');
    writeJSON(response, 200, {
      data: {
        components: typeof pluginRegistry.listClientComponentDescriptors === 'function'
          ? pluginRegistry.listClientComponentDescriptors()
          : [],
      },
    });
    return true;
  }

  let toolOutputRoute = matchToolOutputRoute(url.pathname);
  if (request.method === 'GET' && toolOutputRoute) {
    let toolOutputStore = context.require('toolOutputStore');
    let full = parseBoolean(url.searchParams.get('full'), false);
    let output = await toolOutputStore.getToolOutput({
      id: toolOutputRoute.outputID,
      start: parseOptionalNonNegativeInteger(url.searchParams.get('start')),
      end: parseOptionalPositiveInteger(url.searchParams.get('end')),
      maxBytes: full
        ? null
        : parseOptionalPositiveInteger(url.searchParams.get('maxBytes')) || DEFAULT_TOOL_OUTPUT_API_BYTES,
    });

    writeJSON(response, 200, {
      data: {
        output,
      },
    });
    return true;
  }

  return false;
}
