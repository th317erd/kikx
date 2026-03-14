'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }  from '../../../src/core/index.mjs';
import { SessionManager }  from '../../../src/core/session/index.mjs';

// =============================================================================
// Session Constraint Fields
// =============================================================================
// Verifies `maxInteractions` and `endsAt` fields on the Session model:
// defaults, persistence, version bump.
// =============================================================================

describe('Session constraint fields', () => {
  let core;
  let models;
  let manager;
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
    manager      = new SessionManager(core.getContext());
    organization = await models.Organization.create({ name: 'Constraint Test Org' });
  });

  // ---------------------------------------------------------------------------
  // Version bump
  // ---------------------------------------------------------------------------

  it('Session model version is 4', () => {
    let { Session } = models;
    assert.equal(Session.version, 4);
  });

  // ---------------------------------------------------------------------------
  // Default values
  // ---------------------------------------------------------------------------

  it('maxInteractions defaults to null', async () => {
    let session = await manager.createSession(organization.id);
    assert.equal(session.maxInteractions, null);
  });

  it('endsAt defaults to null', async () => {
    let session = await manager.createSession(organization.id);
    assert.equal(session.endsAt, null);
  });

  // ---------------------------------------------------------------------------
  // Explicit creation values
  // ---------------------------------------------------------------------------

  it('creates session with maxInteractions', async () => {
    let session = await manager.createSession(organization.id, {
      maxInteractions: 5,
    });

    assert.equal(session.maxInteractions, 5);
  });

  it('creates session with endsAt', async () => {
    let futureDate = new Date('2030-01-01T00:00:00Z');
    let session = await manager.createSession(organization.id, {
      endsAt: futureDate,
    });

    assert.ok(session.endsAt);
    assert.equal(new Date(session.endsAt).toISOString(), futureDate.toISOString());
  });

  it('creates session with both maxInteractions and endsAt', async () => {
    let futureDate = new Date('2030-06-15T12:00:00Z');
    let session = await manager.createSession(organization.id, {
      maxInteractions: 10,
      endsAt:          futureDate,
    });

    assert.equal(session.maxInteractions, 10);
    assert.ok(session.endsAt);
  });

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  it('maxInteractions persists to database correctly', async () => {
    let session = await manager.createSession(organization.id, {
      maxInteractions: 7,
    });

    let { Session } = models;
    let fetched = await Session.where.id.EQ(session.id).first();
    assert.equal(fetched.maxInteractions, 7);
  });

  it('endsAt persists to database correctly', async () => {
    let futureDate = new Date('2029-12-31T23:59:59Z');
    let session = await manager.createSession(organization.id, {
      endsAt: futureDate,
    });

    let { Session } = models;
    let fetched = await Session.where.id.EQ(session.id).first();
    assert.ok(fetched.endsAt);
    assert.equal(new Date(fetched.endsAt).toISOString(), futureDate.toISOString());
  });

  it('null maxInteractions persists correctly', async () => {
    let session = await manager.createSession(organization.id);

    let { Session } = models;
    let fetched = await Session.where.id.EQ(session.id).first();
    assert.equal(fetched.maxInteractions, null);
  });

  it('null endsAt persists correctly', async () => {
    let session = await manager.createSession(organization.id);

    let { Session } = models;
    let fetched = await Session.where.id.EQ(session.id).first();
    assert.equal(fetched.endsAt, null);
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('maxInteractions of 0 is stored as 0 (not null)', async () => {
    let session = await manager.createSession(organization.id, {
      maxInteractions: 0,
    });

    let { Session } = models;
    let fetched = await Session.where.id.EQ(session.id).first();
    assert.equal(fetched.maxInteractions, 0);
  });

  it('maxInteractions of 1 is the minimum meaningful constraint', async () => {
    let session = await manager.createSession(organization.id, {
      maxInteractions: 1,
    });

    assert.equal(session.maxInteractions, 1);
  });

  it('endsAt in the past is accepted (validation is at commit time)', async () => {
    let pastDate = new Date('2020-01-01T00:00:00Z');
    let session = await manager.createSession(organization.id, {
      endsAt: pastDate,
    });

    assert.ok(session.endsAt);
    assert.equal(new Date(session.endsAt).toISOString(), pastDate.toISOString());
  });

  it('large maxInteractions value is stored correctly', async () => {
    let session = await manager.createSession(organization.id, {
      maxInteractions: 999999,
    });

    let { Session } = models;
    let fetched = await Session.where.id.EQ(session.id).first();
    assert.equal(fetched.maxInteractions, 999999);
  });
});
