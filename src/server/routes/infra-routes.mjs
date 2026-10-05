'use strict';

import {
  parseBoolean,
  parseOptionalNonNegativeInteger,
  parseOptionalPositiveInteger,
  totalTokensUsed,
  writeJSON,
} from '../http-helpers.mjs';
import { matchToolOutputRoute } from './route-matchers.mjs';
import { streamRuntimeEvents } from '../events.mjs';

const DEFAULT_TOOL_OUTPUT_API_BYTES = 128 * 1024;

export async function handleInfraRoutes({ request, response, url, context }) {
  if (request.method === 'GET' && url.pathname === '/health') {
    // `ready` is false until startup recovery and the scheduled-frame worker
    // have settled, so probes (and the deploy verifier) never observe the
    // window before persisted scheduled frames are loaded.
    writeJSON(response, 200, {
      ok: true,
      ready: context.get?.('startupReady') === true,
      services: {
        aeordb: context.has('aeordb'),
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
    streamRuntimeEvents({ request, response, frameRuntime, sessionID: url.searchParams.get('sessionID') || '' });
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
