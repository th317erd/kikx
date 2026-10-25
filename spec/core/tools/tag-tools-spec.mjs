'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TagCreateTool,
  TagDeleteTool,
  TagGetTool,
  TagListTool,
  TagUpdateTool,
} from '../../../src/core/tools/index.mjs';

function createTagsStore() {
  let tags = new Map();
  return {
    async createTag(input) {
      let key = `${input.target_type}/${input.target_id}/${input.name}`;
      let tag = { ...input };
      tags.set(key, tag);
      return tag;
    },
    async getTag(input) {
      return tags.get(`${input.target_type}/${input.target_id}/${input.name}`) || null;
    },
    async listTags(input) {
      return { tags: [ ...tags.values() ].filter((tag) => !input.target_id || tag.target_id === input.target_id), total: tags.size, limit: 100, offset: 0 };
    },
    async updateTag(input) {
      let key = `${input.target_type}/${input.target_id}/${input.name}`;
      let next = { ...tags.get(key), value: input.value };
      tags.set(key, next);
      return next;
    },
    async deleteTag(input) {
      let key = `${input.target_type}/${input.target_id}/${input.name}`;
      let tag = tags.get(key);
      tags.delete(key);
      return tag;
    },
  };
}

test('tag CRUD tools call the tags store', async () => {
  let tagsStore = createTagsStore();
  let context = { services: { tagsStore } };
  let input = { target_type: 'agent', target_id: 'agent_1', name: 'ocr_score', value: 4 };

  assert.equal((await new TagCreateTool(context).execute(input)).value, 4);
  assert.equal((await new TagGetTool(context).execute(input)).value, 4);
  assert.equal((await new TagListTool(context).execute({ target_type: 'agent' })).total, 1);
  assert.equal((await new TagUpdateTool(context).execute({ ...input, value: 9 })).value, 9);
  assert.equal((await new TagDeleteTool(context).execute(input)).value, 9);
});
