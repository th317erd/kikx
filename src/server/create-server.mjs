'use strict';

import http from 'node:http';

import { AppContext } from '../core/app/app-context.mjs';
import { AeorDBClient } from '../core/aeordb/aeordb-client.mjs';

export function createServer(options = {}) {
  let context = options.context || new AppContext();

  if (!context.has('aeordb')) {
    context.set('aeordb', new AeorDBClient({
      baseURL: options.aeorDBURL || process.env.AEORDB_URL || 'http://127.0.0.1:6830',
      token: options.aeorDBToken || process.env.AEORDB_TOKEN || '',
      fetchImpl: options.fetchImpl || globalThis.fetch,
    }));
  }

  return http.createServer(async (request, response) => {
    try {
      await routeRequest({ request, response, context });
    } catch (error) {
      writeJSON(response, error.status || 500, {
        error: {
          message: error.message || 'Internal Server Error',
        },
      });
    }
  });
}

async function routeRequest({ request, response, context }) {
  let url = new URL(request.url, 'http://localhost');

  if (request.method === 'GET' && url.pathname === '/health') {
    writeJSON(response, 200, {
      ok: true,
      services: {
        aeordb: context.has('aeordb'),
      },
    });
    return;
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
    return;
  }

  writeJSON(response, 404, {
    error: {
      message: 'Not Found',
    },
  });
}

function writeJSON(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

