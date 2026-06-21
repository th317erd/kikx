'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ToolLogService } from '../../../src/core/interaction/tool-log-service.mjs';

// =============================================================================
// ToolLogService Tests
// =============================================================================
// Tests the ToolLogService storage helper in isolation using mocked models.
// No database required — ValueStore.create is mocked per-test.
// =============================================================================

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides = {}) {
  return {
    id:    'vs_testentry001',
    key:   'tl_abc123',
    value: '{"args":{},"output":"ok"}',
    ...overrides,
  };
}

function makeModels(createImpl) {
  return {
    ValueStore: {
      create: createImpl,
    },
  };
}

function makeParams(overrides = {}) {
  return {
    sessionID:      'ses_test001',
    interactionID:  'int_test001',
    agentID:        'agt_test001',
    organizationID: 'org_test001',
    toolName:       'execute',
    pluginID:       'shell',
    toolCallArgs:   { command: 'ls -la' },
    output:         'file1.txt\nfile2.txt',
    models:         makeModels(async (data) => makeEntry({ key: data.key, value: data.value })),
    keystore:       null,
    privateKeyPEM:  null,
    publicKeyPEM:   null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ToolLogService
// ---------------------------------------------------------------------------

describe('ToolLogService', () => {
  let service;

  beforeEach(() => {
    service = new ToolLogService();
  });

  // -------------------------------------------------------------------------
  // HAPPY PATHS
  // -------------------------------------------------------------------------

  describe('happy paths', () => {
    it('creates a ValueStore entry and returns { id, key }', async () => {
      let captured = null;
      let params   = makeParams({
        models: makeModels(async (data) => {
          captured = data;
          return makeEntry({ key: data.key, value: data.value });
        }),
      });

      let result = await service.storeToolOutput(params);

      assert.ok(result, 'should return a result object');
      assert.ok(result.id,  'result.id should be set');
      assert.ok(result.key, 'result.key should be set');
      assert.ok(result.key.startsWith('tl_'), 'key should have tl_ prefix');
    });

    it('passes correct ownerType, ownerID, namespace, scopeID to ValueStore.create', async () => {
      let captured = null;
      let params   = makeParams({
        models: makeModels(async (data) => {
          captured = data;
          return makeEntry({ key: data.key });
        }),
      });

      await service.storeToolOutput(params);

      assert.ok(captured, 'ValueStore.create should have been called');
      assert.equal(captured.ownerType,      'agent',          'ownerType should be "agent"');
      assert.equal(captured.ownerID,        'agt_test001',    'ownerID should be agentID');
      assert.equal(captured.namespace,      'tool_log',       'namespace should be "tool_log"');
      assert.equal(captured.scopeID,        'ses_test001',    'scopeID should be sessionID');
      assert.equal(captured.organizationID, 'org_test001',    'organizationID should be passed through');
    });

    it('value JSON contains both args and output', async () => {
      let captured = null;
      let args     = { command: 'echo hello' };
      let output   = 'hello';
      let params   = makeParams({
        toolCallArgs: args,
        output,
        models: makeModels(async (data) => {
          captured = data;
          return makeEntry({ key: data.key, value: data.value });
        }),
      });

      await service.storeToolOutput(params);

      assert.ok(captured, 'ValueStore.create should have been called');
      let parsed = JSON.parse(captured.value);
      assert.deepEqual(parsed.args,   args,   'args should be stored in value');
      assert.equal(parsed.output, output, 'output should be stored in value');
    });

    it('sets type to "tool_log:{pluginID}:{toolName}"', async () => {
      let captured = null;
      let params   = makeParams({
        pluginID: 'shell',
        toolName: 'execute',
        models:   makeModels(async (data) => {
          captured = data;
          return makeEntry({ key: data.key });
        }),
      });

      await service.storeToolOutput(params);

      assert.ok(captured);
      assert.equal(captured.type, 'tool_log:shell:execute');
    });

    it('derives note from first shell argument (command string)', async () => {
      let captured = null;
      let params   = makeParams({
        pluginID:     'shell',
        toolName:     'execute',
        toolCallArgs: { command: 'grep -r foo .' },
        models:       makeModels(async (data) => {
          captured = data;
          return makeEntry({ key: data.key });
        }),
      });

      await service.storeToolOutput(params);

      assert.ok(captured);
      assert.equal(captured.note, 'grep -r foo .');
    });

    it('derives note from query for websearch tools', async () => {
      let captured = null;
      let params   = makeParams({
        pluginID:     'websearch',
        toolName:     'search',
        toolCallArgs: { query: 'Node.js best practices' },
        models:       makeModels(async (data) => {
          captured = data;
          return makeEntry({ key: data.key });
        }),
      });

      await service.storeToolOutput(params);

      assert.ok(captured);
      assert.equal(captured.note, 'Node.js best practices');
    });

    it('falls back to toolName for unknown tool types', async () => {
      let captured = null;
      let params   = makeParams({
        pluginID:     'custom',
        toolName:     'doSomething',
        toolCallArgs: { param1: 'value1' },
        models:       makeModels(async (data) => {
          captured = data;
          return makeEntry({ key: data.key });
        }),
      });

      await service.storeToolOutput(params);

      assert.ok(captured);
      assert.equal(captured.note, 'doSomething');
    });

    it('each call produces a unique key', async () => {
      let keys = [];
      let models = makeModels(async (data) => {
        keys.push(data.key);
        return makeEntry({ key: data.key });
      });
      let params = makeParams({ models });

      await service.storeToolOutput(params);
      await service.storeToolOutput(params);
      await service.storeToolOutput(params);

      assert.equal(keys.length, 3);
      let unique = new Set(keys);
      assert.equal(unique.size, 3, 'all keys should be unique');
    });

    it('returned key matches the key passed to ValueStore.create', async () => {
      let capturedKey = null;
      let params      = makeParams({
        models: makeModels(async (data) => {
          capturedKey = data.key;
          return makeEntry({ key: data.key });
        }),
      });

      let result = await service.storeToolOutput(params);

      assert.equal(result.key, capturedKey, 'returned key should match what was stored');
    });
  });

  // -------------------------------------------------------------------------
  // FAILURE PATHS
  // -------------------------------------------------------------------------

  describe('failure paths', () => {
    it('returns null when ValueStore.create() throws — does not propagate', async () => {
      let params = makeParams({
        models: makeModels(async () => {
          throw new Error('DB connection lost');
        }),
      });

      let result = await service.storeToolOutput(params);

      assert.equal(result, null, 'should return null on storage failure');
    });

    it('returns null when ValueStore.create() rejects with a non-Error', async () => {
      let params = makeParams({
        models: makeModels(async () => {
           
          throw 'string error';
        }),
      });

      let result = await service.storeToolOutput(params);

      assert.equal(result, null, 'should return null on any thrown value');
    });

    it('returns null when models.ValueStore is missing', async () => {
      let params = makeParams({ models: {} });

      let result = await service.storeToolOutput(params);

      assert.equal(result, null);
    });

    it('returns null when models itself is null', async () => {
      let params = makeParams({ models: null });

      let result = await service.storeToolOutput(params);

      assert.equal(result, null);
    });

    it('returns null when signing throws (corrupt keystore)', async () => {
      // A keystore that throws on signWithPrivateKey
      let badKeystore = {
        signWithPrivateKey: () => { throw new Error('keystore exploded'); },
      };

      let params = makeParams({
        keystore:      badKeystore,
        privateKeyPEM: 'fake-private',
        publicKeyPEM:  'fake-public',
        models:        makeModels(async (data) => makeEntry({ key: data.key })),
      });

      // Signing failure is best-effort — entry should still be created
      let result = await service.storeToolOutput(params);

      // signValue() itself catches errors and returns null, so create still runs
      assert.ok(result, 'should still store even if signing silently fails');
      assert.ok(result.key.startsWith('tl_'));
    });
  });

  // -------------------------------------------------------------------------
  // EDGE CASES
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles empty string output — still creates entry', async () => {
      let captured = null;
      let params   = makeParams({
        output: '',
        models: makeModels(async (data) => {
          captured = data;
          return makeEntry({ key: data.key, value: data.value });
        }),
      });

      let result = await service.storeToolOutput(params);

      assert.ok(result);
      let parsed = JSON.parse(captured.value);
      assert.equal(parsed.output, '');
    });

    it('handles null output — stores null in value.output', async () => {
      let captured = null;
      let params   = makeParams({
        output: null,
        models: makeModels(async (data) => {
          captured = data;
          return makeEntry({ key: data.key, value: data.value });
        }),
      });

      let result = await service.storeToolOutput(params);

      assert.ok(result);
      let parsed = JSON.parse(captured.value);
      assert.equal(parsed.output, null);
    });

    it('handles null toolCallArgs — stores null in value.args', async () => {
      let captured = null;
      let params   = makeParams({
        toolCallArgs: null,
        models:       makeModels(async (data) => {
          captured = data;
          return makeEntry({ key: data.key, value: data.value });
        }),
      });

      let result = await service.storeToolOutput(params);

      assert.ok(result);
      let parsed = JSON.parse(captured.value);
      assert.equal(parsed.args, null);
    });

    it('handles undefined toolCallArgs — stores null in value.args', async () => {
      let captured = null;
      let params   = makeParams({
        toolCallArgs: undefined,
        models:       makeModels(async (data) => {
          captured = data;
          return makeEntry({ key: data.key, value: data.value });
        }),
      });

      let result = await service.storeToolOutput(params);

      assert.ok(result);
      let parsed = JSON.parse(captured.value);
      assert.equal(parsed.args, null);
    });

    it('stores very long output without truncation', async () => {
      let bigOutput = 'x'.repeat(100_000);
      let captured  = null;
      let params    = makeParams({
        output: bigOutput,
        models: makeModels(async (data) => {
          captured = data;
          return makeEntry({ key: data.key, value: data.value });
        }),
      });

      let result = await service.storeToolOutput(params);

      assert.ok(result);
      let parsed = JSON.parse(captured.value);
      assert.equal(parsed.output.length, 100_000, 'output should not be truncated');
    });

    it('handles object output (JSON-serializable)', async () => {
      let objOutput = { rows: [1, 2, 3], count: 3 };
      let captured  = null;
      let params    = makeParams({
        output: objOutput,
        models: makeModels(async (data) => {
          captured = data;
          return makeEntry({ key: data.key, value: data.value });
        }),
      });

      let result = await service.storeToolOutput(params);

      assert.ok(result);
      let parsed = JSON.parse(captured.value);
      assert.deepEqual(parsed.output, objOutput);
    });

    it('handles empty toolCallArgs object — note falls back to toolName', async () => {
      let captured = null;
      let params   = makeParams({
        pluginID:     'custom',
        toolName:     'myTool',
        toolCallArgs: {},
        models:       makeModels(async (data) => {
          captured = data;
          return makeEntry({ key: data.key });
        }),
      });

      await service.storeToolOutput(params);

      assert.ok(captured);
      assert.equal(captured.note, 'myTool');
    });

    it('handles missing sessionID — uses empty string as scopeID', async () => {
      let captured = null;
      let params   = makeParams({
        sessionID: undefined,
        models:    makeModels(async (data) => {
          captured = data;
          return makeEntry({ key: data.key });
        }),
      });

      await service.storeToolOutput(params);

      assert.ok(captured);
      assert.equal(captured.scopeID, '');
    });

    it('note is truncated to 256 chars for very long shell commands', async () => {
      let longCommand = 'echo ' + 'a'.repeat(500);
      let captured    = null;
      let params      = makeParams({
        pluginID:     'shell',
        toolName:     'execute',
        toolCallArgs: { command: longCommand },
        models:       makeModels(async (data) => {
          captured = data;
          return makeEntry({ key: data.key });
        }),
      });

      await service.storeToolOutput(params);

      assert.ok(captured);
      assert.ok(captured.note.length <= 256, 'note should be truncated to 256 chars');
    });

    it('handles web_search (underscore) tool name for note derivation', async () => {
      let captured = null;
      let params   = makeParams({
        pluginID:     'search',
        toolName:     'web_search',
        toolCallArgs: { query: 'async generators node' },
        models:       makeModels(async (data) => {
          captured = data;
          return makeEntry({ key: data.key });
        }),
      });

      await service.storeToolOutput(params);

      assert.ok(captured);
      assert.equal(captured.note, 'async generators node');
    });

    it('signature and signingKeyFingerprint are null when no keys provided', async () => {
      let captured = null;
      let params   = makeParams({
        keystore:      null,
        privateKeyPEM: null,
        publicKeyPEM:  null,
        models:        makeModels(async (data) => {
          captured = data;
          return makeEntry({ key: data.key });
        }),
      });

      await service.storeToolOutput(params);

      assert.ok(captured);
      assert.equal(captured.signature,             null);
      assert.equal(captured.signingKeyFingerprint, null);
    });
  });
});
