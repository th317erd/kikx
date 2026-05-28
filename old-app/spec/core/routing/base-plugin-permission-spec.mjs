'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }        from '../../../src/core/index.mjs';
import { Keystore }              from '../../../src/core/crypto/keystore.mjs';
import { Permissions }           from '../../../src/core/permissions/permissions-base.mjs';
import { PermissionService }     from '../../../src/core/permissions/permission-service.mjs';
import { BasePluginClass }       from '../../../src/core/routing/base-plugin-class.mjs';

// =============================================================================
// Phase C3 — BasePluginClass.checkPermission() Tests
// =============================================================================

describe('BasePluginClass.checkPermission() (C3)', () => {
  let core;
  let models;
  let context;
  let keystore;
  let permissions;
  let permissionService;

  before(async () => {
    core = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    keystore = new Keystore({ devMode: true, devSeed: 'base-plugin-perm-test' });
    keystore.initialize();
    context.setProperty('keystore', keystore);

    permissions       = new Permissions(context);
    permissionService = new PermissionService({ context, keystore });
  });

  after(async () => {
    if (keystore)
      keystore.destroy();

    if (core && core.isStarted())
      await core.stop();
  });

  async function createTestOrg() {
    return models.Organization.create({ name: 'BasePlugin Perm Org' });
  }

  it('should return approved: true when no permissionService on context', async () => {
    let plugin = new BasePluginClass({});

    let result = await plugin.checkPermission('shell:execute', { command: 'ls' });
    assert.equal(result.approved, true);
  });

  it('should return approved: true with signature when allow rule matches', async () => {
    let org = await createTestOrg();

    // Create allow rule
    await permissions.createRule({
      organizationID: org.id,
      featureName:    'test:base-allowed',
      effect:         'allow',
      scope:          'global',
      createdBy:      'usr_test',
    });

    let plugin = new BasePluginClass({
      permissionService,
      organizationID: org.id,
      session:        { id: 'ses_base_1' },
    });

    let result = await plugin.checkPermission('test:base-allowed', {});
    assert.equal(result.approved, true);
    assert.ok(result.signature);
  });

  it('should return approved: false when needs approval', async () => {
    let org = await createTestOrg();

    let plugin = new BasePluginClass({
      permissionService,
      organizationID: org.id,
      session:        { id: 'ses_base_2' },
    });

    let result = await plugin.checkPermission('test:unknown-tool', {});
    assert.equal(result.approved, false);
    assert.equal(result.reason, 'needs-approval');
  });

  it('should return approved: false with reason for deny rules', async () => {
    let org = await createTestOrg();

    await permissions.createRule({
      organizationID: org.id,
      featureName:    'test:base-denied',
      effect:         'deny',
      scope:          'global',
      createdBy:      'usr_test',
    });

    let plugin = new BasePluginClass({
      permissionService,
      organizationID: org.id,
      session:        { id: 'ses_base_3' },
    });

    let result = await plugin.checkPermission('test:base-denied', {});
    assert.equal(result.approved, false);
    assert.ok(result.reason);
  });

  it('should handle missing session gracefully', async () => {
    let org = await createTestOrg();

    let plugin = new BasePluginClass({
      permissionService,
      organizationID: org.id,
    });

    let result = await plugin.checkPermission('test:no-session', {});
    assert.equal(result.approved, false);
    assert.equal(result.reason, 'needs-approval');
  });

  it('should handle null context properties gracefully', async () => {
    let plugin = new BasePluginClass({
      permissionService: null,
    });

    let result = await plugin.checkPermission('test:null', {});
    assert.equal(result.approved, true);
  });
});
