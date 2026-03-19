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

describe('ValueStore note and type columns', () => {
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
    organization = await models.Organization.create({ name: 'ValueStore note/type Org' });
  });

  async function createEntry(overrides = {}) {
    return models.ValueStore.create({
      organizationID: organization.id,
      ownerType:      'Agent',
      ownerID:        'agt_notetype_test',
      namespace:      'config',
      key:            'setting',
      value:          'value',
      ...overrides,
    });
  }

  // ---------------------------------------------------------------------------
  // Happy paths
  // ---------------------------------------------------------------------------

  it('can create a ValueStore entry with note and type set', async () => {
    let entry = await createEntry({
      key:  'tool-use',
      note: 'used hammer.execute',
      type: 'tool_call',
    });

    assert.ok(entry.id.startsWith('vs_'), 'id should have vs_ prefix');
    assert.equal(entry.note, 'used hammer.execute');
    assert.equal(entry.type, 'tool_call');
  });

  it('note and type are returned when fetching the entry', async () => {
    let entry = await createEntry({
      key:  'fetch-check',
      note: 'fetch note',
      type: 'fetch_type',
    });

    let fetched = await models.ValueStore.where.id.EQ(entry.id).first();
    assert.equal(fetched.note, 'fetch note');
    assert.equal(fetched.type, 'fetch_type');
  });

  it('can filter entries by type (exact match)', async () => {
    let orgID = organization.id;

    await createEntry({ key: 'a', type: 'tool_call', note: 'first' });
    await createEntry({ key: 'b', type: 'tool_call', note: 'second' });
    await createEntry({ key: 'c', type: 'memory',    note: 'third' });

    let results = await models.ValueStore.where
      .organizationID.EQ(orgID)
      .AND.type.EQ('tool_call')
      .all();

    assert.ok(results.length >= 2, `expected at least 2 tool_call entries, got ${results.length}`);
    for (let r of results)
      assert.equal(r.type, 'tool_call');
  });

  it('can create entry without note/type (null values, existing behavior preserved)', async () => {
    let entry = await createEntry({ key: 'no-metadata' });

    assert.ok(entry.id.startsWith('vs_'), 'id should have vs_ prefix');
    assert.equal(entry.value, 'value');
    // note and type should be absent / null
    assert.ok(entry.note == null, `note should be null, got: ${entry.note}`);
    assert.ok(entry.type == null, `type should be null, got: ${entry.type}`);
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('note accepts up to 256 characters (boundary test)', async () => {
    let longNote = 'n'.repeat(256);
    let entry    = await createEntry({ key: 'note-boundary', note: longNote });

    let fetched = await models.ValueStore.where.id.EQ(entry.id).first();
    assert.equal(fetched.note.length, 256);
    assert.equal(fetched.note, longNote);
  });

  it('type accepts up to 64 characters (boundary test)', async () => {
    let longType = 't'.repeat(64);
    let entry    = await createEntry({ key: 'type-boundary', type: longType });

    let fetched = await models.ValueStore.where.id.EQ(entry.id).first();
    assert.equal(fetched.type.length, 64);
    assert.equal(fetched.type, longType);
  });

  it('note defaults to null when not specified', async () => {
    let entry = await createEntry({ key: 'note-default' });

    let fetched = await models.ValueStore.where.id.EQ(entry.id).first();
    assert.ok(fetched.note == null, `note should default to null, got: ${fetched.note}`);
  });

  it('type defaults to null when not specified', async () => {
    let entry = await createEntry({ key: 'type-default' });

    let fetched = await models.ValueStore.where.id.EQ(entry.id).first();
    assert.ok(fetched.type == null, `type should default to null, got: ${fetched.type}`);
  });
});
