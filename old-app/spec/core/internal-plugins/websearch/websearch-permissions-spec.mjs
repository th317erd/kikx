'use strict';

import { describe, it }              from 'node:test';
import assert                         from 'node:assert/strict';

import { WebsearchPermissions }       from '../../../../src/core/internal-plugins/websearch/websearch-permissions.mjs';
import { PermissionRequiredError }    from '../../../../src/core/permissions/permission-required-error.mjs';

// =============================================================================
// WebsearchPermissions
// =============================================================================
// Tests for the tool-owned permission logic in websearch:fetch and
// websearch:search. The checkPermission() override always throws
// PermissionRequiredError with URL and/or query in details.
// =============================================================================

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext() {
  return {
    getProperty() { return null; },
  };
}

// Override evaluate() so it always returns true (needs approval),
// simulating a context where no standing rules exist.
function makePerms() {
  let perms = new WebsearchPermissions(makeContext());
  perms.evaluate = async () => true;
  return perms;
}

describe('WebsearchPermissions', () => {

  // ---------------------------------------------------------------------------
  // Always throws PermissionRequiredError when evaluate() says needs approval
  // ---------------------------------------------------------------------------

  it('should throw PermissionRequiredError for websearch:fetch', async () => {
    let perms = makePerms();

    await assert.rejects(
      () => perms.checkPermission('websearch:fetch', { url: 'https://example.com' }),
      (error) => {
        assert.ok(error instanceof PermissionRequiredError);
        assert.equal(error.featureName, 'websearch:fetch');
        return true;
      },
    );
  });

  it('should throw PermissionRequiredError for websearch:search', async () => {
    let perms = makePerms();

    await assert.rejects(
      () => perms.checkPermission('websearch:search', { query: 'how to bake bread' }),
      (error) => {
        assert.ok(error instanceof PermissionRequiredError);
        assert.equal(error.featureName, 'websearch:search');
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Human-readable title and description
  // ---------------------------------------------------------------------------

  it('should use human-readable title and description in the error', async () => {
    let perms = makePerms();

    await assert.rejects(
      () => perms.checkPermission('websearch:fetch', { url: 'https://example.com' }),
      (error) => {
        // Note: 'websearch:fetch'.includes('search') is true, so title is 'Web Search'
        assert.equal(error.title, 'Web Search');
        assert.ok(error.description.includes('Agent is requesting to search the web'));
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Details include URL for fetch
  // ---------------------------------------------------------------------------

  it('should include url in details for websearch:fetch', async () => {
    let perms = makePerms();

    await assert.rejects(
      () => perms.checkPermission('websearch:fetch', { url: 'https://docs.example.com/api' }),
      (error) => {
        assert.equal(error.details.length, 1);
        assert.equal(error.details[0].label, 'URL');
        assert.equal(error.details[0].value, 'https://docs.example.com/api');
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Details include query for search
  // ---------------------------------------------------------------------------

  it('should include query in details for websearch:search', async () => {
    let perms = makePerms();

    await assert.rejects(
      () => perms.checkPermission('websearch:search', { query: 'node.js best practices' }),
      (error) => {
        assert.equal(error.details.length, 1);
        assert.equal(error.details[0].label, 'Search Query');
        assert.equal(error.details[0].value, 'node.js best practices');
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Details include both URL and query when both present
  // ---------------------------------------------------------------------------

  it('should include both url and query in details when both provided', async () => {
    let perms = makePerms();

    await assert.rejects(
      () => perms.checkPermission('websearch:search', { url: 'https://x.com', query: 'test' }),
      (error) => {
        assert.equal(error.details.length, 2);
        assert.equal(error.details[0].label, 'URL');
        assert.equal(error.details[0].value, 'https://x.com');
        assert.equal(error.details[1].label, 'Search Query');
        assert.equal(error.details[1].value, 'test');
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Missing / null args → empty details
  // ---------------------------------------------------------------------------

  it('should produce empty details when no url or query provided', async () => {
    let perms = makePerms();

    await assert.rejects(
      () => perms.checkPermission('websearch:fetch', {}),
      (error) => {
        assert.ok(Array.isArray(error.details));
        assert.equal(error.details.length, 0);
        return true;
      },
    );
  });

  it('should handle null args gracefully', async () => {
    let perms = makePerms();

    await assert.rejects(
      () => perms.checkPermission('websearch:fetch', null),
      (error) => {
        assert.ok(error instanceof PermissionRequiredError);
        assert.equal(error.details.length, 0);
        return true;
      },
    );
  });

  it('should handle undefined args gracefully', async () => {
    let perms = makePerms();

    await assert.rejects(
      () => perms.checkPermission('websearch:search', undefined),
      (error) => {
        assert.ok(error instanceof PermissionRequiredError);
        assert.equal(error.details.length, 0);
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // evaluate() returning false → auto-approved (no throw)
  // ---------------------------------------------------------------------------

  it('should return false when evaluate() says no approval needed', async () => {
    let perms = new WebsearchPermissions(makeContext());
    perms.evaluate = async () => false;

    let result = await perms.checkPermission('websearch:fetch', { url: 'https://example.com' });
    assert.equal(result, false);
  });
});
