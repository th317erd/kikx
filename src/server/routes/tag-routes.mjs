'use strict';

import { parseNonNegativeInteger, parsePositiveInteger, readJSON, writeJSON } from '../http-helpers.mjs';

export async function handleTagRoutes({ request, response, url, context }) {
  if (url.pathname === '/api/v1/tags' && request.method === 'GET') {
    let store = context.require('tagsStore');
    let result = await store.listTags({
      target_type: url.searchParams.get('target_type') || '',
      target_id: url.searchParams.get('target_id') || '',
      name: url.searchParams.get('name') || '',
      query: url.searchParams.get('query') || url.searchParams.get('q') || '',
      min_value: url.searchParams.get('min_value'),
      max_value: url.searchParams.get('max_value'),
      limit: parsePositiveInteger(url.searchParams.get('limit'), 100),
      offset: parseNonNegativeInteger(url.searchParams.get('offset'), 0),
    });
    writeJSON(response, 200, { data: result });
    return true;
  }

  if (url.pathname === '/api/v1/tags' && request.method === 'POST') {
    let store = context.require('tagsStore');
    let body = await readJSON(request);
    writeJSON(response, 201, { data: { tag: await store.createTag(body) } });
    return true;
  }

  let match = /^\/api\/v1\/tags\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (!match)
    return false;

  let target = {
    target_type: decodeURIComponent(match[1]),
    target_id: decodeURIComponent(match[2]),
    name: decodeURIComponent(match[3]),
  };
  let store = context.require('tagsStore');

  if (request.method === 'GET') {
    writeJSON(response, 200, { data: { tag: await store.getTag(target) } });
    return true;
  }

  if (request.method === 'PUT') {
    let body = await readJSON(request);
    writeJSON(response, 200, { data: { tag: await store.upsertTag({ ...target, value: body.value }) } });
    return true;
  }

  if (request.method === 'PATCH') {
    let body = await readJSON(request);
    writeJSON(response, 200, { data: { tag: await store.updateTag({ ...target, value: body.value }) } });
    return true;
  }

  if (request.method === 'DELETE') {
    await store.deleteTag(target);
    response.writeHead(204);
    response.end();
    return true;
  }

  return false;
}
