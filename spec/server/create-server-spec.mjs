'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createServer } from '../../src/server/create-server.mjs';
import { AppContext } from '../../src/core/app/app-context.mjs';

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
    },
    body: JSON.stringify(body),
  });
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
    listSessions() {
      calls.push({ method: 'listSessions' });
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
    listFrames(sessionID) {
      calls.push({ method: 'listFrames', sessionID });
      return [
        { id: 'msg_1', type: 'UserMessage', content: { text: 'hello' } },
      ];
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
