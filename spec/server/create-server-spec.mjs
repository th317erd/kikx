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
  };
}

function createAgentManager() {
  let calls = [];
  return {
    calls,
    listProviders() {
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

async function createStaticFixture() {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-static-'));
  let clientRoot = path.join(root, 'client');
  let aeorWebComponentsRoot = path.join(root, 'aeor-web-components');

  await fs.mkdir(path.join(clientRoot, 'styles'), { recursive: true });
  await fs.mkdir(path.join(aeorWebComponentsRoot, 'components'), { recursive: true });
  await fs.writeFile(path.join(clientRoot, 'index.html'), '<!doctype html><title>Kikx</title>');
  await fs.writeFile(path.join(clientRoot, 'app.mjs'), "import './components/kikx-app.mjs';");
  await fs.writeFile(path.join(clientRoot, 'styles', 'app.css'), 'body { color: white; }');
  await fs.writeFile(path.join(aeorWebComponentsRoot, 'elements.js'), 'export const elements = {};');

  return { root, clientRoot, aeorWebComponentsRoot };
}

test('GET /health reports service state', async () => {
  let server = createServer({
    context: new AppContext({
      aeordb: {
        eventsURL: () => 'http://aeor.test/system/events',
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await fetch(`${baseURL}/health`);
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      ok: true,
      services: {
        aeordb: true,
      },
    });
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
  let server = createServer({
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
  let server = createServer({
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
  let server = createServer({
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

test('GET /api/v1/sessions lists runtime sessions', async () => {
  let runtime = createRuntime();
  let server = createServer({
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
  let server = createServer({
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
  let server = createServer({
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
      },
    });
    assert.equal(body.data.session.title, 'Session 1');
  } finally {
    await close(server);
  }
});

test('PATCH /api/v1/sessions/:sessionID updates a runtime session title', async () => {
  let runtime = createRuntime();
  let server = createServer({
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
  let server = createServer({
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
  let server = createServer({
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
  let server = createServer({
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
  let server = createServer({
    context: new AppContext({
      aeordb: {
        async getFile() {
          return { id: 'usr_1', name: 'Wyatt Greenway', email: 'wyatt@example.com' };
        },
        async getSystemUser() {
          return { user_id: 'usr_1', username: 'wyatt@example.com', email: 'wyatt@example.com' };
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
  let server = createServer({
    context: new AppContext({
      aeordb: {
        async getFile(pathname) {
          if (pathname === '/kikx/tokens.json')
            return null;

          assert.equal(pathname, '/kikx/users/usr_1/profile.json');
          return { id: 'usr_1', name: 'Wyatt', email: 'wyatt@kikx.test' };
        },
        async getSystemUser(userID) {
          assert.equal(userID, 'usr_1');
          return { user_id: 'usr_1', username: 'wyatt@example.com', email: 'wyatt@example.com' };
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
      source: 'aeordb-user',
      createdAt: null,
      updatedAt: null,
    });
  } finally {
    await close(server);
  }
});

test('PATCH /api/v1/account saves display name and updates AeorDB email', async () => {
  let token = unsignedJWT({ sub: 'usr_1' });
  let writes = [];
  let updatedUser;
  let server = createServer({
    context: new AppContext({
      aeordb: {
        async getFile() {
          return { id: 'usr_1', name: 'Old Name', email: 'old@example.com', createdAt: 1000 };
        },
        async putFile(pathname, body) {
          writes.push({ pathname, body });
          return { path: pathname };
        },
        async getSystemUser() {
          return { user_id: 'usr_1', username: 'wyatt@example.com', email: 'old@example.com' };
        },
        async updateSystemUser(userID, body) {
          updatedUser = { userID, body };
          return { user_id: 'usr_1', username: 'wyatt@example.com', email: body.email };
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
      body: { email: 'new@example.com' },
    });
    assert.equal(writes.length, 2);
    assert.equal(writes[0].pathname, '/kikx/users/usr_1/profile.json');
    assert.equal(writes[0].body.name, 'New Name');
    assert.equal(writes[0].body.email, 'new@example.com');
    assert.equal(writes[1].body.email, 'new@example.com');
    assert.equal(body.data.account.name, 'New Name');
    assert.equal(body.data.account.email, 'new@example.com');
  } finally {
    await close(server);
  }
});

test('GET /api/v1/sessions/:sessionID/frames lists runtime frames', async () => {
  let runtime = createRuntime();
  let server = createServer({
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
        frames: [
          { id: 'msg_1', type: 'UserMessage', content: { text: 'hello' } },
        ],
      },
    });
    assert.deepEqual(runtime.calls.at(-1), {
      method: 'listFrames',
      sessionID: 'ses_1',
      options: {
        limit: 1000,
        offset: 0,
      },
    });
  } finally {
    await close(server);
  }
});

test('GET /api/v1/sessions/:sessionID/frames passes pagination options', async () => {
  let runtime = createRuntime();
  let server = createServer({
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
      options: {
        limit: 25,
        offset: 50,
      },
    });
  } finally {
    await close(server);
  }
});

test('GET /api/v1/tool-outputs/:outputID reads stored tool output with bounded defaults', async () => {
  let calls = [];
  let server = createServer({
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
  let server = createServer({
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
  let server = createServer({
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
  let server = createServer({
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
  let server = createServer({
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
  let server = createServer({
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
  let server = createServer({
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
  let server = createServer({
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
  let server = createServer({
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
  let server = createServer({
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

test('agent routes validate request bodies and report missing agents', async () => {
  let agentManager = createAgentManager();
  let server = createServer({
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

    let missing = await fetch(`${baseURL}/api/v1/agents/missing`);
    let body = await missing.json();
    assert.equal(missing.status, 404);
    assert.equal(body.error.message, 'Unknown agent: missing');
  } finally {
    await close(server);
  }
});

test('POST /api/v1/auth/magic-link forwards email to AeorDB', async () => {
  let seenEmail;
  let server = createServer({
    context: new AppContext({
      aeordb: {
        requestMagicLink: async (email) => {
          seenEmail = email;
          return { message: 'If an account exists, a login link has been sent.' };
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
    assert.equal(seenEmail, 'alice@example.com');
    assert.deepEqual(body, {
      data: {
        message: 'If an account exists, a login link has been sent.',
      },
    });
  } finally {
    await close(server);
  }
});

test('GET /api/v1/auth/magic-link/verify forwards code to AeorDB', async () => {
  let seenCode;
  let server = createServer({
    context: new AppContext({
      aeordb: {
        verifyMagicLink: async (code) => {
          seenCode = code;
          return { token: 'jwt', expires_in: 3600 };
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
        token: 'jwt',
        expires_in: 3600,
      },
    });
  } finally {
    await close(server);
  }
});

test('POST /api/v1/auth/token forwards api_key to AeorDB', async () => {
  let seenAPIKey;
  let server = createServer({
    context: new AppContext({
      aeordb: {
        exchangeAPIKey: async (apiKey) => {
          seenAPIKey = apiKey;
          return { token: 'jwt', refresh_token: 'refresh', expires_in: 3600 };
        },
      },
    }),
  });

  let baseURL = await listen(server);

  try {
    let response = await jsonFetch(`${baseURL}/api/v1/auth/token`, {
      api_key: 'aeor_secret',
    });
    let body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(seenAPIKey, 'aeor_secret');
    assert.deepEqual(body, {
      data: {
        token: 'jwt',
        refresh_token: 'refresh',
        expires_in: 3600,
      },
    });
  } finally {
    await close(server);
  }
});

test('POST /api/v1/auth/refresh forwards refresh_token to AeorDB', async () => {
  let seenRefreshToken;
  let server = createServer({
    context: new AppContext({
      aeordb: {
        refreshToken: async (refreshToken) => {
          seenRefreshToken = refreshToken;
          return { token: 'new-jwt', refresh_token: 'new-refresh', expires_in: 3600 };
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
        token: 'new-jwt',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      },
    });
  } finally {
    await close(server);
  }
});

test('auth routes reject malformed JSON', async () => {
  let server = createServer({
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
  let server = createServer({
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
  let server = createServer({
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
  let server = createServer({
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
  let server = createServer({
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
  let server = createServer({
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

test('static routes reject path traversal outside configured roots', async () => {
  let fixture = await createStaticFixture();
  let server = createServer({
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
    let response = await fetch(`${baseURL}/client/%2e%2e%2fpackage.json`);
    let body = await response.text();

    assert.equal(response.status, 403);
    assert.equal(body, 'Forbidden');
  } finally {
    await close(server);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
