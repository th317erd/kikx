'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert                        from 'node:assert/strict';

import { PluginInterface }          from '../../../src/core/plugin-loader/plugin-interface.mjs';
import { Permissions }              from '../../../src/core/permissions/permissions-base.mjs';
import { PermissionRequiredError }  from '../../../src/core/permissions/permission-required-error.mjs';
import { PermissionDeniedError }    from '../../../src/core/permissions/permission-denied-error.mjs';

// =============================================================================
// PluginInterface — Permission Checking
// =============================================================================
// Tests for the rewritten _checkPermissions() flow that uses
// Permissions.evaluate() directly (no PermissionEngine).
//
// Flow:
//   1. riskLevel 'none' → skip everything
//   2. Instantiate PermissionsClass (or base Permissions)
//   3. Call checkPermission() — false=approve, true=deny, null=defer
//   4. Call evaluate() — false=approve, true=deny, throws=denied
// =============================================================================

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockTool(overrides = {}) {
  class MockTool extends PluginInterface {
    static pluginID    = overrides.pluginID || 'test';
    static featureName = overrides.featureName || 'tool';
    static riskLevel   = overrides.riskLevel !== undefined ? overrides.riskLevel : 'high';

    async _execute(params) {
      return { executed: true, params };
    }
  }

  if (overrides.PermissionsClass) {
    MockTool.prototype.getPermissionsClass = () => overrides.PermissionsClass;
  }

  let context = {
    getProperty: (name) => {
      if (overrides.contextProperties && name in overrides.contextProperties)
        return overrides.contextProperties[name];

      if (name === 'models')
        return overrides.models || null;

      return null;
    },
  };

  return new MockTool(context);
}

// A mock Permissions class that stubs evaluate() to return a controlled result
function createMockPermissionsClass({ checkResult = null, evaluateResult = false } = {}) {
  return class MockPermissions extends Permissions {
    async checkPermission() { return checkResult; }
    async evaluate()        { return evaluateResult; }
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('PluginInterface — Permission Checking', () => {

  // ===========================================================================
  // riskLevel 'none' — no permission check
  // ===========================================================================

  describe('riskLevel "none" — skip permission check', () => {
    it('should return immediately without calling evaluate()', async () => {
      let evaluateCalled = false;
      let PermClass = class extends Permissions {
        async evaluate() { evaluateCalled = true; return true; }
      };

      let tool = createMockTool({ riskLevel: 'none', PermissionsClass: PermClass });
      let result = await tool.execute({ input: 'test' });

      assert.equal(evaluateCalled, false);
      assert.deepEqual(result, { executed: true, params: { input: 'test' } });
    });
  });

  // ===========================================================================
  // No PermissionsClass on tool — uses base Permissions.evaluate()
  // ===========================================================================

  describe('no PermissionsClass — uses base Permissions', () => {
    it('evaluate() returns false → proceeds (approved)', async () => {
      let PermClass = createMockPermissionsClass({ evaluateResult: false });
      // Tool has no getPermissionsClass, so base Permissions is used.
      // We need to override the dynamic import to use our mock — but since
      // the base class is used, we actually test through Permissions.evaluate().
      // For unit testing, use PermissionsClass override to simulate base behavior.
      let tool = createMockTool({ riskLevel: 'high', PermissionsClass: PermClass });
      let result = await tool.execute({ input: 'test' });

      assert.deepEqual(result, { executed: true, params: { input: 'test' } });
    });

    it('evaluate() returns true → throws PermissionRequiredError', async () => {
      let PermClass = createMockPermissionsClass({ evaluateResult: true });
      let tool = createMockTool({ riskLevel: 'high', PermissionsClass: PermClass });

      await assert.rejects(
        () => tool.execute({ input: 'test' }),
        (error) => {
          assert.ok(error instanceof PermissionRequiredError);
          return true;
        },
      );
    });
  });

  // ===========================================================================
  // Custom PermissionsClass — checkPermission() returns false (approved)
  // ===========================================================================

  describe('PermissionsClass.evaluate() returns false → proceeds', () => {
    it('should approve and run _execute', async () => {
      let PermClass = createMockPermissionsClass({ evaluateResult: false });
      let tool = createMockTool({ riskLevel: 'high', PermissionsClass: PermClass });
      let result = await tool.execute({ input: 'test' });
      assert.deepEqual(result, { executed: true, params: { input: 'test' } });
    });
  });

  // ===========================================================================
  // PermissionsClass.evaluate() returns true → throws PermissionRequiredError
  // ===========================================================================

  describe('PermissionsClass.evaluate() returns true → throws', () => {
    it('should throw PermissionRequiredError', async () => {
      let PermClass = createMockPermissionsClass({ evaluateResult: true });
      let tool = createMockTool({ riskLevel: 'high', PermissionsClass: PermClass });

      await assert.rejects(
        () => tool.execute({ command: 'test' }),
        (error) => {
          assert.ok(error instanceof PermissionRequiredError);
          return true;
        },
      );
    });
  });

  // ===========================================================================
  // PermissionsClass.evaluate() throws PermissionDeniedError → propagates
  // ===========================================================================

  describe('PermissionsClass.evaluate() throws PermissionDeniedError → propagates', () => {
    it('should propagate PermissionDeniedError from evaluate()', async () => {
      let PermClass = class extends Permissions {
        async checkPermission() { return null; }
        async evaluate() { throw new PermissionDeniedError('test:tool', 'explicit deny'); }
      };

      let tool = createMockTool({ riskLevel: 'high', PermissionsClass: PermClass });

      await assert.rejects(
        () => tool.execute({}),
        (error) => {
          assert.ok(error instanceof PermissionDeniedError);
          assert.equal(error.featureName, 'test:tool');
          return true;
        },
      );
    });
  });

  // ===========================================================================
  // Timeout: evaluate() hangs → times out after 10s
  // ===========================================================================

  describe('timeout — evaluate() hangs', () => {
    it('should time out after 10s', async () => {
      let PermClass = class extends Permissions {
        async checkPermission() { return null; }
        async evaluate() { return new Promise(() => {}); } // never resolves
      };

      let tool = createMockTool({ riskLevel: 'high', PermissionsClass: PermClass });

      await assert.rejects(
        () => tool.execute({}),
        (error) => {
          assert.ok(error.message.includes('timed out'));
          return true;
        },
      );
    }, { timeout: 15000 });
  });

  // ===========================================================================
  // PermissionsClass.checkPermission() returns null → falls through to evaluate()
  // ===========================================================================

  describe('checkPermission() returns null → falls through to evaluate()', () => {
    it('evaluate() returns false → approved', async () => {
      let evaluateCalled = false;
      let PermClass = class extends Permissions {
        async checkPermission() { return null; }
        async evaluate() { evaluateCalled = true; return false; }
      };

      let tool = createMockTool({ riskLevel: 'high', PermissionsClass: PermClass });
      let result = await tool.execute({ input: 'test' });

      assert.equal(evaluateCalled, true);
      assert.deepEqual(result, { executed: true, params: { input: 'test' } });
    });

    it('evaluate() returns true → denied', async () => {
      let PermClass = class extends Permissions {
        async checkPermission() { return null; }
        async evaluate() { return true; }
      };

      let tool = createMockTool({ riskLevel: 'high', PermissionsClass: PermClass });

      await assert.rejects(
        () => tool.execute({}),
        (error) => {
          assert.ok(error instanceof PermissionRequiredError);
          return true;
        },
      );
    });
  });

  // ===========================================================================
  // PermissionsClass.checkPermission() returns false → short-circuit approve
  // ===========================================================================

  describe('checkPermission() returns false → short-circuit approve', () => {
    it('should approve without calling evaluate()', async () => {
      let evaluateCalled = false;
      let PermClass = class extends Permissions {
        async checkPermission() { return false; }
        async evaluate() { evaluateCalled = true; return true; }
      };

      let tool = createMockTool({ riskLevel: 'high', PermissionsClass: PermClass });
      let result = await tool.execute({ input: 'test' });

      assert.equal(evaluateCalled, false);
      assert.deepEqual(result, { executed: true, params: { input: 'test' } });
    });
  });

  // ===========================================================================
  // PermissionsClass.checkPermission() returns true → short-circuit deny
  // ===========================================================================

  describe('checkPermission() returns true → short-circuit deny', () => {
    it('should throw default PermissionRequiredError without calling evaluate()', async () => {
      let evaluateCalled = false;
      let PermClass = class extends Permissions {
        async checkPermission() { return true; }
        async evaluate() { evaluateCalled = true; return false; }
      };

      let tool = createMockTool({ riskLevel: 'high', PermissionsClass: PermClass });

      await assert.rejects(
        () => tool.execute({ command: 'test' }),
        (error) => {
          assert.ok(error instanceof PermissionRequiredError);
          assert.equal(evaluateCalled, false);
          return true;
        },
      );
    });
  });

  // ===========================================================================
  // checkPermission throws PermissionRequiredError → rethrows with rich context
  // ===========================================================================

  describe('checkPermission throws PermissionRequiredError', () => {
    it('should rethrow with rich context intact', async () => {
      let PermClass = class extends Permissions {
        async checkPermission() {
          throw new PermissionRequiredError('shell:execute', {
            title:       'Run dangerous command',
            description: 'This command is dangerous.',
            details:     [{ label: 'command', value: 'rm -rf /' }],
          });
        }
      };

      let tool = createMockTool({ riskLevel: 'high', PermissionsClass: PermClass });

      try {
        await tool.execute({});
        assert.fail('should have thrown');
      } catch (error) {
        assert.ok(error instanceof PermissionRequiredError);
        assert.equal(error.title, 'Run dangerous command');
        assert.equal(error.description, 'This command is dangerous.');
        assert.deepEqual(error.details, [{ label: 'command', value: 'rm -rf /' }]);
      }
    });
  });

  // ===========================================================================
  // Execute wrapper
  // ===========================================================================

  describe('execute() wrapper', () => {

    it('should call _checkPermissions() BEFORE _execute()', async () => {
      let callOrder = [];

      class OrderTool extends PluginInterface {
        static pluginID    = 'test';
        static featureName = 'order';
        static riskLevel   = 'high';

        async _checkPermissions(params) {
          callOrder.push('checkPermissions');
        }

        async _execute(params) {
          callOrder.push('execute');
          return { done: true };
        }
      }

      let context = { getProperty: () => null };
      let tool    = new OrderTool(context);
      await tool.execute({ input: 'test' });

      assert.deepEqual(callOrder, ['checkPermissions', 'execute']);
    });

    it('should store _params on instance', async () => {
      let PermClass = createMockPermissionsClass({ evaluateResult: false });
      let tool = createMockTool({ riskLevel: 'high', PermissionsClass: PermClass });

      let params = { command: 'ls', _sessionID: 'sess123' };
      await tool.execute(params);

      assert.equal(tool._params, params);
    });

    it('should return _execute() result', async () => {
      let PermClass = createMockPermissionsClass({ evaluateResult: false });
      let tool = createMockTool({ riskLevel: 'high', PermissionsClass: PermClass });
      let result = await tool.execute({ input: 'test' });

      assert.deepEqual(result, { executed: true, params: { input: 'test' } });
    });

    it('PermissionRequiredError from _checkPermissions should prevent _execute', async () => {
      let executeCalled = false;

      class BlockedTool extends PluginInterface {
        static pluginID    = 'test';
        static featureName = 'blocked';
        static riskLevel   = 'high';

        async _execute(params) {
          executeCalled = true;
          return { done: true };
        }
      }

      // Provide a PermissionsClass whose evaluate() returns true (needs approval)
      let PermClass = createMockPermissionsClass({ evaluateResult: true });
      BlockedTool.prototype.getPermissionsClass = () => PermClass;

      let context = { getProperty: () => null };
      let tool    = new BlockedTool(context);

      await assert.rejects(
        () => tool.execute({}),
        (error) => {
          assert.ok(error instanceof PermissionRequiredError);
          return true;
        },
      );

      assert.equal(executeCalled, false);
    });
  });

  // ===========================================================================
  // _featureName()
  // ===========================================================================

  describe('_featureName()', () => {
    it('should return "pluginID:featureName"', async () => {
      let PermClass = createMockPermissionsClass({ evaluateResult: true });
      let tool = createMockTool({
        pluginID:         'myPlugin',
        featureName:      'myFeature',
        riskLevel:        'high',
        PermissionsClass: PermClass,
      });

      try {
        await tool.execute({});
        assert.fail('should have thrown');
      } catch (error) {
        assert.ok(error instanceof PermissionRequiredError);
        assert.equal(error.featureName, 'myPlugin:myFeature');
      }
    });
  });

  // ===========================================================================
  // Sad paths
  // ===========================================================================

  describe('sad paths', () => {

    it('riskLevel undefined should be treated as needing permission (deny-by-default)', async () => {
      let PermClass = createMockPermissionsClass({ evaluateResult: true });
      let tool = createMockTool({ riskLevel: undefined, PermissionsClass: PermClass });

      await assert.rejects(
        () => tool.execute({}),
        (error) => {
          assert.ok(error instanceof PermissionRequiredError);
          return true;
        },
      );
    });

    it('riskLevel "critical" should always need approval (evaluate safety net)', async () => {
      // evaluate() has a safety net: toolClass.riskLevel === 'critical' → always true
      let PermClass = createMockPermissionsClass({ evaluateResult: true });
      let tool = createMockTool({ riskLevel: 'critical', PermissionsClass: PermClass });

      await assert.rejects(
        () => tool.execute({}),
        (error) => {
          assert.ok(error instanceof PermissionRequiredError);
          return true;
        },
      );
    });

    it('should strip _ params and format as label/value in default details', async () => {
      let PermClass = createMockPermissionsClass({ evaluateResult: true });
      let tool = createMockTool({ riskLevel: 'high', PermissionsClass: PermClass });

      try {
        await tool.execute({ command: 'ls', _sessionID: 'secret', path: '/tmp' });
        assert.fail('should have thrown');
      } catch (error) {
        assert.ok(error instanceof PermissionRequiredError);
        let labels = error.details.map((d) => d.label);
        assert.ok(labels.includes('command'));
        assert.ok(labels.includes('path'));
        assert.ok(!labels.includes('_sessionID'));
      }
    });

    it('params with only _ keys should produce empty details', async () => {
      let PermClass = createMockPermissionsClass({ evaluateResult: true });
      let tool = createMockTool({ riskLevel: 'high', PermissionsClass: PermClass });

      try {
        await tool.execute({ _sessionID: 'sess', _agent: { organizationID: 'org' } });
        assert.fail('should have thrown');
      } catch (error) {
        assert.ok(error instanceof PermissionRequiredError);
        assert.deepEqual(error.details, []);
      }
    });

    it('params with large values should be truncated to 200 chars', async () => {
      let PermClass = createMockPermissionsClass({ evaluateResult: true });
      let tool = createMockTool({ riskLevel: 'high', PermissionsClass: PermClass });

      let longValue = 'x'.repeat(300);
      try {
        await tool.execute({ bigField: longValue });
        assert.fail('should have thrown');
      } catch (error) {
        assert.ok(error instanceof PermissionRequiredError);
        let detail = error.details.find((d) => d.label === 'bigField');
        assert.ok(detail);
        assert.equal(detail.value.length, 203); // 200 + '...'
        assert.ok(detail.value.endsWith('...'));
      }
    });

    it('params with object values should be JSON.stringified', async () => {
      let PermClass = createMockPermissionsClass({ evaluateResult: true });
      let tool = createMockTool({ riskLevel: 'high', PermissionsClass: PermClass });

      try {
        await tool.execute({ config: { key: 'value', nested: true } });
        assert.fail('should have thrown');
      } catch (error) {
        assert.ok(error instanceof PermissionRequiredError);
        let detail = error.details.find((d) => d.label === 'config');
        assert.ok(detail);
        assert.equal(detail.value, '{"key":"value","nested":true}');
      }
    });

    it('params is null should produce empty details', async () => {
      let PermClass = createMockPermissionsClass({ evaluateResult: true });
      let tool = createMockTool({ riskLevel: 'high', PermissionsClass: PermClass });

      try {
        await tool.execute(null);
        assert.fail('should have thrown');
      } catch (error) {
        assert.ok(error instanceof PermissionRequiredError);
        assert.deepEqual(error.details, []);
      }
    });

    it('params with null values should be excluded from details', async () => {
      let PermClass = createMockPermissionsClass({ evaluateResult: true });
      let tool = createMockTool({ riskLevel: 'high', PermissionsClass: PermClass });

      try {
        await tool.execute({ command: 'ls', optional: null });
        assert.fail('should have thrown');
      } catch (error) {
        assert.ok(error instanceof PermissionRequiredError);
        let labels = error.details.map((d) => d.label);
        assert.ok(labels.includes('command'));
        assert.ok(!labels.includes('optional'));
      }
    });

    it('custom PermissionsClass throws non-permission error should propagate', async () => {
      let PermClass = class extends Permissions {
        async checkPermission() { throw new TypeError('Cannot read property of undefined'); }
      };

      let tool = createMockTool({ riskLevel: 'high', PermissionsClass: PermClass });

      await assert.rejects(
        () => tool.execute({}),
        { name: 'TypeError' },
      );
    });

    it('getPermissionsClass returns null should use base Permissions class', async () => {
      // When getPermissionsClass returns null, the base Permissions class is used.
      // Base Permissions.checkPermission() returns null (defer to evaluate).
      // Base evaluate() needs models to query PermissionRule. When models is null
      // (no DB context), evaluate() returns false (allow — dev/test mode).
      let tool = createMockTool({ riskLevel: 'high' });
      tool.getPermissionsClass = () => null;

      let result = await tool.execute({ input: 'test' });
      assert.deepEqual(result, { executed: true, params: { input: 'test' } });
    });

    it('_permissionOptions should extract organizationID, scope, and scopeID', async () => {
      let capturedOptions;
      let PermClass = class extends Permissions {
        async checkPermission() { return null; }
        async evaluate(_feat, _args, opts) {
          capturedOptions = opts;
          return false;
        }
      };

      let agent = { organizationID: 'org_123' };
      let tool = createMockTool({ riskLevel: 'high', PermissionsClass: PermClass });

      await tool.execute({ _agent: agent, _sessionID: 'sess_456', command: 'ls' });

      assert.equal(capturedOptions.organizationID, 'org_123');
      assert.equal(capturedOptions.scope, 'session');
      assert.equal(capturedOptions.scopeID, 'sess_456');
      assert.equal(capturedOptions.agent, agent);
    });
  });
});
