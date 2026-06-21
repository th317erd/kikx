'use strict';

import fsp from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_ROOT_PATH = '/kikx';

export class AgentCwdStore {
  constructor(options = {}) {
    let {
      aeordb,
      rootPath = DEFAULT_ROOT_PATH,
      clock = () => Date.now(),
      baseCWD = process.cwd(),
      validateDirectory = true,
    } = options;

    if (!aeordb)
      throw new TypeError('AgentCwdStore requires an aeordb client');

    this.aeordb = aeordb;
    this.rootPath = normalizeRoot(rootPath);
    this.clock = clock;
    this.baseCWD = path.resolve(baseCWD);
    this.validateDirectory = validateDirectory !== false;
  }

  async getCWD(agentID, sessionID) {
    let normalizedAgentID = normalizeRequiredString(agentID, 'agentID');
    let normalizedSessionID = normalizeRequiredString(sessionID, 'sessionID');
    let state = null;

    try {
      state = await this.aeordb.getFile(this.cwdPath(normalizedSessionID, normalizedAgentID));
    } catch (error) {
      if (error.status !== 404)
        throw error;
    }

    return normalizeCWDState(state, {
      agentID: normalizedAgentID,
      sessionID: normalizedSessionID,
      cwd: this.baseCWD,
      configured: false,
      now: this.clock(),
    });
  }

  async setCWD(agentID, sessionID, cwd) {
    let normalizedAgentID = normalizeRequiredString(agentID, 'agentID');
    let normalizedSessionID = normalizeRequiredString(sessionID, 'sessionID');
    let current = await this.getCWD(normalizedAgentID, normalizedSessionID);
    let resolved = resolveRequestedCWD(cwd, current.cwd || this.baseCWD);

    if (this.validateDirectory)
      await assertDirectory(resolved);

    let now = this.clock();
    let state = {
      namespace: 'agent-runtime',
      ownerType: 'agent',
      ownerID: normalizedAgentID,
      scopeID: normalizedSessionID,
      key: 'cwd',
      valueText: resolved,
      agentID: normalizedAgentID,
      sessionID: normalizedSessionID,
      cwd: resolved,
      configured: true,
      createdAt: current.configured ? current.createdAt : now,
      updatedAt: now,
    };

    await this.aeordb.putFile(this.cwdPath(normalizedSessionID, normalizedAgentID), state);
    return cloneJSON(state);
  }

  async clearCWD(agentID, sessionID) {
    let normalizedAgentID = normalizeRequiredString(agentID, 'agentID');
    let normalizedSessionID = normalizeRequiredString(sessionID, 'sessionID');

    try {
      await this.aeordb.deleteFile(this.cwdPath(normalizedSessionID, normalizedAgentID));
    } catch (error) {
      if (error.status !== 404)
        throw error;
    }

    return await this.getCWD(normalizedAgentID, normalizedSessionID);
  }

  cwdPath(sessionID, agentID) {
    return `${this.rootPath}/sessions/${encodeURIComponent(normalizeRequiredString(sessionID, 'sessionID'))}/values/agents/${encodeURIComponent(normalizeRequiredString(agentID, 'agentID'))}/cwd.json`;
  }
}

function normalizeCWDState(value, defaults = {}) {
  let state = isPlainObject(value) ? value : {};
  let cwd = typeof state.cwd === 'string' && state.cwd.trim() !== ''
    ? path.resolve(state.cwd)
    : path.resolve(defaults.cwd || process.cwd());

  return {
    namespace: 'agent-runtime',
    ownerType: 'agent',
    ownerID: normalizeRequiredString(state.ownerID || state.agentID || defaults.agentID, 'agentID'),
    scopeID: normalizeRequiredString(state.scopeID || state.sessionID || defaults.sessionID, 'sessionID'),
    key: 'cwd',
    valueText: cwd,
    agentID: normalizeRequiredString(state.agentID || state.ownerID || defaults.agentID, 'agentID'),
    sessionID: normalizeRequiredString(state.sessionID || state.scopeID || defaults.sessionID, 'sessionID'),
    cwd,
    configured: state.configured === true || defaults.configured === true,
    createdAt: state.createdAt || defaults.now || Date.now(),
    updatedAt: state.updatedAt || state.createdAt || defaults.now || Date.now(),
  };
}

function resolveRequestedCWD(cwd, baseCWD) {
  if (typeof cwd !== 'string' || cwd.trim() === '')
    throw new TypeError('cwd must be a non-empty string');

  return path.resolve(path.resolve(baseCWD), cwd.trim());
}

async function assertDirectory(cwd) {
  let stat;
  try {
    stat = await fsp.stat(cwd);
  } catch (error) {
    throw new Error(`cwd does not exist: ${cwd}`);
  }

  if (!stat.isDirectory())
    throw new Error(`cwd is not a directory: ${cwd}`);
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${fieldName} must be a non-empty string`);

  return value.trim();
}

function normalizeRoot(rootPath) {
  if (!rootPath || typeof rootPath !== 'string')
    throw new TypeError('rootPath must be a non-empty string');

  return `/${rootPath.replace(/^\/+|\/+$/g, '')}`;
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}
