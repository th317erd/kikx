'use strict';

import { describe, it } from 'node:test';
import assert            from 'node:assert/strict';

import { Permissions }           from '../../../src/core/permissions/permissions-base.mjs';
import { PermissionDeniedError } from '../../../src/core/permissions/permission-denied-error.mjs';

// =============================================================================
// Permissions base class
// =============================================================================

describe('Permissions', () => {
  it('should construct with context', () => {
    let context     = { foo: 'bar' };
    let permissions = new Permissions(context);
    assert.equal(permissions._context, context);
  });

  it('should return { matches: true } by default from matchesRule', () => {
    let permissions = new Permissions({});
    let result      = permissions.matchesRule({}, {}, {});
    assert.deepEqual(result, { matches: true });
  });

  it('should parse metadata from JSON string', () => {
    let permissions = new Permissions({});
    let rule        = { metadata: '{"allowedCommands":["ls","cat"]}' };
    let parsed      = permissions._parseMetadata(rule);
    assert.deepEqual(parsed, { allowedCommands: ['ls', 'cat'] });
  });

  it('should parse metadata from object', () => {
    let permissions = new Permissions({});
    let rule        = { metadata: { key: 'value' } };
    let parsed      = permissions._parseMetadata(rule);
    assert.deepEqual(parsed, { key: 'value' });
  });

  it('should return empty object for null metadata', () => {
    let permissions = new Permissions({});
    let parsed      = permissions._parseMetadata({ metadata: null });
    assert.deepEqual(parsed, {});
  });

  it('should return empty object for undefined metadata', () => {
    let permissions = new Permissions({});
    let parsed      = permissions._parseMetadata({});
    assert.deepEqual(parsed, {});
  });

  it('should return empty object for malformed JSON metadata', () => {
    let permissions = new Permissions({});
    let parsed      = permissions._parseMetadata({ metadata: '{invalid json' });
    assert.deepEqual(parsed, {});
  });

  it('should allow subclass to override matchesRule', () => {
    class CustomPermissions extends Permissions {
      matchesRule(_rule, args, _metadata) {
        return { matches: args && args.allowed === true };
      }
    }

    let permissions = new CustomPermissions({});
    assert.deepEqual(permissions.matchesRule({}, { allowed: true }, {}), { matches: true });
    assert.deepEqual(permissions.matchesRule({}, { allowed: false }, {}), { matches: false });
  });
});

// =============================================================================
// PermissionDeniedError
// =============================================================================

describe('PermissionDeniedError', () => {
  it('should have correct name', () => {
    let error = new PermissionDeniedError('shell:execute', 'blocked');
    assert.equal(error.name, 'PermissionDeniedError');
  });

  it('should store featureName', () => {
    let error = new PermissionDeniedError('shell:execute', 'test');
    assert.equal(error.featureName, 'shell:execute');
  });

  it('should store reason', () => {
    let error = new PermissionDeniedError('shell:execute', 'too dangerous');
    assert.equal(error.reason, 'too dangerous');
  });

  it('should have descriptive message', () => {
    let error = new PermissionDeniedError('shell:execute', 'blocked');
    assert.equal(error.message, 'Permission denied for "shell:execute": blocked');
  });

  it('should default reason to "explicit deny"', () => {
    let error = new PermissionDeniedError('websearch:search');
    assert.equal(error.reason, 'explicit deny');
    assert.ok(error.message.includes('explicit deny'));
  });

  it('should be an instance of Error', () => {
    let error = new PermissionDeniedError('test', 'reason');
    assert.ok(error instanceof Error);
  });
});
