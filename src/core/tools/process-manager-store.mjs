'use strict';

import fsp from 'node:fs/promises';

import { pathsFromItems, readJSONFiles } from '../aeordb/aeordb-file-utils.mjs';

export const DEFAULT_PROCESS_ROOT_PATH = '/kikx';

// Fields that are always persisted. Everything else on a live record (the OS
// handle, capture streams, completion promises, timers) is process-local and must
// never be serialized.
const PERSISTED_RECORD_FIELDS = [
  'id',
  'processID',
  'agentID',
  'sessionID',
  'frameID',
  'command',
  'shell',
  'cwd',
  'pid',
  'status',
  'exitCode',
  'signal',
  'timedOut',
  'timeoutMs',
  'startedAt',
  'startedAtMs',
  'updatedAt',
  'completedAt',
  'durationMs',
  'interruptedAt',
  'stdoutPath',
  'stderrPath',
  'stdoutBytes',
  'stderrBytes',
  'stdioClosedByManager',
  'stdioCloseGraceMs',
  'completionToolOutputID',
  'completionSizeBytes',
  'completionRetrieval',
  'completionInlineLimitBytes',
  'completionLarge',
  'completionStoreError',
  'killRequested',
  'wakeOnCompletion',
  'wakeFrameID',
  'wakeCompletionOutputID',
  'wakeError',
  'wakePausedAt',
  'error',
];

// Durable process records + captured stdio. Mirrors ToolOutputStore: process
// records live under `/kikx/sessions/<sessionID>/processes/<processID>.json`, and
// completed stdout/stderr are mirrored next to them so a restart can resolve a
// reloaded wake without the volatile /tmp capture files.
export class ProcessStore {
  constructor(options = {}) {
    let db = options.db || options.aeordb;
    let {
      rootPath = DEFAULT_PROCESS_ROOT_PATH,
      clock = () => new Date().toISOString(),
    } = options;

    if (!db)
      throw new TypeError('ProcessStore requires db (or the aeordb alias)');

    this.aeordb = db;
    this.db = db;
    this.rootPath = normalizeRoot(rootPath);
    this.clock = clock;
  }

  async saveRecord(record) {
    let path = this.pathFor(record);
    if (!path)
      return null;

    let persisted = {
      ...toPersistedRecord(record),
      updatedAt: record.updatedAt || this.clock(),
    };

    await this.aeordb.putFile(path, persisted);
    await this.saveStdio(record);
    return persisted;
  }

  async saveStdio(record) {
    let paths = this.stdioPathsFor(record);
    if (!paths)
      return;

    let stdout = await readTextFile(record.stdoutPath);
    let stderr = await readTextFile(record.stderrPath);
    await this.aeordb.putFile(paths.stdoutPath, stdout, { contentType: 'text/plain; charset=utf-8' });
    await this.aeordb.putFile(paths.stderrPath, stderr, { contentType: 'text/plain; charset=utf-8' });
  }

  async listRecords(options = {}) {
    let paths = await this.listRecordPaths(options);
    let reads = await readJSONFiles(this.aeordb, paths, {
      fallbackOnBatchError: true,
      continueOnError: true,
    });
    let records = [];

    for (let read of reads) {
      if (read.error || !read.value?.processID)
        continue;

      records.push(read.value);
    }

    return records;
  }

  async listRecordPaths(options = {}) {
    let result;
    try {
      result = await this.aeordb.listDirectory(`${this.rootPath}/sessions`, {
        depth: -1,
        glob: '**/processes/*.json',
        limit: options.limit,
        offset: options.offset,
      });
    } catch (error) {
      if (error?.status === 404)
        return [];

      throw error;
    }

    return pathsFromItems(result?.items);
  }

  async loadRecord(sessionID, processID) {
    let path = this.recordPath(sessionID, processID);
    if (!path)
      return null;

    try {
      return await this.aeordb.getFile(path);
    } catch (error) {
      if (error?.status === 404)
        return null;

      throw error;
    }
  }

  async readStdio(record) {
    // Prefer the live capture files (they hold the full output up to the crash),
    // then fall back to the durable copies persisted alongside the record.
    let liveStdout = await readTextFile(record?.stdoutPath);
    let liveStderr = await readTextFile(record?.stderrPath);
    let paths = this.stdioPathsFor(record);
    if (!paths)
      return null;

    let durableStdout = await readTextFileFromAeorDB(this.aeordb, paths.stdoutPath);
    let durableStderr = await readTextFileFromAeorDB(this.aeordb, paths.stderrPath);
    if (!liveStdout && !liveStderr && durableStdout == null && durableStderr == null)
      return null;

    return {
      stdout: liveStdout || durableStdout || '',
      stderr: liveStderr || durableStderr || '',
    };
  }

  pathFor(record) {
    return this.recordPath(record?.sessionID, record?.processID);
  }

  recordPath(sessionID, processID) {
    let normalizedSessionID = normalizeOptionalString(sessionID);
    let normalizedProcessID = normalizeOptionalString(processID);
    if (!normalizedSessionID || !normalizedProcessID)
      return null;

    return `${this.sessionRoot(normalizedSessionID)}/processes/${encodeSegment(normalizedProcessID)}.json`;
  }

  stdioPathsFor(record) {
    return this.stdioPaths(record?.sessionID, record?.processID);
  }

  stdioPaths(sessionID, processID) {
    let recordPath = this.recordPath(sessionID, processID);
    if (!recordPath)
      return null;

    let base = recordPath.replace(/\.json$/g, '');
    return {
      stdoutPath: `${base}.stdout.txt`,
      stderrPath: `${base}.stderr.txt`,
    };
  }

  sessionRoot(sessionID) {
    return `${this.rootPath}/sessions/${encodeSegment(sessionID)}`;
  }
}

export function toPersistedRecord(record = {}) {
  let output = {};
  for (let field of PERSISTED_RECORD_FIELDS) {
    if (record[field] !== undefined)
      output[field] = record[field];
  }

  return output;
}

async function readTextFile(filePath) {
  if (!filePath)
    return '';

  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT')
      return '';

    throw error;
  }
}

async function readTextFileFromAeorDB(aeordb, path) {
  try {
    let value = await aeordb.getFile(path, { expectJSON: false });
    return value == null ? '' : String(value);
  } catch (error) {
    if (error?.status === 404)
      return null;

    throw error;
  }
}

function normalizeRoot(value) {
  let path = normalizeRequiredString(value, 'rootPath').replace(/\/+$/g, '');
  return path.startsWith('/') ? path : `/${path}`;
}

function encodeSegment(value) {
  return encodeURIComponent(String(value));
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${fieldName} must be a non-empty string`);

  return value.trim();
}

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}
