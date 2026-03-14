'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore } from '../../../src/core/index.mjs';

// =============================================================================
// ValueStore Model Tests
// =============================================================================
// Verifies the ValueStore key-value model: field types, defaults,
// uniqueness constraints, cascade deletes, and edge cases.
// =============================================================================

describe('ValueStore Model', () => {
  let core;
  let models;
  let organization;

  before(async () => {
    core = createKikxCore();
    await core.start();
    models = core.getModels();
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  beforeEach(async () => {
    organization = await models.Organization.create({ name: 'ValueStore Test Org' });
  });

  async function createEntry(overrides = {}) {
    return models.ValueStore.create({
      organizationID: organization.id,
      ownerType:      'Agent',
      ownerID:        'agt_test123',
      namespace:      'config',
      key:            'theme',
      value:          'dark',
      ...overrides,
    });
  }

  // ---------------------------------------------------------------------------
  // Basic CRUD
  // ---------------------------------------------------------------------------

  it('creates a ValueStore entry with all fields and reads it back', async () => {
    let entry = await createEntry({
      scopeID:   'scope_1',
      value:     '{"color":"blue"}',
      signature: 'sig_abc123',
    });

    assert.ok(entry.id.startsWith('vs_'), 'id should have vs_ prefix');
    assert.equal(entry.organizationID, organization.id);
    assert.equal(entry.ownerType, 'Agent');
    assert.equal(entry.ownerID, 'agt_test123');
    assert.equal(entry.namespace, 'config');
    assert.equal(entry.scopeID, 'scope_1');
    assert.equal(entry.key, 'theme');
    assert.equal(entry.value, '{"color":"blue"}');
    assert.equal(entry.signature, 'sig_abc123');

    // Verify persistence via DB fetch
    let fetched = await models.ValueStore.where.id.EQ(entry.id).first();
    assert.equal(fetched.ownerType, 'Agent');
    assert.equal(fetched.key, 'theme');
    assert.equal(fetched.value, '{"color":"blue"}');
  });

  // ---------------------------------------------------------------------------
  // Field types
  // ---------------------------------------------------------------------------

  it('fields have correct types (string for ownerType, namespace, etc.)', async () => {
    let entry = await createEntry();

    assert.equal(typeof entry.ownerType, 'string');
    assert.equal(typeof entry.ownerID, 'string');
    assert.equal(typeof entry.namespace, 'string');
    assert.equal(typeof entry.key, 'string');
    assert.equal(typeof entry.scopeID, 'string');
  });

  // ---------------------------------------------------------------------------
  // Defaults
  // ---------------------------------------------------------------------------

  it('scopeID defaults to empty string when not provided', async () => {
    let entry = await createEntry();
    assert.equal(entry.scopeID, '');
  });

  // ---------------------------------------------------------------------------
  // Value field (TEXT long)
  // ---------------------------------------------------------------------------

  it('can read back value field (TEXT long)', async () => {
    let json  = JSON.stringify({ nested: { data: [1, 2, 3] } });
    let entry = await createEntry({ value: json });

    let fetched = await models.ValueStore.where.id.EQ(entry.id).first();
    assert.equal(fetched.value, json);
  });

  // ---------------------------------------------------------------------------
  // Signature field (nullable)
  // ---------------------------------------------------------------------------

  it('signature field is nullable and defaults to null/undefined', async () => {
    let entry = await createEntry();
    assert.ok(entry.signature == null, 'signature should be null or undefined by default');
  });

  // ---------------------------------------------------------------------------
  // Composite index on key field
  // ---------------------------------------------------------------------------
  // NOTE: Mythix ORM does not support composite UNIQUE indexes declaratively.
  // A composite (non-unique) index on [key, ownerType, ownerID, namespace, scopeID]
  // is defined for query performance. True uniqueness enforcement requires
  // application-level checks or a raw SQL migration.
  // ---------------------------------------------------------------------------

  it('key field has composite index definition with ownerType, ownerID, namespace, scopeID', () => {
    let keyField = models.ValueStore.getField('key');
    assert.ok(Array.isArray(keyField.index), 'key.index should be an array for composite index');
    assert.ok(keyField.index.includes(true), 'key.index should include true for self-indexing');
    assert.ok(keyField.index.includes('ownerType'), 'key.index should include ownerType');
    assert.ok(keyField.index.includes('ownerID'), 'key.index should include ownerID');
    assert.ok(keyField.index.includes('namespace'), 'key.index should include namespace');
    assert.ok(keyField.index.includes('scopeID'), 'key.index should include scopeID');
  });

  // ---------------------------------------------------------------------------
  // Different scopeIDs allow same key
  // ---------------------------------------------------------------------------

  it('allows same key for same owner when scopeIDs differ', async () => {
    let base = {
      ownerType: 'Agent',
      ownerID:   'agt_scope_test',
      namespace: 'config',
      key:       'model',
    };

    let entry1 = await createEntry({ ...base, scopeID: 'scope_a', value: 'claude' });
    let entry2 = await createEntry({ ...base, scopeID: 'scope_b', value: 'gpt-4' });

    assert.notEqual(entry1.id, entry2.id);
    assert.equal(entry1.value, 'claude');
    assert.equal(entry2.value, 'gpt-4');
  });

  // ---------------------------------------------------------------------------
  // Different namespaces allow same key
  // ---------------------------------------------------------------------------

  it('allows same key for same owner when namespaces differ', async () => {
    let base = {
      ownerType: 'Agent',
      ownerID:   'agt_ns_test',
      scopeID:   '',
      key:       'timeout',
    };

    let entry1 = await createEntry({ ...base, namespace: 'config', value: '30' });
    let entry2 = await createEntry({ ...base, namespace: 'state', value: '60' });

    assert.notEqual(entry1.id, entry2.id);
    assert.equal(entry1.value, '30');
    assert.equal(entry2.value, '60');
  });

  // ---------------------------------------------------------------------------
  // Different ownerIDs allow same key
  // ---------------------------------------------------------------------------

  it('allows same key when ownerIDs differ', async () => {
    let base = {
      ownerType: 'Agent',
      namespace: 'config',
      scopeID:   '',
      key:       'color',
    };

    let entry1 = await createEntry({ ...base, ownerID: 'agt_owner_a', value: 'red' });
    let entry2 = await createEntry({ ...base, ownerID: 'agt_owner_b', value: 'blue' });

    assert.notEqual(entry1.id, entry2.id);
    assert.equal(entry1.value, 'red');
    assert.equal(entry2.value, 'blue');
  });

  // ---------------------------------------------------------------------------
  // Cascade delete: Organization → ValueStore entries
  // ---------------------------------------------------------------------------

  it('cascade deletes ValueStore entries when Organization is deleted', async () => {
    let tempOrg = await models.Organization.create({ name: 'Cascade Test Org' });
    let entry   = await models.ValueStore.create({
      organizationID: tempOrg.id,
      ownerType:      'User',
      ownerID:        'usr_cascade',
      namespace:      'prefs',
      key:            'timezone',
      value:          'UTC',
    });

    let entryID = entry.id;

    // Verify it exists
    let found = await models.ValueStore.where.id.EQ(entryID).first();
    assert.ok(found, 'entry should exist before cascade delete');

    // Delete the organization
    await tempOrg.destroy();

    // Verify cascade
    let after = await models.ValueStore.where.id.EQ(entryID).first();
    assert.ok(after == null, 'entry should be deleted after organization cascade');
  });

  // ---------------------------------------------------------------------------
  // Large value storage
  // ---------------------------------------------------------------------------

  it('can store very long value (1000+ chars)', async () => {
    let longValue = 'x'.repeat(5000);
    let entry     = await createEntry({ value: longValue, key: 'big_blob' });

    let fetched = await models.ValueStore.where.id.EQ(entry.id).first();
    assert.equal(fetched.value, longValue);
    assert.equal(fetched.value.length, 5000);
  });

  // ---------------------------------------------------------------------------
  // Null value
  // ---------------------------------------------------------------------------

  it('can store null value', async () => {
    let entry = await createEntry({ value: null, key: 'null_val' });

    let fetched = await models.ValueStore.where.id.EQ(entry.id).first();
    assert.ok(fetched.value == null, 'value should be null or undefined');
  });
});
