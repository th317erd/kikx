'use strict';

import {
  parseNonNegativeInteger,
  parsePositiveInteger,
  readJSON,
  writeJSON,
} from '../http-helpers.mjs';
import { matchTeamMemberRoute, matchTeamRoute } from './route-matchers.mjs';
import { validateTeamBody, validateTeamMemberBody } from './validators.mjs';

export async function handleTeamRoutes({ request, response, url, context }) {
  if (request.method === 'GET' && url.pathname === '/api/v1/teams') {
    let teamManager = context.require('teamManager');
    writeJSON(response, 200, {
      data: {
        teams: await teamManager.listTeams({
          limit: parsePositiveInteger(url.searchParams.get('limit'), 50),
          offset: parseNonNegativeInteger(url.searchParams.get('offset'), 0),
        }),
      },
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/teams') {
    let body = await readJSON(request);
    validateTeamBody(body, { creating: true });

    let teamManager = context.require('teamManager');
    writeJSON(response, 201, {
      data: {
        team: await teamManager.createTeam(body),
      },
    });
    return true;
  }

  let teamMemberRoute = matchTeamMemberRoute(url.pathname);
  if (teamMemberRoute) {
    let teamManager = context.require('teamManager');

    if (request.method === 'POST' && teamMemberRoute.resource === 'members') {
      let body = await readJSON(request);
      validateTeamMemberBody(body);
      writeJSON(response, 200, {
        data: {
          team: await teamManager.addMember(teamMemberRoute.teamID, body),
        },
      });
      return true;
    }

    if (request.method === 'DELETE' && teamMemberRoute.resource === 'member') {
      writeJSON(response, 200, {
        data: {
          team: await teamManager.removeMember(teamMemberRoute.teamID, {
            actorID: teamMemberRoute.actorID,
            type: url.searchParams.get('type') || '',
          }),
        },
      });
      return true;
    }
  }

  let teamRoute = matchTeamRoute(url.pathname);
  if (teamRoute) {
    let teamManager = context.require('teamManager');

    if (request.method === 'GET') {
      writeJSON(response, 200, {
        data: {
          team: await teamManager.getTeam(teamRoute.teamID),
        },
      });
      return true;
    }

    if (request.method === 'PATCH') {
      let body = await readJSON(request);
      validateTeamBody(body, { creating: false });
      writeJSON(response, 200, {
        data: {
          team: await teamManager.updateTeam(teamRoute.teamID, body),
        },
      });
      return true;
    }

    if (request.method === 'DELETE') {
      await teamManager.deleteTeam(teamRoute.teamID);
      response.writeHead(204);
      response.end();
      return true;
    }
  }

  return false;
}
