'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { builtInToolComponent } from './tool-client-components.mjs';

class TagTool extends PluginInterface {
  static pluginID = 'internal:tags';
  static featureName = 'tag';
  static displayName = 'Tag';
  static description = 'Create, list, read, update, and delete indexed tags on any entity.';
  static frameType = 'TagToolFrame';
  static clientComponent = builtInToolComponent('kikx-tag-tool-use');
  static riskLevel = 'none';

  static help = [
    'Tags are indexed records with target_id, target_type, name, and value.',
    'Use tag-create to add a tag, tag-list to filter tags, tag-get to read one, tag-update to change its value, and tag-delete to remove it.',
    'Known tag definitions enforce types and ranges (for example leadership_score, compaction_score, and ocr_score are integers from 0 to 10).',
  ].join(' ');

  static inputSchema = {
    type: 'object',
    properties: {
      target_id: { type: 'string', description: 'Entity identifier, for example an agent id.' },
      target_type: { type: 'string', description: 'Entity type, for example agent, session, team, user, or frame.' },
      name: { type: 'string', description: 'Tag name, for example leadership_score.' },
      value: { description: 'Tag value. Known definitions validate its type and range.' },
    },
    required: [ 'target_id', 'target_type', 'name' ],
    additionalProperties: false,
  };

  async _execute(params = {}) {
    let store = resolveTagsStore(this.context);
    if (this.constructor.featureName === 'create')
      return await store.createTag(params);
    if (this.constructor.featureName === 'get')
      return await store.getTag(params);
    if (this.constructor.featureName === 'update')
      return await store.updateTag(params);
    if (this.constructor.featureName === 'delete')
      return await store.deleteTag(params);

    return await store.listTags(params);
  }
}

export class TagCreateTool extends TagTool {
  static featureName = 'create';
  static frameType = 'TagCreateToolFrame';
  static displayName = 'Create tag';
  static description = 'Create an indexed tag on any entity.';
  static help = 'Use tag-create when a tag does not exist yet. It fails if the same target_type/target_id/name already exists; use tag-update to change it.';
  static inputSchema = {
    type: 'object',
    properties: {
      target_id: { type: 'string' },
      target_type: { type: 'string' },
      name: { type: 'string' },
      value: { description: 'Tag value. Known definitions validate its type and range.' },
    },
    required: [ 'target_id', 'target_type', 'name', 'value' ],
    additionalProperties: false,
  };
}

export class TagListTool extends TagTool {
  static featureName = 'list';
  static frameType = 'TagListToolFrame';
  static displayName = 'List tags';
  static description = 'List indexed tags with optional target, name, value range, query, and paging filters.';
  static help = 'Use tag-list with target_type and/or target_id to inspect an entity, or with name to find every entity carrying a role tag. min_value and max_value filter numeric tags.';
  static inputSchema = {
    type: 'object',
    properties: {
      target_id: { type: 'string' },
      target_type: { type: 'string' },
      name: { type: 'string' },
      query: { type: 'string', description: 'Case-insensitive substring search across target, name, and value.' },
      min_value: { type: 'number' },
      max_value: { type: 'number' },
      limit: { type: 'integer', minimum: 1 },
      offset: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  };
}

export class TagGetTool extends TagTool {
  static featureName = 'get';
  static frameType = 'TagGetToolFrame';
  static displayName = 'Read tag';
  static description = 'Read one indexed tag by target and name.';
  static help = 'Use tag-get when you know the exact target_type, target_id, and name.';
}

export class TagUpdateTool extends TagTool {
  static featureName = 'update';
  static frameType = 'TagUpdateToolFrame';
  static displayName = 'Update tag';
  static description = 'Update the value of an existing indexed tag.';
  static help = 'Use tag-update to change an existing tag. It fails if the tag does not exist; use tag-create first.';
  static inputSchema = {
    type: 'object',
    properties: {
      target_id: { type: 'string' },
      target_type: { type: 'string' },
      name: { type: 'string' },
      value: { description: 'New tag value. Known definitions validate its type and range.' },
    },
    required: [ 'target_id', 'target_type', 'name', 'value' ],
    additionalProperties: false,
  };
}

export class TagDeleteTool extends TagTool {
  static featureName = 'delete';
  static frameType = 'TagDeleteToolFrame';
  static displayName = 'Delete tag';
  static description = 'Delete an indexed tag from any entity.';
  static help = 'Use tag-delete to remove a tag. It fails if the tag does not exist.';
}

function resolveTagsStore(context = {}) {
  let service = context.tagsStore
    || context.services?.tagsStore
    || resolveContextService(context, 'tagsStore');
  if (!service?.createTag || !service?.listTags)
    throw new Error('tag tools require a tagsStore service');
  return service;
}

function resolveContextService(context, name) {
  let appContext = context.services?.context || context.context;
  if (appContext?.has?.(name) && typeof appContext.require === 'function')
    return appContext.require(name);

  if (typeof appContext?.require === 'function') {
    try {
      return appContext.require(name);
    } catch (_error) {
      return null;
    }
  }

  return null;
}
