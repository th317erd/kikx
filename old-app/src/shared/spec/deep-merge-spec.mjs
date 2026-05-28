'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deepMerge } from '../frame-manager/deep-merge.mjs';

describe('deepMerge', () => {
  describe('null deletion', () => {
    it('should delete a top-level key when incoming value is null', () => {
      let target = { a: 1, b: 2, c: 3 };
      let source = { b: null };
      let result = deepMerge(target, source);

      assert.deepStrictEqual(result, { a: 1, c: 3 });
    });

    it('should delete a nested key when incoming value is null', () => {
      let target = { a: { b: 1, c: 2 }, d: 3 };
      let source = { a: { b: null } };
      let result = deepMerge(target, source);

      assert.deepStrictEqual(result, { a: { c: 2 }, d: 3 });
    });

    it('should handle deleting a key that does not exist in target', () => {
      let target = { a: 1 };
      let source = { z: null };
      let result = deepMerge(target, source);

      assert.deepStrictEqual(result, { a: 1 });
    });
  });

  describe('array full replacement', () => {
    it('should replace target array entirely with source array', () => {
      let target = { items: [1, 2, 3] };
      let source = { items: [4, 5] };
      let result = deepMerge(target, source);

      assert.deepStrictEqual(result, { items: [4, 5] });
    });

    it('should replace a non-array target value with source array', () => {
      let target = { items: 'not an array' };
      let source = { items: [1, 2] };
      let result = deepMerge(target, source);

      assert.deepStrictEqual(result, { items: [1, 2] });
    });

    it('should not share references with the source array', () => {
      let sourceArray = [1, 2, 3];
      let target      = {};
      let source      = { items: sourceArray };
      let result      = deepMerge(target, source);

      sourceArray.push(4);
      assert.deepStrictEqual(result.items, [1, 2, 3]);
    });
  });

  describe('object recursion', () => {
    it('should recursively merge nested objects', () => {
      let target = { a: { b: { c: 1, d: 2 } } };
      let source = { a: { b: { d: 3, e: 4 } } };
      let result = deepMerge(target, source);

      assert.deepStrictEqual(result, { a: { b: { c: 1, d: 3, e: 4 } } });
    });

    it('should create nested structure when target key does not exist', () => {
      let target = { x: 1 };
      let source = { a: { b: { c: 2 } } };
      let result = deepMerge(target, source);

      assert.deepStrictEqual(result, { x: 1, a: { b: { c: 2 } } });
    });

    it('should replace non-object target value with merged object from source', () => {
      let target = { a: 'string' };
      let source = { a: { b: 1 } };
      let result = deepMerge(target, source);

      assert.deepStrictEqual(result, { a: { b: 1 } });
    });
  });

  describe('value replacement', () => {
    it('should replace primitive values', () => {
      let target = { a: 1, b: 'hello', c: true };
      let source = { a: 2, b: 'world', c: false };
      let result = deepMerge(target, source);

      assert.deepStrictEqual(result, { a: 2, b: 'world', c: false });
    });

    it('should add new keys from source', () => {
      let target = { a: 1 };
      let source = { b: 2 };
      let result = deepMerge(target, source);

      assert.deepStrictEqual(result, { a: 1, b: 2 });
    });
  });

  describe('empty object preservation', () => {
    it('should preserve empty objects and not delete them', () => {
      let target = { a: 1 };
      let source = { b: {} };
      let result = deepMerge(target, source);

      assert.deepStrictEqual(result, { a: 1, b: {} });
    });

    it('should merge into an existing key resulting in an empty object', () => {
      let target = { a: { b: 1 } };
      let source = { a: { b: null } };
      let result = deepMerge(target, source);

      assert.deepStrictEqual(result, { a: {} });
    });

    it('should preserve an existing empty object in target', () => {
      let target = { a: {}, b: 1 };
      let source = { b: 2 };
      let result = deepMerge(target, source);

      assert.deepStrictEqual(result, { a: {}, b: 2 });
    });
  });

  describe('prototype pollution prevention', () => {
    it('should ignore __proto__ keys in source', () => {
      let target = { a: 1 };
      let source = JSON.parse('{"__proto__": {"polluted": true}}');
      let result = deepMerge(target, source);

      assert.strictEqual(result.polluted, undefined);
      assert.strictEqual(({}).polluted, undefined);
    });

    it('should ignore constructor keys in source', () => {
      let target = { a: 1 };
      let source = { constructor: { prototype: { polluted: true } } };
      let result = deepMerge(target, source);

      // constructor should not have been overwritten with the malicious value
      assert.strictEqual(result.constructor, Object);
      assert.strictEqual(({}).polluted, undefined);
    });

    it('should ignore nested __proto__ keys', () => {
      let target = { a: { b: 1 } };
      let source = { a: JSON.parse('{"__proto__": {"polluted": true}}') };
      let result = deepMerge(target, source);

      assert.strictEqual(result.a.polluted, undefined);
      assert.strictEqual(({}).polluted, undefined);
    });
  });

  describe('non-plain objects as atomic values', () => {
    it('should treat Date as an atomic value (not recurse)', () => {
      let date   = new Date('2026-01-01');
      let target = { created: new Date('2025-01-01') };
      let source = { created: date };
      let result = deepMerge(target, source);

      assert.strictEqual(result.created, date);
      assert.ok(result.created instanceof Date);
    });

    it('should treat RegExp as an atomic value', () => {
      let regex  = /test/gi;
      let target = { pattern: /old/ };
      let source = { pattern: regex };
      let result = deepMerge(target, source);

      assert.strictEqual(result.pattern, regex);
      assert.ok(result.pattern instanceof RegExp);
    });

    it('should treat Map as an atomic value', () => {
      let map    = new Map([['key', 'value']]);
      let target = {};
      let source = { data: map };
      let result = deepMerge(target, source);

      assert.strictEqual(result.data, map);
      assert.ok(result.data instanceof Map);
    });

    it('should treat Set as an atomic value', () => {
      let set    = new Set([1, 2, 3]);
      let target = {};
      let source = { data: set };
      let result = deepMerge(target, source);

      assert.strictEqual(result.data, set);
      assert.ok(result.data instanceof Set);
    });
  });

  describe('deeply nested merge (10+ levels)', () => {
    it('should correctly merge objects nested 10+ levels deep', () => {
      let target = { l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: { l9: { l10: { l11: { value: 'original', keep: true } } } } } } } } } } } };
      let source = { l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: { l9: { l10: { l11: { value: 'updated' } } } } } } } } } } } };
      let result = deepMerge(target, source);

      assert.strictEqual(result.l1.l2.l3.l4.l5.l6.l7.l8.l9.l10.l11.value, 'updated');
      assert.strictEqual(result.l1.l2.l3.l4.l5.l6.l7.l8.l9.l10.l11.keep, true);
    });
  });

  describe('merging into empty target', () => {
    it('should produce a copy of source when target is empty', () => {
      let target = {};
      let source = { a: 1, b: { c: 2 }, d: [3, 4] };
      let result = deepMerge(target, source);

      assert.deepStrictEqual(result, { a: 1, b: { c: 2 }, d: [3, 4] });
    });

    it('should not share object references with source', () => {
      let target   = {};
      let innerObj = { c: 2 };
      let source   = { b: innerObj };
      let result   = deepMerge(target, source);

      innerObj.c = 99;
      assert.strictEqual(result.b.c, 2);
    });
  });

  describe('merging empty source (no-op)', () => {
    it('should return a copy of target when source is empty', () => {
      let target = { a: 1, b: { c: 2 } };
      let source = {};
      let result = deepMerge(target, source);

      assert.deepStrictEqual(result, { a: 1, b: { c: 2 } });
    });
  });

  describe('null source (no-op / return target copy)', () => {
    it('should return a copy of target when source is null', () => {
      let target = { a: 1, b: 2 };
      let result = deepMerge(target, null);

      assert.deepStrictEqual(result, { a: 1, b: 2 });
    });

    it('should return a copy of target when source is undefined', () => {
      let target = { a: 1, b: 2 };
      let result = deepMerge(target, undefined);

      assert.deepStrictEqual(result, { a: 1, b: 2 });
    });

    it('should return an empty object when both target and source are null', () => {
      let result = deepMerge(null, null);

      assert.deepStrictEqual(result, {});
    });
  });

  describe('immutability', () => {
    it('should not mutate the target object', () => {
      let target = { a: 1, b: { c: 2 } };
      let source = { a: 10, b: { d: 3 } };

      deepMerge(target, source);

      assert.deepStrictEqual(target, { a: 1, b: { c: 2 } });
    });

    it('should not mutate the source object', () => {
      let target = { a: 1 };
      let source = { b: { c: 2 } };

      deepMerge(target, source);

      assert.deepStrictEqual(source, { b: { c: 2 } });
    });
  });
});
