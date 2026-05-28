'use strict';

import { describe, it } from 'node:test';
import assert            from 'node:assert/strict';

import { PermissionRequiredError } from '../../../src/core/permissions/permission-required-error.mjs';

// =============================================================================
// PermissionRequiredError
// =============================================================================

describe('PermissionRequiredError', () => {

  // ---------------------------------------------------------------------------
  // Construction with all fields
  // ---------------------------------------------------------------------------

  it('should construct with all fields', () => {
    let error = new PermissionRequiredError('shell:execute', {
      title:       'permission.shell.executeTitle',
      titleParams: { command: 'rm -rf /' },
      description: 'permission.shell.executeDescription',
      details:     [{ label: 'command', value: 'rm -rf /' }],
    });

    assert.equal(error.featureName, 'shell:execute');
    assert.equal(error.title, 'permission.shell.executeTitle');
    assert.deepEqual(error.titleParams, { command: 'rm -rf /' });
    assert.equal(error.description, 'permission.shell.executeDescription');
    assert.deepEqual(error.details, [{ label: 'command', value: 'rm -rf /' }]);
  });

  // ---------------------------------------------------------------------------
  // name property
  // ---------------------------------------------------------------------------

  it('should have name "PermissionRequiredError"', () => {
    let error = new PermissionRequiredError('test:tool');
    assert.equal(error.name, 'PermissionRequiredError');
  });

  // ---------------------------------------------------------------------------
  // message defaults to title when provided
  // ---------------------------------------------------------------------------

  it('should use title as message when provided', () => {
    let error = new PermissionRequiredError('test:tool', {
      title: 'Custom title for permission',
    });

    assert.equal(error.message, 'Custom title for permission');
  });

  // ---------------------------------------------------------------------------
  // message defaults to "Permission required: {featureName}" when no title
  // ---------------------------------------------------------------------------

  it('should default message to "Permission required: {featureName}" when no title', () => {
    let error = new PermissionRequiredError('shell:execute');
    assert.equal(error.message, 'Permission required: shell:execute');
  });

  // ---------------------------------------------------------------------------
  // titleParams stored
  // ---------------------------------------------------------------------------

  it('should store titleParams', () => {
    let params = { sessionName: 'My Project', count: 5 };
    let error  = new PermissionRequiredError('test:tool', { titleParams: params });

    assert.deepEqual(error.titleParams, params);
  });

  // ---------------------------------------------------------------------------
  // details stored as array
  // ---------------------------------------------------------------------------

  it('should store details as array', () => {
    let details = [
      { label: 'command', value: 'ls' },
      { label: 'path', value: '/tmp' },
    ];
    let error = new PermissionRequiredError('test:tool', { details });

    assert.deepEqual(error.details, details);
  });

  // ---------------------------------------------------------------------------
  // instanceof Error
  // ---------------------------------------------------------------------------

  it('should be instanceof Error', () => {
    let error = new PermissionRequiredError('test:tool');
    assert.ok(error instanceof Error);
  });

  // ---------------------------------------------------------------------------
  // Missing featureName defaults to empty string
  // ---------------------------------------------------------------------------

  it('should default featureName to empty string when missing', () => {
    let error = new PermissionRequiredError();
    assert.equal(error.featureName, '');
  });

  // ---------------------------------------------------------------------------
  // Missing context defaults (null title, null description, empty details)
  // ---------------------------------------------------------------------------

  it('should default to null title, null description, empty details when no options', () => {
    let error = new PermissionRequiredError('test:tool');

    assert.equal(error.title, null);
    assert.equal(error.titleParams, null);
    assert.equal(error.description, null);
    assert.deepEqual(error.details, []);
  });

  // ---------------------------------------------------------------------------
  // Null details stored as empty array
  // ---------------------------------------------------------------------------

  it('should store null details as empty array', () => {
    let error = new PermissionRequiredError('test:tool', { details: null });
    assert.deepEqual(error.details, []);
  });
});
