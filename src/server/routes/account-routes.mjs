'use strict';

import { readJSON, writeJSON } from '../http-helpers.mjs';

export async function handleAccountRoutes({ request, response, url, context }) {
  if (request.method === 'GET' && url.pathname === '/api/v1/account') {
    let accountStore = context.require('accountStore');
    let identity = await accountStore.resolveIdentity(request);
    writeJSON(response, 200, {
      data: {
        account: await accountStore.getAccount(identity),
      },
    });
    return true;
  }

  if (request.method === 'PATCH' && url.pathname === '/api/v1/account') {
    let body = await readJSON(request);
    let accountStore = context.require('accountStore');
    let identity = await accountStore.resolveIdentity(request);
    writeJSON(response, 200, {
      data: {
        account: await accountStore.updateAccount(identity, body),
      },
    });
    return true;
  }

  return false;
}
