'use strict';

import { readJSONFiles } from '../aeordb/aeordb-file-utils.mjs';

export const DEFAULT_SESSION_MERGE_ROOT = '/kikx/session-merges';

export class SessionMergeStore {
  constructor(options = {}) {
    let db = options.db || options.aeordb;
    if (!db)
      throw new TypeError('SessionMergeStore requires db (or the aeordb alias)');
    this.db = db;
    this.aeordb = db;
    this.rootPath = String(options.rootPath || DEFAULT_SESSION_MERGE_ROOT).replace(/\/+$/, '');
  }

  pathFor(mergeID) {
    return `${this.rootPath}/${encodeURIComponent(mergeID)}.json`;
  }

  async save(job = {}) {
    let id = normalizeID(job.id || job.mergeID);
    await this.db.putFile(this.pathFor(id), { ...job, id, mergeID: id });
    return job;
  }

  async get(mergeID) {
    let id = normalizeID(mergeID);
    let [job] = await readJSONFiles(this.db, [ this.pathFor(id) ]);
    return job || null;
  }

  async list({ limit = 50 } = {}) {
    if (typeof this.db.listDirectory !== 'function')
      return [];
    let entries;
    try {
      entries = await this.db.listDirectory(this.rootPath, { limit });
    } catch (_error) {
      return [];
    }
    let paths = (Array.isArray(entries) ? entries : [])
      .map((entry) => typeof entry === 'string' ? entry : entry?.path)
      .filter((entry) => typeof entry === 'string' && entry.endsWith('.json'))
      .map((entry) => entry.startsWith(this.rootPath) ? entry : `${this.rootPath}/${entry.replace(/^\/+/, '')}`);
    let jobs = await readJSONFiles(this.db, paths);
    return jobs
      .filter(Boolean)
      .sort((left, right) => Number(right.createdAtMs || 0) - Number(left.createdAtMs || 0))
      .slice(0, Math.max(1, Number(limit) || 50));
  }
}

function normalizeID(value) {
  let id = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id))
    throw new TypeError('mergeID must be a short URL-safe identifier');
  return id;
}
