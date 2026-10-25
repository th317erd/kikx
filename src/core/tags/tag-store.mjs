'use strict';

import { pathsFromItems, readJSONFiles } from '../aeordb/aeordb-file-utils.mjs';
import { writeIndexConfigs } from '../database/index-configs.mjs';
import { validateTagValue } from './tag-definitions.mjs';

export const DEFAULT_TAG_ROOT = '/kikx/tags';
export const DEFAULT_TAG_LIMIT = 100;
export const MAX_TAG_LIMIT = 5000;

export class TagsStore {
  constructor(options = {}) {
    let db = options.db || options.aeordb;
    if (!db)
      throw new TypeError('TagsStore requires db (or the aeordb alias)');

    this.db = db;
    this.aeordb = db;
    this.rootPath = normalizeRoot(options.rootPath || DEFAULT_TAG_ROOT);
    this.pluginRegistry = options.pluginRegistry || null;
    this.clock = options.clock || (() => new Date().toISOString());
    this._indexesReady = false;
  }

  async createTag(input = {}) {
    let tag = normalizeTag(input, this.definitionFor(input.name));
    let path = this.tagPath(tag);
    let existing = await this.readTagPath(path);
    if (existing) {
      let error = new Error(`Tag already exists: ${tag.target_type}/${tag.target_id}/${tag.name}`);
      error.status = 409;
      throw error;
    }

    let now = this.clock();
    tag.createdAt = now;
    tag.updatedAt = now;
    await this.ensureIndexConfigs();
    await this.db.putFile(path, tag);
    return sanitizeTag(tag);
  }

  async upsertTag(input = {}) {
    let target = normalizeTarget(input);
    let name = normalizeName(input.name);
    let path = this.tagPath({ ...target, name });
    let existing = await this.readTagPath(path);
    if (existing)
      return await this.updateTag({ ...target, name, value: input.value });
    return await this.createTag({ ...target, name, value: input.value });
  }

  async getTag(input = {}) {
    let target = normalizeTarget(input);
    let name = normalizeName(input.name);
    let tag = await this.readTagPath(this.tagPath({ ...target, name }));
    if (!tag)
      throw notFound(target.target_type, target.target_id, name);
    return sanitizeTag(tag);
  }

  async listTags(filters = {}) {
    await this.ensureIndexConfigs();
    let targetType = normalizeOptionalString(filters.target_type || filters.targetType);
    let targetID = normalizeOptionalString(filters.target_id || filters.targetID);
    let name = normalizeOptionalString(filters.name);
    let query = normalizeOptionalString(filters.query || filters.q).toLowerCase();
    let minValue = filters.min_value ?? filters.minValue;
    let maxValue = filters.max_value ?? filters.maxValue;
    let limit = clampInteger(filters.limit, DEFAULT_TAG_LIMIT, 1, MAX_TAG_LIMIT);
    let offset = clampInteger(filters.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    let tags = await this.readCandidateTags({ targetType, targetID, name });

    tags = tags.filter((tag) => {
      if (targetType && tag.target_type !== targetType)
        return false;
      if (targetID && tag.target_id !== targetID)
        return false;
      if (name && tag.name !== name)
        return false;
      if (query) {
        let haystack = `${tag.target_type} ${tag.target_id} ${tag.name} ${String(tag.value)}`.toLowerCase();
        if (!haystack.includes(query))
          return false;
      }
      if (minValue != null && Number(tag.value) < Number(minValue))
        return false;
      if (maxValue != null && Number(tag.value) > Number(maxValue))
        return false;
      return true;
    });

    tags.sort(compareTags);
    return {
      tags: tags.slice(offset, offset + limit),
      total: tags.length,
      offset,
      limit,
    };
  }

  async updateTag(input = {}) {
    let target = normalizeTarget(input);
    let name = normalizeName(input.name);
    let path = this.tagPath({ ...target, name });
    let existing = await this.readTagPath(path);
    if (!existing)
      throw notFound(target.target_type, target.target_id, name);

    let definition = this.definitionFor(name);
    let value = validateTagValue(definition, input.value);
    let next = {
      ...existing,
      target_type: target.target_type,
      target_id: target.target_id,
      name,
      value,
      updatedAt: this.clock(),
    };
    await this.db.putFile(path, next);
    return sanitizeTag(next);
  }

  async deleteTag(input = {}) {
    let target = normalizeTarget(input);
    let name = normalizeName(input.name);
    let path = this.tagPath({ ...target, name });
    let existing = await this.readTagPath(path);
    if (!existing)
      throw notFound(target.target_type, target.target_id, name);

    await this.db.deleteFile(path);
    return sanitizeTag(existing);
  }

  // Apply a batch from an entity create/edit flow. `null` deletes that tag;
  // every other value upserts. Other tags on the target are left alone so a
  // tool-created tag is not silently erased by an agent form save.
  async applyTags(targetType, targetID, tags = []) {
    let target = normalizeTarget({ target_type: targetType, target_id: targetID });
    let applied = [];
    for (let input of Array.isArray(tags) ? tags : []) {
      let name = normalizeName(input?.name);
      if (input.value == null) {
        try {
          applied.push(await this.deleteTag({ ...target, name }));
        } catch (error) {
          if (error.status !== 404)
            throw error;
        }
        continue;
      }

      let existing = await this.readTagPath(this.tagPath({ ...target, name }));
      if (existing) {
        applied.push(await this.updateTag({ ...target, name, value: input.value }));
      } else {
        applied.push(await this.createTag({ ...target, name, value: input.value }));
      }
    }
    return applied;
  }

  async deleteTagsForTarget(targetType, targetID) {
    let result = await this.listTags({ target_type: targetType, target_id: targetID, limit: MAX_TAG_LIMIT });
    for (let tag of result.tags)
      await this.db.deleteFile(this.tagPath(tag));
    return result.tags.length;
  }

  definitionFor(name) {
    if (!this.pluginRegistry?.listTagDefinitions)
      return null;
    return this.pluginRegistry.listTagDefinitions().find((definition) => definition.name === name) || null;
  }

  async readCandidateTags({ targetType, targetID, name }) {
    let base = targetType
      ? targetID
        ? `${this.rootPath}/${encodeSegment(targetType)}/${encodeSegment(targetID)}`
        : `${this.rootPath}/${encodeSegment(targetType)}`
      : this.rootPath;

    if (!targetType && name && typeof this.db.queryFiles === 'function') {
      try {
        let result = await this.db.queryFiles({
          path: this.rootPath,
          where: { field: 'name', op: 'eq', value: name },
          limit: MAX_TAG_LIMIT,
          select: [ '@path' ],
        });
        let paths = pathsFromItems(result?.results || result?.items);
        if (paths.length > 0)
          return await this.readTagsFromPaths(paths);
      } catch (_error) {
        // Fall through to the directory scan; a driver without query indexes
        // still supports tags, just without the indexed fast path.
      }
    }

    try {
      let result = await this.db.listDirectory(base, {
        depth: -1,
        glob: '**/tag.json',
        limit: MAX_TAG_LIMIT,
      });
      return await this.readTagsFromPaths(pathsFromItems(result?.items));
    } catch (error) {
      if (error.status === 404)
        return [];
      throw error;
    }
  }

  async readTagsFromPaths(paths = []) {
    let reads = await readJSONFiles(this.db, paths, { fallbackOnBatchError: true });
    let tags = [];
    for (let read of reads) {
      let tag = read.value;
      if (tag?.target_type && tag?.target_id && tag?.name)
        tags.push(tag);
    }
    return tags;
  }

  async readTagPath(path) {
    try {
      let tag = await this.db.getFile(path);
      return tag && typeof tag === 'object' && !Array.isArray(tag) ? tag : null;
    } catch (error) {
      if (error.status === 404)
        return null;
      throw error;
    }
  }

  tagPath(tag = {}) {
    return `${this.rootPath}/${encodeSegment(tag.target_type)}/${encodeSegment(tag.target_id)}/${encodeSegment(tag.name)}/tag.json`;
  }

  async ensureIndexConfigs() {
    if (this._indexesReady)
      return;

    await writeIndexConfigs(this.db, [
      {
        path: `${this.rootPath}/.aeordb-config/indexes.json`,
        body: {
          glob: '**/tag.json',
          indexes: [
            { name: 'target_type', type: 'string' },
            { name: 'target_id', type: 'string' },
            { name: 'name', type: [ 'string', 'trigram' ] },
            { name: 'value', type: [ 'number', 'string' ] },
            { name: 'updatedAt', type: 'timestamp' },
          ],
        },
      },
    ]);
    this._indexesReady = true;
  }
}

export function sanitizeTag(tag = {}) {
  return {
    target_id: tag.target_id,
    target_type: tag.target_type,
    name: tag.name,
    value: tag.value,
    createdAt: tag.createdAt || null,
    updatedAt: tag.updatedAt || null,
  };
}

function normalizeTag(input = {}, definition = null) {
  let target = normalizeTarget(input);
  let name = normalizeName(input.name);
  let value = validateTagValue(definition, input.value);
  return {
    target_id: target.target_id,
    target_type: target.target_type,
    name,
    value,
  };
}

function normalizeTarget(input = {}) {
  let targetType = normalizeRequiredString(input.target_type || input.targetType, 'target_type');
  let targetID = normalizeRequiredString(input.target_id || input.targetID, 'target_id');
  return { target_type: targetType, target_id: targetID };
}

function normalizeName(value) {
  let name = normalizeRequiredString(value, 'name');
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name))
    throw invalid('name must be a dotted identifier');
  return name;
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '')
    throw invalid(`${fieldName} must be a non-empty string`);
  return value.trim();
}

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeRoot(value) {
  return `/${String(value).replace(/^\/+|\/+$/g, '')}`;
}

function encodeSegment(value) {
  return encodeURIComponent(String(value));
}

function compareTags(a, b) {
  return String(a.target_type).localeCompare(String(b.target_type))
    || String(a.target_id).localeCompare(String(b.target_id))
    || String(a.name).localeCompare(String(b.name));
}

function clampInteger(value, fallback, min, max) {
  let parsed = Number(value);
  if (!Number.isFinite(parsed))
    parsed = fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function invalid(message) {
  let error = new Error(message);
  error.status = 400;
  return error;
}

function notFound(targetType, targetID, name) {
  let error = new Error(`Tag not found: ${targetType}/${targetID}/${name}`);
  error.status = 404;
  return error;
}
