'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { handleImageProxyRoute } from '../../src/server/routes/image-proxy-route.mjs';

function createResponse() {
  return {
    status: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body = '') {
      this.body = Buffer.isBuffer(body) ? body : Buffer.from(body);
    },
  };
}

function createContext({ allowed = true, authenticated = true } = {}) {
  return {
    require(name) {
      if (name === 'accountStore') {
        return {
          async resolveIdentity() {
            if (!authenticated) {
              let error = new Error('Sign in required');
              error.status = 401;
              throw error;
            }
            return { id: 'user_1' };
          },
        };
      }
      if (name === 'frameRuntime') {
        return {
          async getEffectivePreference() {
            return allowed;
          },
        };
      }
      throw new Error(`Unexpected service: ${name}`);
    },
  };
}

async function invoke({ method = 'GET', imagePath = '', sessionID = 'ses_1', allowed = true, authenticated = true } = {}) {
  let url = new URL('http://localhost/api/v1/image-proxy');
  if (imagePath)
    url.searchParams.set('path', imagePath);
  if (sessionID)
    url.searchParams.set('session_id', sessionID);
  let response = createResponse();
  await handleImageProxyRoute({
    request: { method, headers: {} },
    response,
    url,
    context: createContext({ allowed, authenticated }),
  });
  return response;
}

test('image proxy serves a verified image only for authenticated sessions', async () => {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-image-proxy-'));
  let imagePath = path.join(dir, 'pixel.png');
  await fs.writeFile(imagePath, Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]));

  try {
    let response = await invoke({ imagePath });
    assert.equal(response.status, 200);
    assert.equal(response.headers['Content-Type'], 'image/png');
    assert.equal(response.headers['X-Kikx-Image-Proxy'], 'ok');
    assert.equal(response.body.length, 16);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('image proxy refuses unauthenticated requests', async () => {
  await assert.rejects(
    () => invoke({ imagePath: '/tmp/x.png', authenticated: false }),
    /Sign in required/,
  );
});

test('image proxy honors the cascading OCR image-proxy preference', async () => {
  let response = await invoke({ imagePath: '/tmp/x.png', allowed: false });
  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Type'], 'image/svg+xml; charset=utf-8');
  assert.equal(response.headers['X-Kikx-Image-Proxy'], 'disabled');
});

test('image proxy returns the placeholder for invalid paths and non-images', async () => {
  let relative = await invoke({ imagePath: 'relative.png' });
  assert.equal(relative.headers['X-Kikx-Image-Proxy'], 'invalid-path');

  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-image-proxy-bad-'));
  let textPath = path.join(dir, 'not-image.txt');
  await fs.writeFile(textPath, 'not an image');
  try {
    let notImage = await invoke({ imagePath: textPath });
    assert.equal(notImage.status, 200);
    assert.equal(notImage.headers['Content-Type'], 'image/svg+xml; charset=utf-8');
    assert.equal(notImage.headers['X-Kikx-Image-Proxy'], 'not-an-image');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('image proxy HEAD requests do not send an image body', async () => {
  let response = await invoke({ method: 'HEAD', imagePath: '/tmp/x.png', allowed: false });
  assert.equal(response.status, 200);
  assert.equal(response.body.length, 0);
});
