'use strict';

import { describe, it }            from 'node:test';
import assert                       from 'node:assert/strict';

import { FilesPermissions }         from '../../../../src/core/internal-plugins/files/files-permissions.mjs';
import { PermissionRequiredError }  from '../../../../src/core/permissions/permission-required-error.mjs';

// =============================================================================
// FilesPermissions
// =============================================================================
// Tests for the tool-owned permission logic in files:read, files:write,
// files:edit. The checkPermission() override always throws
// PermissionRequiredError with file path in details.
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
  let perms = new FilesPermissions(makeContext());
  perms.evaluate = async () => true;
  return perms;
}

describe('FilesPermissions', () => {

  // ---------------------------------------------------------------------------
  // Always throws PermissionRequiredError when evaluate() says needs approval
  // ---------------------------------------------------------------------------

  it('should throw PermissionRequiredError for files:read', async () => {
    let perms = makePerms();

    await assert.rejects(
      () => perms.checkPermission('files:read', { filePath: '/tmp/foo.txt' }),
      (error) => {
        assert.ok(error instanceof PermissionRequiredError);
        assert.equal(error.featureName, 'files:read');
        return true;
      },
    );
  });

  it('should throw PermissionRequiredError for files:write', async () => {
    let perms = makePerms();

    await assert.rejects(
      () => perms.checkPermission('files:write', { filePath: '/tmp/out.txt', content: 'hello' }),
      (error) => {
        assert.ok(error instanceof PermissionRequiredError);
        assert.equal(error.featureName, 'files:write');
        return true;
      },
    );
  });

  it('should throw PermissionRequiredError for files:edit', async () => {
    let perms = makePerms();

    await assert.rejects(
      () => perms.checkPermission('files:edit', { filePath: '/tmp/foo.txt', oldString: 'a', newString: 'b' }),
      (error) => {
        assert.ok(error instanceof PermissionRequiredError);
        assert.equal(error.featureName, 'files:edit');
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
      () => perms.checkPermission('files:read', { filePath: '/etc/passwd' }),
      (error) => {
        assert.equal(error.title, 'Read File');
        assert.ok(error.description.includes('Agent is requesting to read the file: /etc/passwd'));
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Title reflects operation from featureName
  // ---------------------------------------------------------------------------

  it('should set title based on operation from featureName suffix', async () => {
    let perms = makePerms();

    await assert.rejects(
      () => perms.checkPermission('files:write', { filePath: '/tmp/x' }),
      (error) => {
        assert.equal(error.title, 'Write File');
        return true;
      },
    );
  });

  it('should default title to "File Access" when featureName has no colon', async () => {
    let perms = makePerms();

    await assert.rejects(
      () => perms.checkPermission('files', { filePath: '/tmp/x' }),
      (error) => {
        assert.equal(error.title, 'File Access');
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Details include file path
  // ---------------------------------------------------------------------------

  it('should include filePath in details', async () => {
    let perms = makePerms();

    await assert.rejects(
      () => perms.checkPermission('files:read', { filePath: '/home/user/secret.txt' }),
      (error) => {
        assert.equal(error.details.length, 1);
        assert.equal(error.details[0].label, 'File Path');
        assert.equal(error.details[0].value, '/home/user/secret.txt');
        return true;
      },
    );
  });

  it('should accept "path" arg as fallback for filePath', async () => {
    let perms = makePerms();

    await assert.rejects(
      () => perms.checkPermission('files:read', { path: '/tmp/alt.txt' }),
      (error) => {
        assert.equal(error.details.length, 1);
        assert.equal(error.details[0].value, '/tmp/alt.txt');
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Missing / null args → empty details
  // ---------------------------------------------------------------------------

  it('should produce empty details when no path is provided', async () => {
    let perms = makePerms();

    await assert.rejects(
      () => perms.checkPermission('files:read', {}),
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
      () => perms.checkPermission('files:read', null),
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
      () => perms.checkPermission('files:read', undefined),
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
    let perms = new FilesPermissions(makeContext());
    perms.evaluate = async () => false; // standing rule approves

    let result = await perms.checkPermission('files:read', { filePath: '/tmp/foo.txt' });
    assert.equal(result, false);
  });
});
