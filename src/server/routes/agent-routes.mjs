'use strict';

import {
  httpError,
  parseNonNegativeInteger,
  parsePositiveInteger,
  readJSON,
  writeJSON,
} from '../http-helpers.mjs';
import { matchAgentCompactionCrownRoute, matchAgentCrownRoute, matchAgentRoute } from './route-matchers.mjs';
import { validateAgentBody } from './validators.mjs';

export async function handleAgentRoutes({ request, response, url, context }) {
  if (request.method === 'GET' && url.pathname === '/api/v1/agent-providers') {
    let agentManager = context.require('agentManager');
    writeJSON(response, 200, {
      data: {
        providers: await agentManager.listProviders(),
      },
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/models') {
    let agentManager = context.require('agentManager');
    writeJSON(response, 200, {
      data: {
        models: agentManager.listModels(),
      },
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/agents') {
    let agentManager = context.require('agentManager');
    writeJSON(response, 200, {
      data: {
        agents: await agentManager.listAgents({
          limit: parsePositiveInteger(url.searchParams.get('limit'), 50),
          offset: parseNonNegativeInteger(url.searchParams.get('offset'), 0),
        }),
      },
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/agents') {
    let body = await readJSON(request);
    validateAgentBody(body, { creating: true });

    let agentManager = context.require('agentManager');
    writeJSON(response, 201, {
      data: {
        agent: await agentManager.createAgent(body),
      },
    });
    return true;
  }

  // Master agents (crowned), best first. Optionally resolve the effective
  // default, skipping excluded agents (e.g. ones that just errored).
  if (request.method === 'GET' && url.pathname === '/api/v1/agents/masters') {
    let agentManager = context.require('agentManager');
    let masters = await agentManager.listMasterAgents({
      limit: parsePositiveInteger(url.searchParams.get('limit'), 50),
      offset: parseNonNegativeInteger(url.searchParams.get('offset'), 0),
    });
    let defaults = false;
    let resolved = null;
    if (url.searchParams.get('resolve') === '1') {
      let excludeAgentIDs = url.searchParams.getAll('exclude').filter((id) => id.trim() !== '');
      resolved = await agentManager.resolveDefaultAgent({ excludeAgentIDs });
      defaults = true;
    }

    writeJSON(response, 200, {
      data: {
        masters,
        ...(defaults ? { defaultAgent: resolved } : {}),
      },
    });
    return true;
  }

  // Designated compaction bots, best (#1) first. Parallel to /masters but a
  // fully independent rolling top-3.
  if (request.method === 'GET' && url.pathname === '/api/v1/agents/compaction-bots') {
    let agentManager = context.require('agentManager');
    let compactionBots = typeof agentManager.refreshCompactionBots === 'function'
      ? await agentManager.refreshCompactionBots()
      : agentManager.listCompactionBots({ limit: 500 });
    writeJSON(response, 200, {
      data: {
        compactionBots,
      },
    });
    return true;
  }

  let agentCrownRoute = matchAgentCrownRoute(url.pathname);
  if (agentCrownRoute && request.method === 'POST') {
    let agentManager = context.require('agentManager');
    let agent = await agentManager.setAgentCrowned(agentCrownRoute.agentID, agentCrownRoute.crowned);
    // Return the full authoritative master set: crowning can evict an older
    // master, so the client cannot derive the set from just the toggled agent.
    // The client marks every agent in `masters` as crowned and clears any other
    // locally-crowned agent, keeping client and server in sync.
    let masters = await agentManager.listMasterAgents({ limit: 500 });
    writeJSON(response, 200, {
      data: {
        agent,
        masters,
      },
    });
    return true;
  }

  // Compaction-bot designation routes: the parallel-but-independent list to the
  // crown. Same shape as the crown pair, including the authoritative list so the
  // client can reconcile evictions.
  let agentCompactionCrownRoute = matchAgentCompactionCrownRoute(url.pathname);
  if (agentCompactionCrownRoute && request.method === 'POST') {
    let agentManager = context.require('agentManager');
    let agent = await agentManager.setAgentCompactionBotCrowned(agentCompactionCrownRoute.agentID, agentCompactionCrownRoute.crowned);
    let compactionBots = await agentManager.listCompactionBots({ limit: 500 });
    writeJSON(response, 200, {
      data: {
        agent,
        compactionBots,
      },
    });
    return true;
  }

  let agentRoute = matchAgentRoute(url.pathname);
  if (agentRoute) {
    let agentManager = context.require('agentManager');

    if (request.method === 'GET') {
      writeJSON(response, 200, {
        data: {
          agent: await agentManager.getAgent(agentRoute.agentID),
        },
      });
      return true;
    }

    if (request.method === 'PATCH') {
      let body = await readJSON(request);
      validateAgentBody(body, { creating: false });
      writeJSON(response, 200, {
        data: {
          agent: await agentManager.updateAgent(agentRoute.agentID, body),
        },
      });
      return true;
    }

    if (request.method === 'DELETE') {
      await agentManager.deleteAgent(agentRoute.agentID);
      response.writeHead(204);
      response.end();
      return true;
    }
  }

  return false;
}
