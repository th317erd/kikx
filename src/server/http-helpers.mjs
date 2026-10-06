'use strict';

export function httpError(status, message) {
  let error = new Error(message);
  error.status = status;
  return error;
}

export async function readJSON(request) {
  let chunks = [];
  let size = 0;
  let maxSize = 1024 * 1024;

  for await (let chunk of request) {
    size += chunk.length;
    if (size > maxSize)
      throw httpError(413, 'Request body is too large');

    chunks.push(chunk);
  }

  if (chunks.length === 0)
    return {};

  let text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw httpError(400, 'Request body must be valid JSON');
  }
}

export async function getRequestAccount(context, request) {
  if (!context.has('accountStore'))
    return null;

  let accountStore = context.require('accountStore');
  let identity;

  try {
    identity = await accountStore.resolveIdentity(request);
  } catch (error) {
    if (error?.status === 401)
      return null;

    throw error;
  }

  return await accountStore.getAccount(identity);
}

export function parsePositiveInteger(value, fallback) {
  if (value == null)
    return fallback;

  let parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw httpError(400, 'limit must be a positive integer');

  return parsed;
}

export function parseNonNegativeInteger(value, fallback) {
  if (value == null)
    return fallback;

  let parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw httpError(400, 'offset must be a non-negative integer');

  return parsed;
}

export function parseEnvPositiveInteger(value, fallback) {
  if (value == null || value === '')
    return fallback;

  let parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

export function parseEnvNonNegativeInteger(value, fallback) {
  if (value == null || value === '')
    return fallback;

  let parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function parseEnvRatio(value, fallback) {
  if (value == null || value === '')
    return fallback;

  let parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    return fallback;

  return Math.min(parsed, 1);
}

export function parseOptionalPositiveInteger(value) {
  if (value == null)
    return null;

  let parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw httpError(400, 'value must be a positive integer');

  return parsed;
}

export function parseOptionalNonNegativeInteger(value) {
  if (value == null)
    return null;

  let parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw httpError(400, 'value must be a non-negative integer');

  return parsed;
}

export function parseBoolean(value, fallback = false) {
  if (value == null || value === '')
    return fallback;

  return value === '1' || value === 'true' || value === 'yes';
}

export function writeText(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
  });
  response.end(body);
}

export function writeJSON(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

export function totalTokensUsed(snapshot) {
  let total = 0;
  for (let entry of Object.values(snapshot || {})) {
    let value = Number(entry?.tokensUsed);
    if (Number.isFinite(value) && value > 0)
      total += Math.trunc(value);
  }

  return total;
}
