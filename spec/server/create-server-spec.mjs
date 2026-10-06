'use strict';

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createServer } from '../../src/server/create-server.mjs';
import { AppContext } from '../../src/core/app/app-context.mjs';
import { PluginRegistry } from '../../src/core/plugins/index.mjs';
// Isolate from ambient plugin discovery (e.g. KIKX_PLUGIN_PATHS injected by a
// container/CI environment) so these fixture registries are not polluted by
// real plugins, which makes the assertions below env-dependent.
delete process.env.KIKX_PLUGIN_PATHS;

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      let address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function jsonFetch(url, body, options = {}) {
  return fetch(url, {
    method: options.method || 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: JSON.stringify(body),
  });
}

function unsignedJWT(payload = {}) {
  return [
    base64URL(JSON.stringify({ alg: 'none', typ: 'JWT' })),
    base64URL(JSON.stringify(payload)),
    'signature',
  ].join('.');
}

function base64URL(value) {
  return Buffer.from(value).toString('base64url');
}

function createRuntime() {
  let calls = [];
  return {
    calls,
    async createSession(input) {
      calls.push({ method: 'createSession', input });
      return {
        id: input.id || 'ses_1',
        title: input.title || 'Session 1',
        organizationID: input.organizationID || null,
      };
    },
    listSessions(options) {
      calls.push({ method: 'listSessions', options });
      return [
        { id: 'ses_1', title: 'Scratch' },
      ];
    },
    async updateSession(sessionID, input) {
      calls.push({ method: 'updateSession', sessionID, input });
      if (sessionID === 'missing') {
        let error = new Error('Unknown session: missing');
        error.status = 404;
        throw error;
      }

      return {
        id: sessionID,
        title: input.title,
      };
    },
    async appendUserMessage(sessionID, input) {
      calls.push({ method: 'appendUserMessage', sessionID, input });
      if (sessionID === 'missing') {
        let error = new Error('Unknown session: missing');
        error.status = 404;
        throw error;
      }

      return {
        session: { id: sessionID, title: 'Scratch' },
        frame: { id: 'msg_1', type: 'UserMessage', content: { text: input.text } },
        commit: { id: 'commit_1', order: 1 },
      };
    },
    listFrames(sessionID, options) {
      calls.push({ method: 'listFrames', sessionID, options });
      return [
        { id: 'msg_1', type: 'UserMessage', content: { text: 'hello' } },
      ];
    },
    listFrameWindow(sessionID, options) {
      calls.push({ method: 'listFrameWindow', sessionID, options });
      return {
        frames: [ { id: 'msg_9', type: 'UserMessage', order: 9, content: { text: 'newest' } } ],
        total: 42,
        hasMore: true,
        oldestOrder: 9,
        newestOrder: 12,
      };
    },
    async listSessionPreviews(sessionIDs, options) {
      calls.push({ method: 'listSessionPreviews', sessionIDs, options });
      return sessionIDs.map((sessionID) => ({
        sessionID,
        session: { id: sessionID, title: `Session ${sessionID}` },
        heads: [ { id: 'msg_1', type: 'UserMessage', content: { text: 'hello' } } ],
        truncated: false,
        error: null,
      }));
    },
  };
}

function createAgentManager() {
  let calls = [];
  return {
    calls,
    async listProviders() {
      calls.push({ method: 'listProviders' });
      return [
        {
          pluginID: 'test-agent',
          displayName: 'Test Agent',
          configFields: [
            { name: 'model', secret: false, required: true },
            { name: 'apiKey', secret: true, required: true },
          ],
        },
      ];
    },
    async listAgents(options) {
      calls.push({ method: 'listAgents', options });
      return [
        {
          id: 'agent_1',
          name: 'Coder',
          pluginID: 'test-agent',
          character: 'You are a careful engineer.',
          config: { model: 'sonnet' },
          secretState: { apiKey: { present: true, last4: '1234' } },
        },
      ];
    },
    async createAgent(input) {
      calls.push({ method: 'createAgent', input });
      return {
        id: 'agent_1',
        name: input.name,
        pluginID: input.pluginID,
        character: input.character || '',
        config: input.config,
        secretState: { apiKey: { present: true, last4: '1234' } },
      };
    },
    async setAgentCrowned(agentID, crowned) {
      calls.push({ method: 'setAgentCrowned', agentID, crowned });
      return { id: agentID, name: 'Coder', pluginID: 'test-agent', crownedClock: crowned ? '0000000000000005-000000-r' : null, crownedAt: crowned ? 5 : null };
    },
    async listMasterAgents(options) {
      calls.push({ method: 'listMasterAgents', options });
      return [
        { id: 'master_1', name: 'Master One', pluginID: 'test-agent', crownedClock: '0000000000000002-000000-r', crownedAt: 2 },
      ];
    },
    async setAgentCompactionBotCrowned(agentID, crowned) {
      calls.push({ method: 'setAgentCompactionBotCrowned', agentID, crowned });
      return { id: agentID, name: 'Coder', pluginID: 'test-agent', compactionCrownedClock: crowned ? '0000000000000007-000000-r' : null, compactionCrownedAt: crowned ? 7 : null };
    },
    listCompactionBots(options = {}) {
      calls.push({ method: 'listCompactionBots', options });
      return [
        { id: 'bot_1', name: 'Bot One', pluginID: 'test-agent', compactionCrownedClock: '0000000000000003-000000-r', compactionCrownedAt: 3 },
      ];
    },
    async refreshCompactionBots() {
      calls.push({ method: 'refreshCompactionBots' });
      return this.listCompactionBots({ limit: 500 });
    },
    async resolveDefaultAgent(options) {
      calls.push({ method: 'resolveDefaultAgent', options });
      return { id: 'master_1', name: 'Master One', pluginID: 'test-agent' };
    },
    async getAgent(agentID) {
      calls.push({ method: 'getAgent', agentID });
      if (agentID === 'missing') {
        let error = new Error('Unknown agent: missing');
        error.status = 404;
        throw error;
      }
      return { id: agentID, name: 'Coder', pluginID: 'test-agent', character: '', config: {}, secretState: {} };
    },
    async updateAgent(agentID, input) {
      calls.push({ method: 'updateAgent', agentID, input });
      return { id: agentID, name: input.name || 'Coder', pluginID: 'test-agent', character: input.character || '', config: input.config || {}, secretState: {} };
    },
    async deleteAgent(agentID) {
      calls.push({ method: 'deleteAgent', agentID });
    },
  };
}

function createTeamManager() {
  let calls = [];
  return {
    calls,
    async listTeams(options) {
      calls.push({ method: 'listTeams', options });
      return [
        {
          id: 'team_1',
          name: 'Builders',
          members: [{ type: 'agent', actorID: 'agent_1', name: 'Coder' }],
          createdAt: 1000,
          updatedAt: 1000,
        },
      ];
    },
    async createTeam(input) {
      calls.push({ method: 'createTeam', input });
      return {
        id: 'team_1',
        name: input.name,
        members: input.members || [],
        createdAt: 1000,
        updatedAt: 1000,
      };
    },
    async getTeam(teamID) {
      calls.push({ method: 'getTeam', teamID });
      if (teamID === 'missing') {
        let error = new Error('Unknown team: missing');
        error.status = 404;
        throw error;
      }

      return {
        id: teamID,
        name: 'Builders',
        members: [{ type: 'agent', actorID: 'agent_1', name: 'Coder' }],
        createdAt: 1000,
        updatedAt: 1000,
      };
    },
    async updateTeam(teamID, input) {
      calls.push({ method: 'updateTeam', teamID, input });
      return {
        id: teamID,
        name: input.name || 'Builders',
        members: input.members || [],
        createdAt: 1000,
        updatedAt: 1001,
      };
    },
    async addMember(teamID, input) {
      calls.push({ method: 'addMember', teamID, input });
      return {
        id: teamID,
        name: 'Builders',
        members: [{ type: input.type || 'agent', actorID: input.actorID || input.agentID || 'agent_1', name: input.name || 'Coder' }],
        createdAt: 1000,
        updatedAt: 1001,
      };
    },
    async removeMember(teamID, input) {
      calls.push({ method: 'removeMember', teamID, input });
      return {
        id: teamID,
        name: 'Builders',
        members: [],
        createdAt: 1000,
        updatedAt: 1001,
      };
    },
    async deleteTeam(teamID) {
      calls.push({ method: 'deleteTeam', teamID });
    },
  };
}

async function createStaticFixture() {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-static-'));
  let clientRoot = path.join(root, 'client');
  let sharedRoot = path.join(root, 'shared');
  let aeorWebComponentsRoot = path.join(root, 'aeor-web-components');

  await fs.mkdir(path.join(clientRoot, 'styles'), { recursive: true });
  await fs.mkdir(path.join(sharedRoot, 'frame-manager'), { recursive: true });
  await fs.mkdir(path.join(aeorWebComponentsRoot, 'components'), { recursive: true });
  await fs.writeFile(path.join(clientRoot, 'index.html'), '<!doctype html><title>Kikx</title>');
  await fs.writeFile(path.join(clientRoot, 'app.mjs'), "import './components/kikx-app.mjs';");
  await fs.writeFile(path.join(clientRoot, 'styles', 'app.css'), 'body { color: white; }');
  await fs.writeFile(path.join(sharedRoot, 'frame-manager', 'frame-manager.mjs'), 'export class FrameManager {}');
  await fs.writeFile(path.join(aeorWebComponentsRoot, 'elements.js'), 'export const elements = {};');

  return { root, clientRoot, sharedRoot, aeorWebComponentsRoot };
}

test('GET /health reports service state and readiness', async () => {
  let server = await createServer({
    context: new AppContext({
      aeordb: {
        eventsURL: () => 'http://aeor.test/system/events',
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    // `ready` is false until startup recovery + the scheduled-frame worker
    // settle; a context with no scheduled-worker wiring settles immediately and
    // flips to true.
    let response = await fetch(`${baseURL}/health`);
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.services.aeordb, true);
    assert.equal(typeof body.ready, 'boolean');

    // Once startup settles, `ready` becomes true and stays true.
    let deadline = Date.now() + 2000;
    while (Date.now() < deadline && body.ready !== true) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      body = await (await fetch(`${baseURL}/health`)).json();
    }
    assert.equal(body.ready, true);
  } finally {
    await close(server);
  }
});

test('GET /api/v1/client-components returns plugin renderer descriptors', async () => {
  let pluginRegistry = new PluginRegistry({ logger: { warn() {} } });
  pluginRegistry.registerFrameComponent('ToolCall', {
    tagName: 'kikx-tool-call-frame',
    moduleURL: '/client/components/tool-renderers/kikx-tool-call-frame.mjs',
  });
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      pluginRegistry,
      builtInToolsRegistered: true,
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/client-components`);
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      data: {
        components: [
          {
            kind: 'frame',
            frameType: 'ToolCall',
            tagName: 'kikx-tool-call-frame',
            moduleURL: '/client/components/tool-renderers/kikx-tool-call-frame.mjs',
          },
        ],
      },
    });
  } finally {
    await close(server);
  }
});

test('GET /api/v1/sessions validates pagination parameters', async () => {
  let runtime = createRuntime();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      frameRuntime: runtime,
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/sessions?limit=0`);
    let body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      error: {
        message: 'limit must be a positive integer',
      },
    });
    assert.deepEqual(runtime.calls, []);
  } finally {
    await close(server);
  }
});

test('POST /api/v1/sessions creates a runtime session', async () => {
  let runtime = createRuntime();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      frameRuntime: runtime,
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await jsonFetch(`${baseURL}/api/v1/sessions`, {
      title: 'Scratch',
      organizationID: 'org_1',
    });
    let body = await response.json();

    assert.equal(response.status, 201);
    assert.deepEqual(runtime.calls[0], {
      method: 'createSession',
      input: {
        title: 'Scratch',
        organizationID: 'org_1',
        createdByUserID: null,
        parentSessionID: null,
      },
    });
    assert.deepEqual(body, {
      data: {
        session: {
          id: 'ses_1',
          title: 'Scratch',
          organizationID: 'org_1',
        },
      },
    });
  } finally {
    await close(server);
  }
});

test('POST /api/v1/sessions creates a child session when parentSessionID is given', async () => {
  let runtime = createRuntime();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      frameRuntime: runtime,
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await jsonFetch(`${baseURL}/api/v1/sessions`, {
      title: 'Child',
      parentSessionID: 'parent_1',
    });

    assert.equal(response.status, 201);
    assert.equal(runtime.calls[0].input.parentSessionID, 'parent_1');

    let invalid = await jsonFetch(`${baseURL}/api/v1/sessions`, {
      parentSessionID: '   ',
    });
    assert.equal(invalid.status, 400);
  } finally {
    await close(server);
  }
});

test('GET /api/v1/sessions lists runtime sessions', async () => {
  let runtime = createRuntime();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      frameRuntime: runtime,
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/sessions`);
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(runtime.calls[0], {
      method: 'listSessions',
      options: {
        limit: 50,
        offset: 0,
      },
    });
    assert.deepEqual(body, {
      data: {
        sessions: [
          { id: 'ses_1', title: 'Scratch' },
        ],
      },
    });
  } finally {
    await close(server);
  }
});

test('runtime routes validate session title when provided', async () => {
  let runtime = createRuntime();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      frameRuntime: runtime,
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await jsonFetch(`${baseURL}/api/v1/sessions`, {
      title: '',
    });
    let body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      error: {
        message: 'title must be a non-empty string',
      },
    });
    assert.deepEqual(runtime.calls, []);
  } finally {
    await close(server);
  }
});

test('POST /api/v1/sessions allows runtime-generated session titles', async () => {
  let runtime = createRuntime();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      frameRuntime: runtime,
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await jsonFetch(`${baseURL}/api/v1/sessions`, {});
    let body = await response.json();

    assert.equal(response.status, 201);
    assert.deepEqual(runtime.calls[0], {
      method: 'createSession',
      input: {
        title: undefined,
        organizationID: null,
        createdByUserID: null,
        parentSessionID: null,
      },
    });
    assert.equal(body.data.session.title, 'Session 1');
  } finally {
    await close(server);
  }
});

test('PATCH /api/v1/sessions/:sessionID updates a runtime session title', async () => {
  let runtime = createRuntime();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      frameRuntime: runtime,
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await jsonFetch(`${baseURL}/api/v1/sessions/ses_1`, {
      title: 'Project Alpha',
    }, { method: 'PATCH' });
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(runtime.calls[0], {
      method: 'updateSession',
      sessionID: 'ses_1',
      input: {
        title: 'Project Alpha',
      },
    });
    assert.deepEqual(body, {
      data: {
        session: {
          id: 'ses_1',
          title: 'Project Alpha',
        },
      },
    });
  } finally {
    await close(server);
  }
});

test('PATCH /api/v1/sessions/:sessionID validates title input', async () => {
  let runtime = createRuntime();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      frameRuntime: runtime,
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await jsonFetch(`${baseURL}/api/v1/sessions/ses_1`, {
      title: ' ',
    }, { method: 'PATCH' });
    let body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      error: {
        message: 'title must be a non-empty string',
      },
    });
    assert.deepEqual(runtime.calls, []);
  } finally {
    await close(server);
  }
});

test('PATCH /api/v1/sessions/:sessionID reports missing sessions as 404', async () => {
  let runtime = createRuntime();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      frameRuntime: runtime,
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await jsonFetch(`${baseURL}/api/v1/sessions/missing`, {
      title: 'Project Alpha',
    }, { method: 'PATCH' });
    let body = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(body, {
      error: {
        message: 'Unknown session: missing',
      },
    });
  } finally {
    await close(server);
  }
});

test('POST /api/v1/sessions/:sessionID/messages appends a user message', async () => {
  let runtime = createRuntime();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      frameRuntime: runtime,
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await jsonFetch(`${baseURL}/api/v1/sessions/ses_1/messages`, {
      text: 'hello',
      userID: 'usr_1',
    });
    let body = await response.json();

    assert.equal(response.status, 201);
    assert.deepEqual(runtime.calls[0], {
      method: 'appendUserMessage',
      sessionID: 'ses_1',
      input: {
        text: 'hello',
        userID: 'usr_1',
      },
    });
    assert.deepEqual(body.data.commit, { id: 'commit_1', order: 1 });
    assert.deepEqual(body.data.frame, { id: 'msg_1', type: 'UserMessage', content: { text: 'hello' } });
  } finally {
    await close(server);
  }
});

test('POST /api/v1/sessions/:sessionID/messages stamps account author metadata when signed in', async () => {
  let runtime = createRuntime();
  let token = unsignedJWT({ sub: 'usr_1' });
  let server = await createServer({
    context: new AppContext({
      aeordb: {
        async get() {
          return { id: 'usr_1', name: 'Wyatt Greenway', email: 'wyatt@example.com' };
        },
      },
      authService: {
        async verifyAccessToken(accessToken) {
          return accessToken === token ? { id: 'usr_1', sessionId: 'sess_1' } : null;
        },
        async getUser() {
          return { id: 'usr_1', name: 'Wyatt Greenway', username: 'wyatt@example.com', email: 'wyatt@example.com' };
        },
      },
      frameRuntime: runtime,
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await jsonFetch(`${baseURL}/api/v1/sessions/ses_1/messages`, {
      text: 'hello',
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    let body = await response.json();

    assert.equal(response.status, 201);
    assert.deepEqual(runtime.calls[0], {
      method: 'appendUserMessage',
      sessionID: 'ses_1',
      input: {
        text: 'hello',
        userID: 'usr_1',
        authorDisplayName: 'Wyatt Greenway',
      },
    });
    assert.deepEqual(body.data.commit, { id: 'commit_1', order: 1 });
  } finally {
    await close(server);
  }
});

test('GET /api/v1/account returns a Kikx profile for the signed-in user', async () => {
  let token = unsignedJWT({ sub: 'usr_1' });
  let server = await createServer({
    context: new AppContext({
      aeordb: {
        async get(pathname) {
          assert.equal(pathname, '/kikx/users/usr_1/profile.json');
          return { id: 'usr_1', name: 'Wyatt', email: 'wyatt@kikx.test' };
        },
      },
      authService: {
        async verifyAccessToken(accessToken) {
          return accessToken === token ? { id: 'usr_1', sessionId: 'sess_1' } : null;
        },
        async getUser(userID) {
          assert.equal(userID, 'usr_1');
          return { id: 'usr_1', username: 'wyatt@example.com', email: 'wyatt@example.com' };
        },
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/account`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.data.account, {
      id: 'usr_1',
      name: 'Wyatt',
      email: 'wyatt@kikx.test',
      username: 'wyatt@example.com',
      source: 'kikx-user',
      createdAt: null,
      updatedAt: null,
    });
  } finally {
    await close(server);
  }
});

test('PATCH /api/v1/account saves display name and updates the Kikx user', async () => {
  let token = unsignedJWT({ sub: 'usr_1' });
  let writes = [];
  let updatedUser;
  let server = await createServer({
    context: new AppContext({
      aeordb: {
        async get(pathname) {
          assert.equal(pathname, '/kikx/users/usr_1/profile.json');
          return { id: 'usr_1', name: 'Old Name', email: 'old@example.com', createdAt: 1000 };
        },
        async put(pathname, body) {
          writes.push({ pathname, body });
          return { path: pathname };
        },
      },
      authService: {
        async verifyAccessToken(accessToken) {
          return accessToken === token ? { id: 'usr_1', sessionId: 'sess_1' } : null;
        },
        async updateUser(userID, body) {
          updatedUser = { userID, body };
          return { id: 'usr_1', name: body.name || 'Old Name', email: body.email || 'old@example.com' };
        },
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await jsonFetch(`${baseURL}/api/v1/account`, {
      name: 'New Name',
      email: 'new@example.com',
    }, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(updatedUser, {
      userID: 'usr_1',
      body: { name: 'New Name', email: 'new@example.com' },
    });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].pathname, '/kikx/users/usr_1/profile.json');
    assert.equal(writes[0].body.name, 'New Name');
    assert.equal(writes[0].body.email, 'new@example.com');
    assert.equal(body.data.account.name, 'New Name');
    assert.equal(body.data.account.email, 'new@example.com');
  } finally {
    await close(server);
  }
});

test('GET /api/v1/sessions/:sessionID/frames defaults to the newest window', async () => {
  let runtime = createRuntime();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      frameRuntime: runtime,
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/sessions/ses_1/frames`);
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      data: {
        frames: [ { id: 'msg_9', type: 'UserMessage', order: 9, content: { text: 'newest' } } ],
        total: 42,
        hasMore: true,
        oldestOrder: 9,
        newestOrder: 12,
      },
    });
    assert.deepEqual(runtime.calls.at(-1), {
      method: 'listFrameWindow',
      sessionID: 'ses_1',
      options: { limit: 100, before: null },
    });
  } finally {
    await close(server);
  }
});

test('GET /api/v1/sessions/:sessionID/frames passes the before cursor and limit', async () => {
  let runtime = createRuntime();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      frameRuntime: runtime,
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/sessions/ses_1/frames?limit=30&before=9`);

    assert.equal(response.status, 200);
    assert.deepEqual(runtime.calls.at(-1), {
      method: 'listFrameWindow',
      sessionID: 'ses_1',
      options: { limit: 30, before: 9 },
    });
  } finally {
    await close(server);
  }
});

test('GET /api/v1/sessions/:sessionID/frames keeps the legacy offset path', async () => {
  let runtime = createRuntime();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      frameRuntime: runtime,
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/sessions/ses_1/frames?limit=25&offset=50`);

    assert.equal(response.status, 200);
    assert.deepEqual(runtime.calls.at(-1), {
      method: 'listFrames',
      sessionID: 'ses_1',
      options: { limit: 25, offset: 50 },
    });
  } finally {
    await close(server);
  }
});

test('GET /api/v1/sessions/:sessionID/frames rejects an invalid before cursor', async () => {
  let runtime = createRuntime();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      frameRuntime: runtime,
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/sessions/ses_1/frames?before=-1`);

    assert.equal(response.status, 400);
  } finally {
    await close(server);
  }
});

test('GET /api/v1/tool-outputs/:outputID reads stored tool output with bounded defaults', async () => {
  let calls = [];
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      processManager: {},
      toolOutputStore: {
        async getToolOutput(input) {
          calls.push(input);
          return {
            id: input.id,
            toolName: 'exec',
            format: 'json',
            sizeBytes: 4096,
            start: input.start || 0,
            end: 128,
            returnedBytes: 128,
            truncated: true,
            content: '{"stdout":"hello"}',
          };
        },
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/tool-outputs/OUT1`);
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.data.output.id, 'OUT1');
    assert.deepEqual(calls, [{
      id: 'OUT1',
      start: null,
      end: null,
      maxBytes: 128 * 1024,
    }]);
  } finally {
    await close(server);
  }
});

test('GET /api/v1/tool-outputs/:outputID forwards explicit ranges', async () => {
  let calls = [];
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      processManager: {},
      toolOutputStore: {
        async getToolOutput(input) {
          calls.push(input);
          return {
            id: input.id,
            toolName: 'web-search',
            format: 'json',
            sizeBytes: 1000,
            start: input.start,
            end: input.end,
            returnedBytes: input.end - input.start,
            truncated: true,
            content: '{}',
          };
        },
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/tool-outputs/OUT2?start=10&end=42&maxBytes=64`);
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.data.output.start, 10);
    assert.equal(body.data.output.end, 42);
    assert.deepEqual(calls, [{
      id: 'OUT2',
      start: 10,
      end: 42,
      maxBytes: 64,
    }]);
  } finally {
    await close(server);
  }
});

test('runtime routes validate message text', async () => {
  let runtime = createRuntime();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      frameRuntime: runtime,
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await jsonFetch(`${baseURL}/api/v1/sessions/ses_1/messages`, {
      text: '',
    });
    let body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      error: {
        message: 'text is required',
      },
    });
    assert.deepEqual(runtime.calls, []);
  } finally {
    await close(server);
  }
});

test('runtime routes report missing sessions as 404', async () => {
  let runtime = createRuntime();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      frameRuntime: runtime,
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await jsonFetch(`${baseURL}/api/v1/sessions/missing/messages`, {
      text: 'hello',
    });
    let body = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(body, {
      error: {
        message: 'Unknown session: missing',
      },
    });
  } finally {
    await close(server);
  }
});

test('GET /api/v1/aeordb/events-url returns delegated AeorDB events URL', async () => {
  let server = await createServer({
    context: new AppContext({
      aeordb: {
        eventsURL: (params) => `events:${params.events}:${params.path_prefix}`,
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/aeordb/events-url?events=entries_created&path_prefix=/sessions`);
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      data: {
        url: 'events:entries_created:/sessions',
      },
    });
  } finally {
    await close(server);
  }
});

test('GET /api/v1/tokens returns token usage totals', async () => {
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      tokenUsage: {
        snapshot() {
          return {
            'openai/chatgpt/codex-agent': {
              tokensUsed: 1234,
              createdAt: 'first',
              updatedAt: 'now',
            },
          };
        },
        totalTokensUsed() {
          return 1234;
        },
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/tokens`);
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      data: {
        tokenUsage: {
          'openai/chatgpt/codex-agent': {
            tokensUsed: 1234,
            createdAt: 'first',
            updatedAt: 'now',
          },
        },
        totalTokensUsed: 1234,
      },
    });
  } finally {
    await close(server);
  }
});

test('GET /api/v1/events streams runtime events as SSE', async () => {
  let runtime = new EventEmitter();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      frameRuntime: runtime,
    }),
  });

  let baseURL = await listen(server);
  let response;

  try {
    response = await fetch(`${baseURL}/api/v1/events?sessionID=ses_1`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);

    let reader = response.body.getReader();
    let first = await readSSEEvent(reader);
    assert.deepEqual(first, {
      event: 'connected',
      data: { ok: true },
    });

    runtime.emit('event', {
      type: 'frame.phantom',
      sessionID: 'ses_2',
      frame: { id: 'skip_1' },
    });
    runtime.emit('event', {
      type: 'frame.phantom',
      sessionID: 'ses_1',
      frame: { id: 'think_1', type: 'AgentThinking', content: { text: 'thinking' } },
    });

    let second = await readSSEEvent(reader);
    assert.equal(second.event, 'frame.phantom');
    assert.equal(second.data.sessionID, 'ses_1');
    assert.equal(second.data.frame.type, 'AgentThinking');

    await reader.cancel();
  } finally {
    await close(server);
  }
});

test('GET /api/v1/events streams token usage updates as SSE', async () => {
  let runtime = new EventEmitter();
  let tokenUsage = new EventEmitter();
  tokenUsage.snapshot = () => ({});
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      frameRuntime: runtime,
      tokenUsage,
    }),
  });

  let baseURL = await listen(server);
  let response;

  try {
    response = await fetch(`${baseURL}/api/v1/events`);
    assert.equal(response.status, 200);

    let reader = response.body.getReader();
    await readSSEEvent(reader);

    tokenUsage.emit('updated', {
      tokenUsage: {
        'openai/chatgpt/codex-agent': {
          tokensUsed: 44,
          createdAt: 'first',
          updatedAt: 'now',
        },
      },
      totalTokensUsed: 44,
    });

    let second = await readSSEEvent(reader);
    assert.equal(second.event, 'tokens.updated');
    assert.equal(second.data.totalTokensUsed, 44);

    await reader.cancel();
  } finally {
    await close(server);
  }
});

async function readSSEEvent(reader) {
  let decoder = new TextDecoder();
  let buffer = '';
  while (!buffer.includes('\n\n')) {
    let result = await reader.read();
    if (result.done)
      throw new Error('SSE stream ended before an event arrived');
    buffer += decoder.decode(result.value, { stream: true });
  }

  let block = buffer.slice(0, buffer.indexOf('\n\n'));
  let event = 'message';
  let data = [];
  for (let line of block.split('\n')) {
    if (line.startsWith('event:'))
      event = line.slice('event:'.length).trim();
    if (line.startsWith('data:'))
      data.push(line.slice('data:'.length).trimStart());
  }

  return {
    event,
    data: JSON.parse(data.join('\n')),
  };
}

test('GET /api/v1/agent-providers lists plugin-declared providers', async () => {
  let agentManager = createAgentManager();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      agentManager,
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/agent-providers`);
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(agentManager.calls[0].method, 'listProviders');
    assert.equal(body.data.providers[0].pluginID, 'test-agent');
    assert.equal(body.data.providers[0].configFields[1].secret, true);
  } finally {
    await close(server);
  }
});

test('agent routes create, list, read, update, and delete through AgentManager', async () => {
  let agentManager = createAgentManager();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      agentManager,
    }),
  });

  let baseURL = await listen(server);

  try {
    let createResponse = await jsonFetch(`${baseURL}/api/v1/agents`, {
      name: 'Coder',
      pluginID: 'test-agent',
      character: 'You are a careful engineer.',
      config: { model: 'sonnet' },
      secrets: { apiKey: 'sk-secret-1234' },
    });
    let createBody = await createResponse.json();
    assert.equal(createResponse.status, 201);
    assert.equal(createBody.data.agent.secrets, undefined);

    let listResponse = await fetch(`${baseURL}/api/v1/agents?limit=25&offset=5`);
    assert.equal(listResponse.status, 200);

    let getResponse = await fetch(`${baseURL}/api/v1/agents/agent_1`);
    assert.equal(getResponse.status, 200);

    let updateResponse = await jsonFetch(`${baseURL}/api/v1/agents/agent_1`, {
      name: 'Reviewer',
      character: 'You are a skeptical reviewer.',
      config: { model: 'opus' },
      clearSecrets: [ 'apiKey' ],
    }, { method: 'PATCH' });
    assert.equal(updateResponse.status, 200);

    let deleteResponse = await fetch(`${baseURL}/api/v1/agents/agent_1`, { method: 'DELETE' });
    assert.equal(deleteResponse.status, 204);

    assert.deepEqual(agentManager.calls.map((call) => call.method), [
      'createAgent',
      'listAgents',
      'getAgent',
      'updateAgent',
      'deleteAgent',
    ]);
    assert.deepEqual(agentManager.calls[1].options, { limit: 25, offset: 5 });
    assert.equal(agentManager.calls[0].input.character, 'You are a careful engineer.');
    assert.equal(agentManager.calls[3].input.character, 'You are a skeptical reviewer.');
  } finally {
    await close(server);
  }
});

test('agent crown routes toggle master status and list masters', async () => {
  let agentManager = createAgentManager();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      agentManager,
    }),
  });

  let baseURL = await listen(server);

  try {
    let crownResponse = await jsonFetch(`${baseURL}/api/v1/agents/agent_1/crown`, {}, { method: 'POST' });
    let crownBody = await crownResponse.json();
    assert.equal(crownResponse.status, 200);
    assert.ok(crownBody.data.agent.crownedAt > 0);
    // The crown response includes the authoritative master set for client sync.
    assert.deepEqual(crownBody.data.masters.map((agent) => agent.id), [ 'master_1' ]);

    let uncrownResponse = await jsonFetch(`${baseURL}/api/v1/agents/agent_1/uncrown`, {}, { method: 'POST' });
    assert.equal(uncrownResponse.status, 200);
    assert.equal((await uncrownResponse.json()).data.agent.crownedAt, null);

    let mastersResponse = await fetch(`${baseURL}/api/v1/agents/masters`);
    let mastersBody = await mastersResponse.json();
    assert.equal(mastersResponse.status, 200);
    assert.deepEqual(mastersBody.data.masters.map((agent) => agent.name), [ 'Master One' ]);
    assert.equal('defaultAgent' in mastersBody.data, false);

    let resolveResponse = await fetch(`${baseURL}/api/v1/agents/masters?resolve=1&exclude=master_1`);
    let resolveBody = await resolveResponse.json();
    assert.equal(resolveResponse.status, 200);
    assert.equal(resolveBody.data.defaultAgent.id, 'master_1');

    let resolveCall = agentManager.calls.find((call) => call.method === 'resolveDefaultAgent');
    assert.deepEqual(resolveCall.options.excludeAgentIDs, [ 'master_1' ]);
  } finally {
    await close(server);
  }
});

test('agent compaction-bot routes toggle designation and list bots', async () => {
  let agentManager = createAgentManager();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      agentManager,
    }),
  });

  let baseURL = await listen(server);

  try {
    let crownResponse = await jsonFetch(`${baseURL}/api/v1/agents/agent_1/compact-crown`, {}, { method: 'POST' });
    let crownBody = await crownResponse.json();
    assert.equal(crownResponse.status, 200);
    assert.ok(crownBody.data.agent.compactionCrownedAt > 0);
    // The response includes the authoritative compaction-bot list for sync.
    assert.deepEqual(crownBody.data.compactionBots.map((agent) => agent.id), [ 'bot_1' ]);

    let uncrownResponse = await jsonFetch(`${baseURL}/api/v1/agents/agent_1/compact-uncrown`, {}, { method: 'POST' });
    assert.equal(uncrownResponse.status, 200);
    assert.equal((await uncrownResponse.json()).data.agent.compactionCrownedAt, null);

    let botsResponse = await fetch(`${baseURL}/api/v1/agents/compaction-bots`);
    let botsBody = await botsResponse.json();
    assert.equal(botsResponse.status, 200);
    assert.deepEqual(botsBody.data.compactionBots.map((agent) => agent.name), [ 'Bot One' ]);

    let called = agentManager.calls.find((call) => call.method === 'setAgentCompactionBotCrowned');
    assert.deepEqual(called, { method: 'setAgentCompactionBotCrowned', agentID: 'agent_1', crowned: true });
  } finally {
    await close(server);
  }
});

test('agent routes validate request bodies and report missing agents', async () => {
  let agentManager = createAgentManager();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      agentManager,
    }),
  });

  let baseURL = await listen(server);

  try {
    let invalidCreate = await jsonFetch(`${baseURL}/api/v1/agents`, {
      name: '',
      pluginID: 'test-agent',
    });
    assert.equal(invalidCreate.status, 400);

    let invalidPatch = await jsonFetch(`${baseURL}/api/v1/agents/agent_1`, {
      config: [],
    }, { method: 'PATCH' });
    assert.equal(invalidPatch.status, 400);

    let invalidCharacter = await jsonFetch(`${baseURL}/api/v1/agents/agent_1`, {
      character: {},
    }, { method: 'PATCH' });
    assert.equal(invalidCharacter.status, 400);

    let invalidCharacterCompressed = await jsonFetch(`${baseURL}/api/v1/agents/agent_1`, {
      characterCompressed: {},
    }, { method: 'PATCH' });
    assert.equal(invalidCharacterCompressed.status, 400);

    let overLimitCharacterCompressed = await jsonFetch(`${baseURL}/api/v1/agents/agent_1`, {
      characterCompressed: 'x'.repeat(401),
    }, { method: 'PATCH' });
    assert.equal(overLimitCharacterCompressed.status, 400);

    let missing = await fetch(`${baseURL}/api/v1/agents/missing`);
    let body = await missing.json();
    assert.equal(missing.status, 404);
    assert.equal(body.error.message, 'Unknown agent: missing');
  } finally {
    await close(server);
  }
});

test('team routes create, list, read, update, add/remove members, and delete through TeamManager', async () => {
  let teamManager = createTeamManager();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      agentManager: createAgentManager(),
      teamManager,
    }),
  });

  let baseURL = await listen(server);

  try {
    let createResponse = await jsonFetch(`${baseURL}/api/v1/teams`, {
      name: 'Builders',
      members: [
        { type: 'agent', actorID: 'agent_1', name: 'Coder' },
        { type: 'user', actorID: 'usr_1', name: 'Wyatt' },
      ],
    });
    assert.equal(createResponse.status, 201);

    let listResponse = await fetch(`${baseURL}/api/v1/teams?limit=25&offset=5`);
    assert.equal(listResponse.status, 200);

    let getResponse = await fetch(`${baseURL}/api/v1/teams/team_1`);
    assert.equal(getResponse.status, 200);

    let updateResponse = await jsonFetch(`${baseURL}/api/v1/teams/team_1`, {
      name: 'Reviewers',
      members: [{ type: 'agent', actorID: 'agent_2', name: 'Mr. Bennett' }],
    }, { method: 'PATCH' });
    assert.equal(updateResponse.status, 200);

    let addResponse = await jsonFetch(`${baseURL}/api/v1/teams/team_1/members`, {
      type: 'agent',
      actorID: 'agent_3',
      name: 'Critic',
    });
    assert.equal(addResponse.status, 200);

    let removeResponse = await fetch(`${baseURL}/api/v1/teams/team_1/members/agent_3?type=agent`, { method: 'DELETE' });
    assert.equal(removeResponse.status, 200);

    let deleteResponse = await fetch(`${baseURL}/api/v1/teams/team_1`, { method: 'DELETE' });
    assert.equal(deleteResponse.status, 204);

    assert.deepEqual(teamManager.calls.map((call) => call.method), [
      'createTeam',
      'listTeams',
      'getTeam',
      'updateTeam',
      'addMember',
      'removeMember',
      'deleteTeam',
    ]);
    assert.deepEqual(teamManager.calls[1].options, { limit: 25, offset: 5 });
    assert.equal(teamManager.calls[0].input.members[1].type, 'user');
    assert.deepEqual(teamManager.calls[5].input, { actorID: 'agent_3', type: 'agent' });
  } finally {
    await close(server);
  }
});

test('team routes validate request bodies and report missing teams', async () => {
  let teamManager = createTeamManager();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      agentManager: createAgentManager(),
      teamManager,
    }),
  });

  let baseURL = await listen(server);

  try {
    let invalidCreate = await jsonFetch(`${baseURL}/api/v1/teams`, {
      name: '',
    });
    assert.equal(invalidCreate.status, 400);

    let invalidMembers = await jsonFetch(`${baseURL}/api/v1/teams/team_1`, {
      members: {},
    }, { method: 'PATCH' });
    assert.equal(invalidMembers.status, 400);

    let invalidMember = await jsonFetch(`${baseURL}/api/v1/teams/team_1/members`, {
      type: 'service',
      actorID: 'svc_1',
    });
    assert.equal(invalidMember.status, 400);

    let missing = await fetch(`${baseURL}/api/v1/teams/missing`);
    let body = await missing.json();
    assert.equal(missing.status, 404);
    assert.equal(body.error.message, 'Unknown team: missing');
  } finally {
    await close(server);
  }
});

test('POST /api/v1/auth/magic-link forwards email to the auth service', async () => {
  let seen;
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      authService: {
        async requestMagicLink(email, options) {
          seen = { email, options };
          return { ok: true };
        },
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await jsonFetch(`${baseURL}/api/v1/auth/magic-link`, {
      email: 'alice@example.com',
    });
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(seen.email, 'alice@example.com');
    assert.equal(typeof seen.options.userAgent, 'string');
    assert.equal(typeof seen.options.ip, 'string');
    assert.deepEqual(body, { data: { ok: true } });
  } finally {
    await close(server);
  }
});

test('GET /api/v1/auth/magic-link/verify forwards code to the auth service', async () => {
  let seenCode;
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      authService: {
        async verifyMagicLink(code) {
          seenCode = code;
          return { token: 'access', refresh_token: 'refresh', expires_at: 123 };
        },
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/auth/magic-link/verify?code=abc+123`);
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(seenCode, 'abc 123');
    assert.deepEqual(body, {
      data: {
        token: 'access',
        refresh_token: 'refresh',
        expires_at: 123,
      },
    });
  } finally {
    await close(server);
  }
});

test('POST /api/v1/auth/token forwards api_key to the auth service', async () => {
  let seenAPIKey;
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      authService: {
        async exchangeApiKey(apiKey) {
          seenAPIKey = apiKey;
          return { token: 'access', refresh_token: 'refresh', expires_at: 123 };
        },
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await jsonFetch(`${baseURL}/api/v1/auth/token`, {
      api_key: 'kikx_secret',
    });
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(seenAPIKey, 'kikx_secret');
    assert.deepEqual(body, {
      data: {
        token: 'access',
        refresh_token: 'refresh',
        expires_at: 123,
      },
    });
  } finally {
    await close(server);
  }
});

test('POST /api/v1/auth/refresh forwards refresh_token to the auth service', async () => {
  let seenRefreshToken;
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      authService: {
        async refreshToken(refreshToken) {
          seenRefreshToken = refreshToken;
          return { token: 'new-access', refresh_token: 'new-refresh', expires_at: 456 };
        },
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await jsonFetch(`${baseURL}/api/v1/auth/refresh`, {
      refresh_token: 'rt_secret',
    });
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(seenRefreshToken, 'rt_secret');
    assert.deepEqual(body, {
      data: {
        token: 'new-access',
        refresh_token: 'new-refresh',
        expires_at: 456,
      },
    });
  } finally {
    await close(server);
  }
});

test('auth routes reject malformed JSON', async () => {
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/auth/magic-link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: '{',
    });
    let body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      error: {
        message: 'Request body must be valid JSON',
      },
    });
  } finally {
    await close(server);
  }
});

test('auth routes validate required fields', async () => {
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await jsonFetch(`${baseURL}/api/v1/auth/token`, {});
    let body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      error: {
        message: 'api_key is required',
      },
    });
  } finally {
    await close(server);
  }
});

test('unknown routes return JSON 404', async () => {
  let server = await createServer({
    context: new AppContext({
      aeordb: {
        eventsURL: () => 'unused',
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/missing`);
    let body = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(body, {
      error: {
        message: 'Not Found',
      },
    });
  } finally {
    await close(server);
  }
});

test('GET / serves the browser client index', async () => {
  let fixture = await createStaticFixture();
  let server = await createServer({
    clientRoot: fixture.clientRoot,
    aeorWebComponentsRoot: fixture.aeorWebComponentsRoot,
    context: new AppContext({
      aeordb: {
        eventsURL: () => 'unused',
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/`);
    let body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(body, '<!doctype html><title>Kikx</title>');
  } finally {
    await close(server);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('GET /vendor/aeor-web-components serves shared component assets', async () => {
  let fixture = await createStaticFixture();
  let server = await createServer({
    clientRoot: fixture.clientRoot,
    aeorWebComponentsRoot: fixture.aeorWebComponentsRoot,
    context: new AppContext({
      aeordb: {
        eventsURL: () => 'unused',
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/vendor/aeor-web-components/elements.js`);
    let body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(body, 'export const elements = {};');
  } finally {
    await close(server);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('GET /client/*.mjs serves browser modules with JavaScript MIME type', async () => {
  let fixture = await createStaticFixture();
  let server = await createServer({
    clientRoot: fixture.clientRoot,
    sharedRoot: fixture.sharedRoot,
    aeorWebComponentsRoot: fixture.aeorWebComponentsRoot,
    context: new AppContext({
      aeordb: {
        eventsURL: () => 'unused',
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/client/app.mjs`);
    let body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(body, "import './components/kikx-app.mjs';");
  } finally {
    await close(server);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('GET /shared/*.mjs serves shared browser-safe modules with JavaScript MIME type', async () => {
  let fixture = await createStaticFixture();
  let server = await createServer({
    clientRoot: fixture.clientRoot,
    sharedRoot: fixture.sharedRoot,
    aeorWebComponentsRoot: fixture.aeorWebComponentsRoot,
    context: new AppContext({
      aeordb: {
        eventsURL: () => 'unused',
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/shared/frame-manager/frame-manager.mjs`);
    let body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(body, 'export class FrameManager {}');
  } finally {
    await close(server);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('static routes reject path traversal outside configured roots', async () => {
  let fixture = await createStaticFixture();
  let server = await createServer({
    clientRoot: fixture.clientRoot,
    sharedRoot: fixture.sharedRoot,
    aeorWebComponentsRoot: fixture.aeorWebComponentsRoot,
    context: new AppContext({
      aeordb: {
        eventsURL: () => 'unused',
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/client/%2e%2e%2fpackage.json`);
    let body = await response.text();

    assert.equal(response.status, 403);
    assert.equal(body, 'Forbidden');
  } finally {
    await close(server);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('POST /api/v1/sessions/previews returns bounded previews in one request', async () => {
  let runtime = createRuntime();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      frameRuntime: runtime,
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/api/v1/sessions/previews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionIDs: [ 'ses_1', 'ses_2' ], previewCount: 4 }),
    });
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.data.previews.map((entry) => entry.sessionID), [ 'ses_1', 'ses_2' ]);
    assert.equal(body.data.previews[0].heads[0].type, 'UserMessage');
    assert.deepEqual(runtime.calls.at(-1), {
      method: 'listSessionPreviews',
      sessionIDs: [ 'ses_1', 'ses_2' ],
      options: { previewCount: 4 },
    });
  } finally {
    await close(server);
  }
});

test('POST /api/v1/sessions/previews validates its request body', async () => {
  let runtime = createRuntime();
  let server = await createServer({
    context: new AppContext({
      aeordb: {},
      frameRuntime: runtime,
    }),
  });

  let baseURL = await listen(server);

  try {
    let missing = await fetch(`${baseURL}/api/v1/sessions/previews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);

    let badCount = await fetch(`${baseURL}/api/v1/sessions/previews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionIDs: [ 'ses_1' ], previewCount: 0 }),
    });
    assert.equal(badCount.status, 400);

    let badBody = await fetch(`${baseURL}/api/v1/sessions/previews`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not json',
    });
    assert.equal(badBody.status, 400);
  } finally {
    await close(server);
  }
});
