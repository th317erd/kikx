'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert                        from 'node:assert/strict';

import { PluginInterface }          from '../../../src/core/plugin-loader/plugin-interface.mjs';
import { PermissionRequiredError }  from '../../../src/core/permissions/permission-required-error.mjs';

// =============================================================================
// PluginInterface — Permission Checking
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
      if (name === 'permissionEngine')
        return overrides.permissionEngine || null;

      return null;
    },
  };

  return new MockTool(context);
}

function createMockPermissionEngine(checkResult) {
  return {
    checkPermission: async () => checkResult,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('PluginInterface — Permission Checking', () => {

  // ===========================================================================
  // Happy paths: base default (no PermissionsClass)
  // ===========================================================================

  describe('base default (no PermissionsClass)', () => {

    it('riskLevel "none" should return immediately without calling PermissionEngine', async () => {
      let engineCalled = false;
      let engine = {
        checkPermission: async () => {
          engineCalled = true;
          return true;
        },
      };

      let tool = createMockTool({ riskLevel: 'none', permissionEngine: engine });
      let result = await tool.execute({ input: 'test' });

      assert.equal(engineCalled, false);
      assert.deepEqual(result, { executed: true, params: { input: 'test' } });
    });

    it('riskLevel "high" + PermissionEngine approved should run _execute', async () => {
      let engine = createMockPermissionEngine(false); // false = approved
      let tool   = createMockTool({ riskLevel: 'high', permissionEngine: engine });
      let result = await tool.execute({ input: 'test' });

      assert.deepEqual(result, { executed: true, params: { input: 'test' } });
    });

    it('riskLevel "high" + PermissionEngine needs approval should throw PermissionRequiredError', async () => {
      let engine = createMockPermissionEngine(true); // true = needs approval
      let tool   = createMockTool({ riskLevel: 'high', permissionEngine: engine });

      await assert.rejects(
        () => tool.execute({ input: 'test' }),
        (error) => {
          assert.ok(error instanceof PermissionRequiredError);
          assert.equal(error.name, 'PermissionRequiredError');
          return true;
        },
      );
    });

    it('should strip _ params and format as label/value in default details', async () => {
      let engine = createMockPermissionEngine(true);
      let tool   = createMockTool({ riskLevel: 'high', permissionEngine: engine });

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

    it('_featureName() should return "pluginID:featureName"', async () => {
      let engine = createMockPermissionEngine(true);
      let tool   = createMockTool({
        pluginID:         'myPlugin',
        featureName:      'myFeature',
        riskLevel:        'high',
        permissionEngine: engine,
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
  // Happy paths: custom PermissionsClass
  // ===========================================================================

  describe('custom PermissionsClass', () => {

    it('checkPermission returns false should approve (no throw)', async () => {
      class MockPermissions {
        constructor() {}
        async checkPermission() { return false; }
      }

      let tool = createMockTool({
        riskLevel:        'high',
        PermissionsClass: MockPermissions,
        permissionEngine: createMockPermissionEngine(true), // engine would deny
      });

      let result = await tool.execute({ input: 'test' });
      assert.deepEqual(result, { executed: true, params: { input: 'test' } });
    });

    it('checkPermission returns true should throw default PermissionRequiredError', async () => {
      class MockPermissions {
        constructor() {}
        async checkPermission() { return true; }
      }

      let tool = createMockTool({
        riskLevel:        'high',
        PermissionsClass: MockPermissions,
      });

      await assert.rejects(
        () => tool.execute({ command: 'test' }),
        (error) => {
          assert.ok(error instanceof PermissionRequiredError);
          return true;
        },
      );
    });

    it('checkPermission throws PermissionRequiredError should rethrow with rich context', async () => {
      class MockPermissions {
        constructor() {}
        async checkPermission() {
          throw new PermissionRequiredError('shell:execute', {
            title:       'Run dangerous command',
            description: 'This command is dangerous.',
            details:     [{ label: 'command', value: 'rm -rf /' }],
          });
        }
      }

      let tool = createMockTool({
        riskLevel:        'high',
        PermissionsClass: MockPermissions,
      });

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

    it('checkPermission returns null should fall through to PermissionEngine', async () => {
      let engineCalled = false;
      let engine = {
        checkPermission: async () => {
          engineCalled = true;
          return false; // approved
        },
      };

      class MockPermissions {
        constructor() {}
        async checkPermission() { return null; }
      }

      let tool = createMockTool({
        riskLevel:        'high',
        PermissionsClass: MockPermissions,
        permissionEngine: engine,
      });

      let result = await tool.execute({ input: 'test' });
      assert.equal(engineCalled, true);
      assert.deepEqual(result, { executed: true, params: { input: 'test' } });
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
      let engine = createMockPermissionEngine(false);
      let tool   = createMockTool({ riskLevel: 'high', permissionEngine: engine });

      let params = { command: 'ls', _sessionID: 'sess123' };
      await tool.execute(params);

      assert.equal(tool._params, params);
    });

    it('should return _execute() result', async () => {
      let engine = createMockPermissionEngine(false);
      let tool   = createMockTool({ riskLevel: 'high', permissionEngine: engine });
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

      let engine  = createMockPermissionEngine(true); // needs approval
      let context = { getProperty: (name) => name === 'permissionEngine' ? engine : null };
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
  // Sad paths
  // ===========================================================================

  describe('sad paths', () => {

    it('no PermissionEngine on context should allow (dev mode)', async () => {
      let tool   = createMockTool({ riskLevel: 'high', permissionEngine: null });
      let result = await tool.execute({ input: 'test' });

      assert.deepEqual(result, { executed: true, params: { input: 'test' } });
    });

    it('PermissionEngine throws unexpected error should propagate', async () => {
      let engine = {
        checkPermission: async () => { throw new Error('Database connection lost'); },
      };

      let tool = createMockTool({ riskLevel: 'high', permissionEngine: engine });

      await assert.rejects(
        () => tool.execute({}),
        { message: 'Database connection lost' },
      );
    });

    it('getPermissionsClass returns null should use base default', async () => {
      class NullPermissions {
        constructor() {}
      }

      // Override getPermissionsClass to return null explicitly
      let engine = createMockPermissionEngine(false);
      let tool   = createMockTool({ riskLevel: 'high', permissionEngine: engine });
      tool.getPermissionsClass = () => null;

      let result = await tool.execute({ input: 'test' });
      assert.deepEqual(result, { executed: true, params: { input: 'test' } });
    });

    it('riskLevel undefined should be treated as needing permission (deny-by-default)', async () => {
      let engine = createMockPermissionEngine(true); // needs approval
      let tool   = createMockTool({ riskLevel: undefined, permissionEngine: engine });

      await assert.rejects(
        () => tool.execute({}),
        (error) => {
          assert.ok(error instanceof PermissionRequiredError);
          return true;
        },
      );
    });

    it('riskLevel "critical" should always need approval', async () => {
      // Even if engine says approved, critical means the engine itself returns true
      // (per PermissionEngine logic). We test that _checkPermissions passes through.
      let engine = createMockPermissionEngine(true);
      let tool   = createMockTool({ riskLevel: 'critical', permissionEngine: engine });

      await assert.rejects(
        () => tool.execute({}),
        (error) => {
          assert.ok(error instanceof PermissionRequiredError);
          return true;
        },
      );
    });

    it('params with only _ keys should produce empty details', async () => {
      let engine = createMockPermissionEngine(true);
      let tool   = createMockTool({ riskLevel: 'high', permissionEngine: engine });

      try {
        await tool.execute({ _sessionID: 'sess', _agent: { organizationID: 'org' } });
        assert.fail('should have thrown');
      } catch (error) {
        assert.ok(error instanceof PermissionRequiredError);
        assert.deepEqual(error.details, []);
      }
    });

    it('params with large values should be truncated to 200 chars', async () => {
      let engine = createMockPermissionEngine(true);
      let tool   = createMockTool({ riskLevel: 'high', permissionEngine: engine });

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
      let engine = createMockPermissionEngine(true);
      let tool   = createMockTool({ riskLevel: 'high', permissionEngine: engine });

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
      let engine = createMockPermissionEngine(true);
      let tool   = createMockTool({ riskLevel: 'high', permissionEngine: engine });

      try {
        await tool.execute(null);
        assert.fail('should have thrown');
      } catch (error) {
        assert.ok(error instanceof PermissionRequiredError);
        assert.deepEqual(error.details, []);
      }
    });

    it('params with null values should be excluded from details', async () => {
      let engine = createMockPermissionEngine(true);
      let tool   = createMockTool({ riskLevel: 'high', permissionEngine: engine });

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
      class BrokenPermissions {
        constructor() {}
        async checkPermission() { throw new TypeError('Cannot read property of undefined'); }
      }

      let tool = createMockTool({
        riskLevel:        'high',
        PermissionsClass: BrokenPermissions,
      });

      await assert.rejects(
        () => tool.execute({}),
        { name: 'TypeError' },
      );
    });

    it('_permissionOptions should extract organizationID, scope, and scopeID', async () => {
      // We test this indirectly by verifying the engine receives the right options
      let capturedOptions;
      let engine = {
        checkPermission: async (_feat, _args, opts) => {
          capturedOptions = opts;
          return false; // approved
        },
      };

      let agent = { organizationID: 'org_123' };
      let tool  = createMockTool({ riskLevel: 'high', permissionEngine: engine });

      await tool.execute({ _agent: agent, _sessionID: 'sess_456', command: 'ls' });

      assert.equal(capturedOptions.organizationID, 'org_123');
      assert.equal(capturedOptions.scope, 'session');
      assert.equal(capturedOptions.scopeID, 'sess_456');
      assert.equal(capturedOptions.agent, agent);
    });
  });
});
