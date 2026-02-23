'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Environment Setup
// ============================================================================

let testDir = mkdtempSync(join(tmpdir(), 'hero-content-registry-test-'));

process.env.HERO_JWT_SECRET     = 'test-secret-key-for-testing';
process.env.HERO_ENCRYPTION_KEY = 'test-encryption-key-32chars!!';
process.env.XDG_CONFIG_HOME     = testDir;

let content;

async function loadModules() {
  content = await import('../../server/lib/content/index.mjs');
}

describe('Content Type Registry', async () => {
  await loadModules();

  // ===========================================================================
  // registerContentType
  // ===========================================================================
  describe('registerContentType()', () => {
    it('should register a custom content type', () => {
      let registered = content.registerContentType('chart', {
        description: 'Chart visualization',
        source:      'test-plugin',
      });

      assert.strictEqual(registered, true);
    });

    it('should return false for duplicate registration', () => {
      content.registerContentType('duplicate-test', {
        description: 'First',
        source:      'test',
      });

      let registered = content.registerContentType('duplicate-test', {
        description: 'Second',
        source:      'test',
      });

      assert.strictEqual(registered, false);
    });

    it('should throw for built-in types', () => {
      assert.throws(
        () => content.registerContentType('text', { description: 'override' }),
        /Cannot override built-in/,
      );
    });

    it('should throw for empty contentType', () => {
      assert.throws(
        () => content.registerContentType('', { description: 'empty' }),
        /must be a non-empty string/,
      );
    });

    it('should throw for null contentType', () => {
      assert.throws(
        () => content.registerContentType(null, { description: 'null' }),
        /must be a non-empty string/,
      );
    });
  });

  // ===========================================================================
  // unregisterContentType
  // ===========================================================================
  describe('unregisterContentType()', () => {
    it('should unregister a custom type', () => {
      content.registerContentType('temp-type', { description: 'Temporary' });
      let removed = content.unregisterContentType('temp-type');
      assert.strictEqual(removed, true);
    });

    it('should return false for non-existent type', () => {
      let removed = content.unregisterContentType('nonexistent');
      assert.strictEqual(removed, false);
    });

    it('should not allow unregistering built-in types', () => {
      let removed = content.unregisterContentType('text');
      assert.strictEqual(removed, false);
    });
  });

  // ===========================================================================
  // getContentRenderer
  // ===========================================================================
  describe('getContentRenderer()', () => {
    it('should return renderer for registered type', () => {
      content.registerContentType('map-test', {
        description:     'Map view',
        source:          'map-plugin',
        clientComponent: 'hero-map-view',
      });

      let renderer = content.getContentRenderer('map-test');
      assert.ok(renderer);
      assert.strictEqual(renderer.description, 'Map view');
      assert.strictEqual(renderer.clientComponent, 'hero-map-view');
    });

    it('should return null for unknown type', () => {
      let renderer = content.getContentRenderer('unknown-type');
      assert.strictEqual(renderer, null);
    });
  });

  // ===========================================================================
  // listContentTypes
  // ===========================================================================
  describe('listContentTypes()', () => {
    it('should include built-in types', () => {
      let types   = content.listContentTypes();
      let builtIn = types.filter((t) => t.isBuiltin);
      assert.ok(builtIn.length >= 5);
      assert.ok(builtIn.some((t) => t.contentType === 'text'));
      assert.ok(builtIn.some((t) => t.contentType === 'image'));
      assert.ok(builtIn.some((t) => t.contentType === 'code'));
    });

    it('should include custom types', () => {
      content.registerContentType('list-test-type', { description: 'List test', source: 'test' });
      let types  = content.listContentTypes();
      let custom = types.filter((t) => !t.isBuiltin);
      assert.ok(custom.length > 0);
    });
  });

  // ===========================================================================
  // transformContent
  // ===========================================================================
  describe('transformContent()', () => {
    it('should apply serverTransform if registered', () => {
      content.registerContentType('transform-test', {
        description:     'Transform test',
        serverTransform: (payload) => ({ ...payload, transformed: true }),
      });

      let result = content.transformContent('transform-test', { data: 'hello' });
      assert.strictEqual(result.transformed, true);
      assert.strictEqual(result.data, 'hello');
    });

    it('should return original payload if no transform', () => {
      content.registerContentType('no-transform-test', {
        description: 'No transform',
      });

      let payload = { data: 'hello' };
      let result  = content.transformContent('no-transform-test', payload);
      assert.strictEqual(result, payload);
    });

    it('should return original payload for unknown type', () => {
      let payload = { data: 'hello' };
      let result  = content.transformContent('unknown-content-type', payload);
      assert.strictEqual(result, payload);
    });

    it('should handle transform errors gracefully', () => {
      content.registerContentType('error-transform-test', {
        description:     'Error transform',
        serverTransform: () => { throw new Error('Transform failed'); },
      });

      let payload = { data: 'hello' };
      let result  = content.transformContent('error-transform-test', payload);
      assert.strictEqual(result, payload);
    });
  });

  // ===========================================================================
  // isKnownContentType
  // ===========================================================================
  describe('isKnownContentType()', () => {
    it('should return true for built-in types', () => {
      assert.strictEqual(content.isKnownContentType('text'), true);
      assert.strictEqual(content.isKnownContentType('image'), true);
      assert.strictEqual(content.isKnownContentType('markdown'), true);
    });

    it('should return true for registered types', () => {
      content.registerContentType('known-test', { description: 'Known' });
      assert.strictEqual(content.isKnownContentType('known-test'), true);
    });

    it('should return false for unknown types', () => {
      assert.strictEqual(content.isKnownContentType('totally-unknown'), false);
    });
  });
});
