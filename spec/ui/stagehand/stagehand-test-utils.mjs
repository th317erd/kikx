'use strict';

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { EventEmitter } from 'node:events';

import { AppContext } from '../../../src/core/app/app-context.mjs';
import { AeorDBClient } from '../../../src/core/aeordb/aeordb-client.mjs';
import {
  parseMentionReferences,
  resolveMentionActors,
} from '../../../src/core/mentions/index.mjs';
import { createServer } from '../../../src/server/create-server.mjs';

export async function loadStagehandOpenAIAPIKey(options = {}) {
  let envKey = firstNonEmpty(
    process.env.KIKX_STAGEHAND_OPENAI_API_KEY,
    process.env.OPENAI_API_KEY,
  );
  if (envKey)
    return envKey;

  let env = await readEnvFile(options.envPath || '.env.dev');
  let rootKey = firstNonEmpty(process.env.AEORDB_ROOT_KEY, env.AEORDB_ROOT_KEY);
  if (!rootKey)
    return '';

  let baseURL = firstNonEmpty(process.env.AEORDB_URL, env.AEORDB_URL, 'http://127.0.0.1:6830');
  let agentName = firstNonEmpty(options.agentName, process.env.KIKX_STAGEHAND_AGENT_NAME, 'Test 1');
  let bootstrapClient = new AeorDBClient({
    baseURL,
    fetchImpl: globalThis.fetch,
  });
  let tokenResult = await bootstrapClient.exchangeAPIKey(rootKey);
  let aeordb = new AeorDBClient({
    baseURL,
    token: tokenResult.token,
    fetchImpl: globalThis.fetch,
  });

  let listing;
  try {
    listing = await aeordb.listDirectory('/kikx/agents', {
      depth: -1,
      glob: '**/agent.json',
      limit: 500,
    });
  } catch (error) {
    if (error?.status === 404)
      return '';

    throw error;
  }

  let paths = [];
  for (let item of listing?.items || []) {
    if (item?.path)
      paths.push(item.path);
  }

  if (paths.length === 0)
    return '';

  let files = await aeordb.fetchFiles(paths);
  let fallbackAPIKey = '';
  for (let path of paths) {
    let agent = parseAgentFile(files?.[path]);
    if (agent?.name === agentName)
      return firstNonEmpty(agent.secrets?.apiKey, agent.secrets?.openaiApiKey, agent.secrets?.openAIAPIKey);

    fallbackAPIKey ||= firstNonEmpty(agent?.secrets?.apiKey, agent?.secrets?.openaiApiKey, agent?.secrets?.openAIAPIKey);
  }

  return fallbackAPIKey;
}

export function findChromeExecutable() {
  for (let candidate of [
    process.env.KIKX_STAGEHAND_CHROME_PATH,
    process.env.CHROME_PATH,
    '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]) {
    if (candidate && fsSync.existsSync(candidate))
      return candidate;
  }

  return '';
}

export async function startStagehandUIServer(options = {}) {
  let agents = Array.isArray(options.agents) ? options.agents : [];
  let tokenUsage = options.tokenUsage || createTokenUsageStub(options.tokenUsageSnapshot || {});
  let frameRuntime = options.frameRuntime || new StagehandFrameRuntime({
    sessions: options.sessions || [],
    agents,
  });
  let context = new AppContext({
    aeordb: createAuthStub(),
    agentManager: createAgentManagerStub(agents),
    frameRuntime,
    tokenUsage,
    pluginLoadPromise: Promise.resolve(),
  });
  let server = createServer({ context });
  let baseURL = await listen(server);

  return {
    baseURL,
    frameRuntime,
    tokenUsage,
    async close() {
      await closeServer(server);
    },
  };
}

class StagehandFrameRuntime extends EventEmitter {
  constructor(options = {}) {
    super();
    let sessions = Array.isArray(options) ? options : options.sessions || [];
    this.agents = Array.isArray(options.agents) ? options.agents : [];
    this.sessions = sessions.length > 0
      ? sessions.map((session) => normalizeSession(session))
      : [ normalizeSession({ id: 'session_1', title: 'Session 1' }) ];
    this.framesBySessionID = new Map();
    this.nextSessionNumber = this.sessions.length + 1;
  }

  async listSessions(options = {}) {
    let offset = options.offset || 0;
    let limit = options.limit || this.sessions.length;
    return this.sessions.slice(offset, offset + limit);
  }

  async createSession(input = {}) {
    let session = normalizeSession({
      id: `session_${this.nextSessionNumber}`,
      title: input.title || `Session ${this.nextSessionNumber}`,
    });
    this.nextSessionNumber++;
    this.sessions.push(session);
    this.emitEvent('session.saved', {
      sessionID: session.id,
      session,
    });
    return session;
  }

  async listFrames(sessionID) {
    return this.framesBySessionID.get(sessionID) || [];
  }

  async updateSession(sessionID, input = {}) {
    let session = this.sessions.find((candidate) => candidate.id === sessionID);
    if (!session) {
      let error = new Error(`Unknown session: ${sessionID}`);
      error.status = 404;
      throw error;
    }

    session.title = input.title || session.title;
    session.updatedAt = Date.now();
    this.emitEvent('session.saved', {
      sessionID: session.id,
      session,
    });
    return session;
  }

  async appendUserMessage(sessionID, input = {}) {
    let session = this.sessions.find((candidate) => candidate.id === sessionID);
    if (!session) {
      let error = new Error(`Unknown session: ${sessionID}`);
      error.status = 404;
      throw error;
    }

    let frames = this.framesBySessionID.get(sessionID) || [];
    let frame = {
      id: `frame_${frames.length + 1}`,
      type: 'UserMessage',
      sessionID,
      interactionID: `interaction_${frames.length + 1}`,
      authorType: 'user',
      authorID: 'stagehand-test',
      order: frames.length + 1,
      timestamp: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hidden: false,
      deleted: false,
      content: { text: input.text },
    };
    let mentions = await this.resolveMentions(input.text);
    if (Object.keys(mentions).length > 0)
      frame.mentions = mentions;

    frames.push(frame);
    this.framesBySessionID.set(sessionID, frames);
    session.messageCount = frames.length;
    this.emitEvent('frame.added', {
      sessionID,
      frame,
    });
    this.emitEvent('session.saved', {
      sessionID,
      session,
    });

    return {
      session,
      frame,
      commit: { id: `commit_${frames.length}`, order: frames.length },
    };
  }

  emitEvent(type, payload) {
    let event = { type, ...payload };
    this.emit(type, event);
    this.emit('event', event);
  }

  async resolveMentions(text) {
    let references = parseMentionReferences(text);
    if (references.length === 0)
      return {};

    return await resolveMentionActors(references, {
      agentManager: createAgentManagerStub(this.agents),
    });
  }
}

function createTokenUsageStub(initialSnapshot = {}) {
  let emitter = new EventEmitter();
  let snapshot = initialSnapshot;
  emitter.snapshot = () => snapshot;
  emitter.totalTokensUsed = () => totalTokensUsed(snapshot);
  emitter.load = async () => snapshot;
  emitter.setSnapshot = (nextSnapshot) => {
    snapshot = nextSnapshot || {};
    emitter.emit('updated', {
      tokenUsage: snapshot,
      totalTokensUsed: totalTokensUsed(snapshot),
    });
  };
  return emitter;
}

function totalTokensUsed(snapshot) {
  let total = 0;
  for (let entry of Object.values(snapshot || {})) {
    let value = Number(entry?.tokensUsed);
    if (Number.isFinite(value) && value > 0)
      total += Math.trunc(value);
  }

  return total;
}

function normalizeSession(input = {}) {
  return {
    id: input.id,
    title: input.title || input.id,
    organizationID: input.organizationID || null,
    createdByUserID: input.createdByUserID || null,
    messageCount: input.messageCount || 0,
    participantAgentIDs: Array.isArray(input.participantAgentIDs) ? input.participantAgentIDs : [],
    createdAt: input.createdAt || Date.now(),
    updatedAt: input.updatedAt || input.createdAt || Date.now(),
    createdClock: input.createdClock || null,
    updatedClock: input.updatedClock || input.createdClock || null,
  };
}

function createAuthStub() {
  return {
    eventsURL() {
      return 'http://127.0.0.1/system/events';
    },
    async requestMagicLink() {
      return { message: 'sent' };
    },
    async verifyMagicLink() {
      return {
        token: 'stagehand-test-token',
        refresh_token: 'stagehand-test-refresh',
      };
    },
    async exchangeAPIKey() {
      return {
        token: 'stagehand-test-token',
        refresh_token: 'stagehand-test-refresh',
      };
    },
    async refreshToken() {
      return {
        token: 'stagehand-test-token',
        refresh_token: 'stagehand-test-refresh',
      };
    },
  };
}

function createAgentManagerStub(agents = []) {
  return {
    listProviders() {
      return [];
    },
    async listAgents() {
      return agents.slice();
    },
    async getAgent(agentID) {
      let agent = agents.find((candidate) => candidate.id === agentID);
      if (agent)
        return agent;

      let error = new Error(`Unknown agent: ${agentID}`);
      error.status = 404;
      throw error;
    },
    async resolveAgent(reference) {
      let lowered = String(reference || '').trim().toLowerCase();
      let agent = agents.find((candidate) => (
        candidate.id === reference
        || candidate.name === reference
        || candidate.name?.toLowerCase() === lowered
      ));
      if (agent)
        return agent;

      let error = new Error(`Agent not found: ${reference}`);
      error.status = 404;
      throw error;
    },
    async createAgent() {
      throw new Error('Agent creation is not available in Stagehand UI tests');
    },
    async updateAgent() {
      throw new Error('Agent updates are not available in Stagehand UI tests');
    },
    async deleteAgent() {},
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  let address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Unable to determine Stagehand UI server address');

  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function readEnvFile(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT')
      return {};

    throw error;
  }

  let output = {};
  for (let line of text.split(/\r?\n/g)) {
    line = line.trim();
    if (!line || line.startsWith('#'))
      continue;

    let index = line.indexOf('=');
    if (index < 1)
      continue;

    output[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }

  return output;
}

function parseAgentFile(entry) {
  if (!entry)
    return null;

  let content = entry.content ?? entry;
  if (typeof content !== 'string')
    return content;

  return JSON.parse(content);
}

function firstNonEmpty(...values) {
  for (let value of values) {
    if (typeof value === 'string' && value.trim() !== '')
      return value.trim();
  }

  return '';
}
