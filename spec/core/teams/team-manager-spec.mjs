'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { TeamManager } from '../../../src/core/teams/index.mjs';

function createTeamStore() {
  return {
    teams: new Map(),
    calls: [],
    async createTeam(input) {
      this.calls.push({ method: 'createTeam', input });
      let team = {
        id: input.id || `team_${this.teams.size + 1}`,
        name: input.name,
        members: input.members || [],
        createdAt: 1000,
        updatedAt: 1000,
      };
      this.teams.set(team.id, team);
      return { ...team, members: team.members.map((member) => ({ ...member })) };
    },
    async listTeams() {
      return [ ...this.teams.values() ].map((team) => ({ ...team, members: team.members.map((member) => ({ ...member })) }));
    },
    async getTeam(teamID) {
      let team = this.teams.get(teamID);
      if (!team) {
        let error = new Error(`Unknown team: ${teamID}`);
        error.status = 404;
        throw error;
      }

      return { ...team, members: team.members.map((member) => ({ ...member })) };
    },
    async findTeamByIDOrName(reference) {
      if (this.teams.has(reference))
        return this.getTeam(reference);

      let lowered = reference.toLowerCase();
      return [ ...this.teams.values() ].find((team) => team.name.toLowerCase() === lowered) || null;
    },
    async updateTeam(teamID, input) {
      this.calls.push({ method: 'updateTeam', teamID, input });
      let team = await this.getTeam(teamID);
      let next = {
        ...team,
        ...input,
        updatedAt: 1001,
      };
      this.teams.set(teamID, next);
      return { ...next, members: next.members.map((member) => ({ ...member })) };
    },
    async deleteTeam(teamID) {
      this.calls.push({ method: 'deleteTeam', teamID });
      this.teams.delete(teamID);
    },
  };
}

function createAgentManager() {
  let agents = new Map([
    [ 'agent_1', { id: 'agent_1', name: 'Iron-Hand' } ],
    [ 'agent_2', { id: 'agent_2', name: 'Mr. Bennett' } ],
  ]);

  return {
    async resolveAgent(reference) {
      for (let agent of agents.values()) {
        if (agent.id === reference || agent.name.toLowerCase() === reference.toLowerCase())
          return agent;
      }

      let error = new Error(`Agent not found: ${reference}`);
      error.status = 404;
      throw error;
    },
  };
}

test('TeamManager creates teams with normalized agent and user actor members', async () => {
  let teamStore = createTeamStore();
  let manager = new TeamManager({
    teamStore,
    agentManager: createAgentManager(),
  });

  let team = await manager.createTeam({
    name: 'Builders',
    members: [
      'Iron-Hand',
      { type: 'agent', reference: 'Mr. Bennett' },
      { type: 'user', actorID: 'usr_1', name: 'Wyatt', email: 'wyatt@example.com' },
      { type: 'agent', actorID: 'agent_1' },
    ],
  });

  assert.deepEqual(team.members, [
    { actorID: 'agent_1', type: 'agent', name: 'Iron-Hand' },
    { actorID: 'agent_2', type: 'agent', name: 'Mr. Bennett' },
    { actorID: 'usr_1', type: 'user', name: 'Wyatt', email: 'wyatt@example.com' },
  ]);
  assert.deepEqual(teamStore.calls[0].input.members, team.members);
});

test('TeamManager updates, adds, removes, resolves, and deletes teams without actor deletion', async () => {
  let teamStore = createTeamStore();
  let manager = new TeamManager({
    teamStore,
    agentManager: createAgentManager(),
  });

  let team = await manager.createTeam({ name: 'Builders' });
  assert.equal((await manager.resolveTeam('Builders')).id, team.id);

  let added = await manager.addMember(team.id, 'Iron-Hand');
  assert.deepEqual(added.members, [{ actorID: 'agent_1', type: 'agent', name: 'Iron-Hand' }]);

  let renamed = await manager.updateTeam(team.id, { name: 'Reviewers' });
  assert.equal(renamed.name, 'Reviewers');

  let removed = await manager.removeMember(team.id, { actorID: 'agent_1', type: 'agent' });
  assert.deepEqual(removed.members, []);

  await manager.deleteTeam(team.id);
  assert.deepEqual(teamStore.calls.at(-1), { method: 'deleteTeam', teamID: team.id });
});
