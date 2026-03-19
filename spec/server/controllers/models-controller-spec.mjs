'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ModelsController } from '../../../src/server/controllers/models-controller.mjs';

// =============================================================================
// ModelsController Tests
// =============================================================================
// GET /api/v2/models — returns aggregated model list from all loaded plugins
// =============================================================================

function buildController(overrides = {}) {
  let controller = Object.create(ModelsController.prototype);

  controller.getCore = () => ({
    getPluginLoader: overrides.getPluginLoader || (() => null),
  });

  // Simulate auth middleware already ran
  controller.request = { organizationID: 'org_test' };

  return controller;
}

describe('ModelsController', () => {

  // ---------------------------------------------------------------------------
  // Happy paths
  // ---------------------------------------------------------------------------

  it('should return 200 with empty models array when no plugins loaded', async () => {
    let controller = buildController({ getPluginLoader: () => null });
    let result     = await controller.index();
    assert.deepEqual(result, { data: { models: [] } });
  });

  it('should return 200 with empty models array when registry has no agent types', async () => {
    let mockRegistry = {
      getAgentTypes: () => new Map(),
    };

    let controller = buildController({
      getPluginLoader: () => ({ getRegistry: () => mockRegistry }),
    });

    let result = await controller.index();
    assert.deepEqual(result, { data: { models: [] } });
  });

  it('should return models from a single plugin', async () => {
    let models = [
      { id: 'model-a', contextWindow: 100000, displayName: 'Model A' },
    ];

    class FakeAgentClass {
      static getModels() { return models; }
    }

    let mockRegistry = {
      getAgentTypes: () => new Map([['fake-plugin', FakeAgentClass]]),
    };

    let controller = buildController({
      getPluginLoader: () => ({ getRegistry: () => mockRegistry }),
    });

    let result = await controller.index();

    assert.ok(Array.isArray(result.data.models));
    assert.equal(result.data.models.length, 1);
    assert.equal(result.data.models[0].pluginID, 'fake-plugin');
    assert.equal(result.data.models[0].id, 'model-a');
    assert.equal(result.data.models[0].contextWindow, 100000);
  });

  it('should aggregate models from multiple plugins', async () => {
    class PluginA {
      static getModels() {
        return [{ id: 'model-a1' }, { id: 'model-a2' }];
      }
    }

    class PluginB {
      static getModels() {
        return [{ id: 'model-b1' }];
      }
    }

    let mockRegistry = {
      getAgentTypes: () => new Map([
        ['plugin-a', PluginA],
        ['plugin-b', PluginB],
      ]),
    };

    let controller = buildController({
      getPluginLoader: () => ({ getRegistry: () => mockRegistry }),
    });

    let result = await controller.index();

    assert.equal(result.data.models.length, 3);

    let pluginAModels = result.data.models.filter((m) => m.pluginID === 'plugin-a');
    let pluginBModels = result.data.models.filter((m) => m.pluginID === 'plugin-b');

    assert.equal(pluginAModels.length, 2);
    assert.equal(pluginBModels.length, 1);
  });

  it('should include pluginID prefix on each model', async () => {
    class PluginX {
      static getModels() {
        return [{ id: 'xmodel', contextWindow: 50000 }];
      }
    }

    let mockRegistry = {
      getAgentTypes: () => new Map([['plugin-x', PluginX]]),
    };

    let controller = buildController({
      getPluginLoader: () => ({ getRegistry: () => mockRegistry }),
    });

    let result = await controller.index();
    let model  = result.data.models[0];

    assert.equal(model.pluginID, 'plugin-x');
    assert.equal(model.id, 'xmodel');
    assert.equal(model.contextWindow, 50000);
  });

  // ---------------------------------------------------------------------------
  // Failure paths
  // ---------------------------------------------------------------------------

  it('should skip plugin if getModels() throws and not crash', async () => {
    class BadPlugin {
      static getModels() { throw new Error('boom'); }
    }

    class GoodPlugin {
      static getModels() { return [{ id: 'good-model' }]; }
    }

    let mockRegistry = {
      getAgentTypes: () => new Map([
        ['bad-plugin', BadPlugin],
        ['good-plugin', GoodPlugin],
      ]),
    };

    let controller = buildController({
      getPluginLoader: () => ({ getRegistry: () => mockRegistry }),
    });

    let result = await controller.index();

    // bad-plugin should be skipped, good-plugin included
    assert.equal(result.data.models.length, 1);
    assert.equal(result.data.models[0].pluginID, 'good-plugin');
  });

  it('should skip plugin that has no getModels() method', async () => {
    class OldPlugin {
      // No getModels() — legacy plugin
    }

    class NewPlugin {
      static getModels() { return [{ id: 'new-model' }]; }
    }

    let mockRegistry = {
      getAgentTypes: () => new Map([
        ['old-plugin', OldPlugin],
        ['new-plugin', NewPlugin],
      ]),
    };

    let controller = buildController({
      getPluginLoader: () => ({ getRegistry: () => mockRegistry }),
    });

    let result = await controller.index();

    assert.equal(result.data.models.length, 1);
    assert.equal(result.data.models[0].pluginID, 'new-plugin');
  });

  it('should return empty models if all plugins throw from getModels()', async () => {
    class BadPlugin1 {
      static getModels() { throw new Error('error 1'); }
    }

    class BadPlugin2 {
      static getModels() { throw new Error('error 2'); }
    }

    let mockRegistry = {
      getAgentTypes: () => new Map([
        ['bad1', BadPlugin1],
        ['bad2', BadPlugin2],
      ]),
    };

    let controller = buildController({
      getPluginLoader: () => ({ getRegistry: () => mockRegistry }),
    });

    let result = await controller.index();
    assert.deepEqual(result, { data: { models: [] } });
  });

  it('should handle plugin that returns null from getModels()', async () => {
    class NullPlugin {
      static getModels() { return null; }
    }

    let mockRegistry = {
      getAgentTypes: () => new Map([['null-plugin', NullPlugin]]),
    };

    let controller = buildController({
      getPluginLoader: () => ({ getRegistry: () => mockRegistry }),
    });

    let result = await controller.index();
    assert.deepEqual(result, { data: { models: [] } });
  });

  it('should handle plugin that returns empty array from getModels()', async () => {
    class EmptyPlugin {
      static getModels() { return []; }
    }

    let mockRegistry = {
      getAgentTypes: () => new Map([['empty-plugin', EmptyPlugin]]),
    };

    let controller = buildController({
      getPluginLoader: () => ({ getRegistry: () => mockRegistry }),
    });

    let result = await controller.index();
    assert.deepEqual(result, { data: { models: [] } });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('should allow two plugins to export a model with the same id (different pluginIDs)', async () => {
    class PluginAlpha {
      static getModels() { return [{ id: 'shared-model-id' }]; }
    }

    class PluginBeta {
      static getModels() { return [{ id: 'shared-model-id' }]; }
    }

    let mockRegistry = {
      getAgentTypes: () => new Map([
        ['plugin-alpha', PluginAlpha],
        ['plugin-beta', PluginBeta],
      ]),
    };

    let controller = buildController({
      getPluginLoader: () => ({ getRegistry: () => mockRegistry }),
    });

    let result = await controller.index();

    // Both should be present — identified by different pluginIDs
    assert.equal(result.data.models.length, 2);

    let ids = result.data.models.map((m) => m.pluginID);
    assert.ok(ids.includes('plugin-alpha'));
    assert.ok(ids.includes('plugin-beta'));
  });

  it('should return models: [] when registry has no getAgentTypes', async () => {
    // If getAgentTypes() is missing on registry — should not crash
    let mockRegistry = {};

    let controller = buildController({
      getPluginLoader: () => ({ getRegistry: () => mockRegistry }),
    });

    // Should handle gracefully (throw or return empty)
    let result;
    try {
      result = await controller.index();
      assert.deepEqual(result, { data: { models: [] } });
    } catch (err) {
      // Acceptable to throw — test that it doesn't return partial data
      assert.ok(err instanceof Error);
    }
  });
});
