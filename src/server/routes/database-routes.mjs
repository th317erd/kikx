'use strict';

import { writeJSON } from '../http-helpers.mjs';

// First-class database-driver selection surface, mirroring
// `/api/v1/agent-providers`. Read-only and unauthenticated like that route: the
// registry holds every installed driver (its descriptor is static, so listing
// never requires a live connection), and `active` names the driver this server
// resolved and connected at boot.
export async function handleDatabaseRoutes({ request, response, url, context }) {
  if (request.method === 'GET' && url.pathname === '/api/v1/database-drivers') {
    let pluginRegistry = context.require('pluginRegistry');
    writeJSON(response, 200, {
      data: {
        drivers: await pluginRegistry.listDatabaseDriverDescriptors(),
        active: activeDriverID(context),
      },
    });
    return true;
  }

  return false;
}

// The active driver is recorded by createServer as `databaseDriverID`. Hosts and
// tests that inject a ready connection directly skip that bookkeeping, so fall
// back to the connection's own static `driverID` before reporting null.
function activeDriverID(context) {
  let driverID = context.get('databaseDriverID');
  if (driverID)
    return driverID;

  if (context.has('db')) {
    let db = context.get('db');
    return db?.constructor?.driverID || null;
  }

  return null;
}
