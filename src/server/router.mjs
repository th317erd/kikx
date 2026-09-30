'use strict';

import { writeJSON } from './http-helpers.mjs';
import { serveStaticRequest } from './static-files.mjs';
import { handleInfraRoutes } from './routes/infra-routes.mjs';
import { handleAccountRoutes } from './routes/account-routes.mjs';
import { handleSessionRoutes } from './routes/session-routes.mjs';
import { handleAgentRoutes } from './routes/agent-routes.mjs';
import { handleTeamRoutes } from './routes/team-routes.mjs';
import { handleAuthRoutes } from './routes/auth-routes.mjs';

export async function routeRequest({ request, response, context, staticRoots }) {
  if (context.has('pluginLoadPromise'))
    await context.require('pluginLoadPromise');

  if (context.has('tokenUsageLoadPromise'))
    await context.require('tokenUsageLoadPromise');

  let url = new URL(request.url, 'http://localhost');

  let handlers = [
    handleInfraRoutes,
    handleAccountRoutes,
    handleSessionRoutes,
    handleAgentRoutes,
    handleTeamRoutes,
    handleAuthRoutes,
  ];

  for (let handler of handlers) {
    let handled = await handler({ request, response, url, context });
    if (handled)
      return;
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    let handled = await serveStaticRequest({ request, response, url, staticRoots });
    if (handled)
      return;
  }

  writeJSON(response, 404, {
    error: {
      message: 'Not Found',
    },
  });
}
