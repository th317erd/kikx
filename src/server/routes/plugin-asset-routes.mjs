'use strict';

import path from 'node:path';

import { writeText } from '../http-helpers.mjs';
import { resolveWithin, serveResolvedFile } from '../static-files.mjs';

const PLUGIN_ASSET_PREFIX = '/api/v1/plugin-assets/';
const PLUGIN_CLIENT_DIR = 'client';

// Serve a loaded plugin's own client assets:
//   GET /api/v1/plugin-assets/<pluginID>/<path...>
// Files are read from `<pluginPath>/client/<path>`. Plugins already run
// in-process, so this is not a new trust boundary; it only adds a
// read-only, traversal-protected static view of their client directory.
export async function handlePluginAssetRoutes({ request, response, url, context }) {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return false;

  if (!url.pathname.startsWith(PLUGIN_ASSET_PREFIX))
    return false;

  let remainder = url.pathname.slice(PLUGIN_ASSET_PREFIX.length);
  let slashIndex = remainder.indexOf('/');
  if (slashIndex < 1) {
    writeText(response, 404, 'Not Found');
    return true;
  }

  let pluginID = safeDecode(remainder.slice(0, slashIndex));
  let relativePath = safeDecode(remainder.slice(slashIndex + 1));
  if (!pluginID || !relativePath) {
    writeText(response, 404, 'Not Found');
    return true;
  }

  let registry = context.require('pluginRegistry');
  let pluginPath = typeof registry.getPluginPath === 'function'
    ? registry.getPluginPath(pluginID)
    : null;
  if (!pluginPath) {
    writeText(response, 404, 'Not Found');
    return true;
  }

  let filePath = resolveWithin(path.join(pluginPath, PLUGIN_CLIENT_DIR), relativePath);
  await serveResolvedFile({ request, response, filePath });
  return true;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return '';
  }
}
