'use strict';

import fsp from 'node:fs/promises';
import path from 'node:path';

import { httpError } from '../http-helpers.mjs';
import { OCR_IMAGE_PROXY_PREFERENCE } from '../../shared/session-preferences.mjs';

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_PATH_LENGTH = 4096;
const BLOCKED_ROOTS = [ '/proc', '/sys', '/dev', '/run' ];

const PLACEHOLDER = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <rect width="960" height="540" fill="#11161b"/>
  <rect x="18" y="18" width="924" height="504" rx="12" fill="#171d23" stroke="#3a444e" stroke-width="2"/>
  <text x="480" y="258" text-anchor="middle" fill="#aeb8c2" font-family="system-ui,sans-serif" font-size="28">Image failed to load</text>
  <text x="480" y="296" text-anchor="middle" fill="#76818c" font-family="system-ui,sans-serif" font-size="18">The image is unavailable or not permitted.</text>
</svg>`, 'utf8');

export async function handleImageProxyRoute({ request, response, url, context }) {
  if (url.pathname !== '/api/v1/image-proxy')
    return false;

  if (request.method !== 'GET' && request.method !== 'HEAD')
    throw httpError(405, 'Method not allowed');

  let identity = await requireIdentity(context, request);
  if (!identity)
    throw httpError(401, 'Sign in required');

  let rawPath = url.searchParams.get('path') || '';
  let sessionID = url.searchParams.get('session_id') || '';
  if (!sessionID)
    return servePlaceholder(response, request.method, 'no-session');

  let allowed = true;
  try {
    let frameRuntime = context.require('frameRuntime');
    if (typeof frameRuntime?.getEffectivePreference === 'function')
      allowed = (await frameRuntime.getEffectivePreference(sessionID, OCR_IMAGE_PROXY_PREFERENCE, true)) !== false;
  } catch (_error) {
    return servePlaceholder(response, request.method, 'preference-unavailable');
  }

  if (!allowed)
    return servePlaceholder(response, request.method, 'disabled');

  let filePath = normalizeImagePath(rawPath);
  if (!filePath)
    return servePlaceholder(response, request.method, 'invalid-path');

  let image;
  try {
    let realPath = await fsp.realpath(filePath);
    if (isBlockedPath(realPath))
      return servePlaceholder(response, request.method, 'blocked-path');

    let stat = await fsp.stat(realPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES)
      return servePlaceholder(response, request.method, 'not-an-image');

    image = await fsp.readFile(realPath);
  } catch (_error) {
    return servePlaceholder(response, request.method, 'missing');
  }

  let mime = detectImageMime(image);
  if (!mime)
    return servePlaceholder(response, request.method, 'not-an-image');

  response.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': String(image.length),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
    'X-Kikx-Image-Proxy': 'ok',
  });
  if (request.method === 'HEAD')
    response.end();
  else
    response.end(image);
  return true;
}

async function requireIdentity(context, request) {
  let accountStore = context.require('accountStore');
  try {
    return await accountStore.resolveIdentity(request);
  } catch (error) {
    if (error?.status === 401)
      return null;
    throw error;
  }
}

function normalizeImagePath(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_PATH_LENGTH)
    return null;
  if (value.includes('\0') || !path.isAbsolute(value))
    return null;

  let normalized = path.resolve(value);
  return normalized;
}

function isBlockedPath(filePath) {
  for (let root of BLOCKED_ROOTS) {
    if (filePath === root || filePath.startsWith(`${root}/`))
      return true;
  }
  return false;
}

function detectImageMime(buffer) {
  if (!buffer || buffer.length < 12)
    return '';

  if (buffer.subarray(0, 8).equals(Buffer.from([ 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a ])))
    return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return 'image/jpeg';
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a')
    return 'image/gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP')
    return 'image/webp';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d)
    return 'image/bmp';

  let brand = buffer.subarray(4, 12).toString('ascii');
  if (brand.startsWith('ftypavif') || brand.startsWith('ftypavis'))
    return 'image/avif';

  return '';
}

function servePlaceholder(response, method, status) {
  response.writeHead(200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Content-Length': String(PLACEHOLDER.length),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
    'X-Kikx-Image-Proxy': status,
  });
  if (method === 'HEAD')
    response.end();
  else
    response.end(PLACEHOLDER);
  return true;
}
