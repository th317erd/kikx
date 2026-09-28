'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { AeorDBTeamStore } from '../../src/core/aeordb/aeordb-team-store.mjs';

function createClient() {
  return {
    calls: [],
    files: new Map(),
    async putFile(path, body) {
      this.calls.push({ method: 'putFile', path, body });
      this.files.set(path, body);
      return { path };
    },
    async getFile(path) {
      this.calls.push({ method: 'getFile', path });
      return this.files.get(path) || null;
    },
    async fetchFiles(paths, options) {
      this.calls.push({ method: 'fetchFiles', paths, options });
      let output = {};
      for (let path of paths) {
        if (!this.files.has(path)) {
          let error = new Error(`missing: ${path}`);
          error.status = 404;
          throw error;
        }

        output[path] = {
          path,
          content: JSON.stringify(this.files.get(path)),
        };
      }

      return output;
    },
    async deleteFile(path) {
      this.calls.push({ method: 'deleteFile', path });
      this.files.delete(path);
      return { path };
    },
    async listDirectory(path, options = {}) {
      this.calls.push({ method: 'listDirectory', path, options });
      let prefix = `${path.replace(/\/+$/g, '')}/`;
      let regex = null;
      if (options.glob === '*/team.json' || options.glob === '**/team.json')
        regex = /^\/kikx\/teams\/[^/]+\/team\.json$/;
      else if (options.glob === '*.json')
        regex = new RegExp(`^${escapeRegex(prefix)}[^/]+\\.json$`);

      return {
        items: [ ...this.files.keys() ]
          .filter((filePath) => filePath.startsWith(prefix))
          .filter((filePath) => !regex || regex.test(filePath))
          .map((filePath) => ({ path: filePath })),
      };
    },
    async queryFiles(query) {
      this.calls.push({ method: 'queryFiles', query });
      let prefix = `${query.path.replace(/\/+$/g, '')}/`;
      let matches = [];

      for (let [filePath, body] of this.files.entries()) {
        if (!filePath.startsWith(prefix))
          continue;

        if (query.where?.field === 'nameKey' && query.where?.op === 'eq' && body.nameKey === query.where.value)
          matches.push({ path: filePath });
      }

      return { results: matches.slice(0, query.limit || matches.length) };
    },
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('AeorDBTeamStore persists actor teams with lookup indexes', async () => {
  let aeordb = createClient();
  let store = new AeorDBTeamStore({
    aeordb,
    clock: () => 1000,
    idGenerator: () => 'team_1',
  });

  let team = await store.createTeam({
    name: 'Core Team',
    members: [
      { type: 'agent', actorID: 'agent_1', name: 'Iron-Hand' },
      { type: 'user', actorID: 'usr_1', name: 'Wyatt', email: 'wyatt@example.com' },
      { type: 'agent', actorID: 'agent_1', name: 'Iron-Hand' },
    ],
  });

  assert.deepEqual(team, {
    id: 'team_1',
    name: 'Core Team',
    members: [
      { type: 'agent', actorID: 'agent_1', name: 'Iron-Hand' },
      { type: 'user', actorID: 'usr_1', name: 'Wyatt', email: 'wyatt@example.com' },
    ],
    createdAt: 1000,
    updatedAt: 1000,
  });
  assert.equal(aeordb.files.get('/kikx/teams/team_1/team.json').nameKey, 'core team');
  assert.deepEqual(aeordb.files.get('/kikx/teams/team_1/team.json').memberActorIDs, [ 'agent_1', 'usr_1' ]);
  assert.ok([ ...aeordb.files.keys() ].some((path) => path.startsWith('/kikx/team-name-lookup/') && path.endsWith('/team_1.json')));
  assert.equal(aeordb.calls[0].path, '/kikx/teams/.aeordb-config/indexes.json');
});

test('AeorDBTeamStore lists, updates, deletes, and resolves teams by name', async () => {
  let aeordb = createClient();
  let store = new AeorDBTeamStore({
    aeordb,
    clock: (() => {
      let now = 1000;
      return () => now++;
    })(),
    idGenerator: () => 'team_1',
  });

  await store.createTeam({
    name: 'Core Team',
    members: [{ type: 'agent', actorID: 'agent_1', name: 'Iron-Hand' }],
  });

  let updated = await store.updateTeam('team_1', {
    name: 'Review Team',
    members: [{ type: 'user', actorID: 'usr_1', name: 'Wyatt' }],
  });

  assert.equal(updated.name, 'Review Team');
  assert.deepEqual(updated.members, [{ type: 'user', actorID: 'usr_1', name: 'Wyatt' }]);
  assert.deepEqual((await store.listTeams()).map((team) => team.id), [ 'team_1' ]);
  assert.equal((await store.findTeamByIDOrName('Review Team')).id, 'team_1');
  assert.equal((await store.findTeamByIDOrName('review team')).id, 'team_1');
  assert.equal(await store.findTeamByIDOrName('missing'), null);
  assert.equal([ ...aeordb.files.values() ].filter((value) => value?.teamID === 'team_1').length, 1);

  await store.deleteTeam('team_1');
  assert.equal(await store.loadTeam('team_1'), null);
  assert.equal([ ...aeordb.files.values() ].some((value) => value?.teamID === 'team_1'), false);
});

test('AeorDBTeamStore rejects malformed teams and treats a missing directory as empty', async () => {
  let store = new AeorDBTeamStore({ aeordb: createClient() });

  await assert.rejects(
    () => store.createTeam({ members: [] }),
    /name must be a non-empty string/,
  );

  await assert.rejects(
    () => store.createTeam({ name: 'Bad', members: [{ type: 'service', actorID: 'svc_1' }] }),
    /member.type must be agent or user/,
  );

  await assert.rejects(
    () => store.getTeam('missing'),
    /Unknown team/,
  );

  let emptyStore = new AeorDBTeamStore({
    aeordb: {
      async putFile() {},
      async listDirectory() {
        let error = new Error('missing');
        error.status = 404;
        throw error;
      },
    },
  });

  assert.deepEqual(await emptyStore.listTeams(), []);
});
