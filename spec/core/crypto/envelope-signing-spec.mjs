'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Keystore } from '../../../src/core/crypto/keystore.mjs';

// =============================================================================
// Phase C3 — Envelope Signing Tests
// =============================================================================

describe('Keystore envelope signing (C3)', () => {
  let keystore;

  beforeEach(() => {
    keystore = new Keystore({ devMode: true, devSeed: 'test-signing-seed' });
    keystore.initialize();
  });

  // ---------------------------------------------------------------------------
  // canonicalize
  // ---------------------------------------------------------------------------

  describe('canonicalize', () => {
    it('should produce deterministic JSON with sorted keys', () => {
      let a = keystore.canonicalize({ z: 1, a: 2, m: 3 });
      let b = keystore.canonicalize({ a: 2, m: 3, z: 1 });
      assert.equal(a, b);
      assert.equal(a, '{"a":2,"m":3,"z":1}');
    });

    it('should sort nested objects recursively', () => {
      let result = keystore.canonicalize({ b: { z: 1, a: 2 }, a: 1 });
      assert.equal(result, '{"a":1,"b":{"a":2,"z":1}}');
    });

    it('should preserve array order', () => {
      let result = keystore.canonicalize({ items: [3, 1, 2] });
      assert.equal(result, '{"items":[3,1,2]}');
    });

    it('should handle primitive values', () => {
      assert.equal(keystore.canonicalize('hello'), '"hello"');
      assert.equal(keystore.canonicalize(42), '42');
      assert.equal(keystore.canonicalize(true), 'true');
      assert.equal(keystore.canonicalize(null), 'null');
    });

    it('should handle empty objects and arrays', () => {
      assert.equal(keystore.canonicalize({}), '{}');
      assert.equal(keystore.canonicalize([]), '[]');
    });

    it('should handle deeply nested structures', () => {
      let data = { c: { b: { a: { z: 1, y: 2 } } } };
      let result = keystore.canonicalize(data);
      assert.equal(result, '{"c":{"b":{"a":{"y":2,"z":1}}}}');
    });
  });

  // ---------------------------------------------------------------------------
  // sign
  // ---------------------------------------------------------------------------

  describe('sign', () => {
    it('should produce a hex string', () => {
      let sig = keystore.sign({ toolName: 'shell:execute', args: { command: 'ls' } });
      assert.match(sig, /^[0-9a-f]{64}$/);
    });

    it('should be deterministic for same data', () => {
      let data = { toolName: 'shell:execute', args: { command: 'ls' } };
      let sig1 = keystore.sign(data);
      let sig2 = keystore.sign(data);
      assert.equal(sig1, sig2);
    });

    it('should be deterministic regardless of key order', () => {
      let sig1 = keystore.sign({ b: 2, a: 1 });
      let sig2 = keystore.sign({ a: 1, b: 2 });
      assert.equal(sig1, sig2);
    });

    it('should differ for different data', () => {
      let sig1 = keystore.sign({ action: 'allow' });
      let sig2 = keystore.sign({ action: 'deny' });
      assert.notEqual(sig1, sig2);
    });

    it('should accept string input', () => {
      let sig = keystore.sign('raw string blob');
      assert.match(sig, /^[0-9a-f]{64}$/);
    });

    it('should throw if not initialized', () => {
      let ks = new Keystore();
      assert.throws(() => ks.sign({ data: 1 }), /not initialized/);
    });

    it('should differ between keystores with different seeds', () => {
      let ks2 = new Keystore({ devMode: true, devSeed: 'different-seed' });
      ks2.initialize();

      let data = { toolName: 'test' };
      let sig1 = keystore.sign(data);
      let sig2 = ks2.sign(data);
      assert.notEqual(sig1, sig2);
    });
  });

  // ---------------------------------------------------------------------------
  // verify
  // ---------------------------------------------------------------------------

  describe('verify', () => {
    it('should verify a valid signature', () => {
      let data = { toolName: 'shell:execute', approved: true };
      let sig  = keystore.sign(data);
      assert.equal(keystore.verify(data, sig), true);
    });

    it('should reject a tampered signature', () => {
      let data = { toolName: 'shell:execute' };
      let sig  = keystore.sign(data);

      // Tamper with last character
      let tampered = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');
      assert.equal(keystore.verify(data, tampered), false);
    });

    it('should reject when data changes after signing', () => {
      let data = { toolName: 'shell:execute', args: { command: 'ls' } };
      let sig  = keystore.sign(data);

      let tampered = { toolName: 'shell:execute', args: { command: 'rm -rf /' } };
      assert.equal(keystore.verify(tampered, sig), false);
    });

    it('should verify string data', () => {
      let sig = keystore.sign('test blob');
      assert.equal(keystore.verify('test blob', sig), true);
      assert.equal(keystore.verify('different blob', sig), false);
    });

    it('should throw if not initialized', () => {
      let ks = new Keystore();
      assert.throws(() => ks.verify({ data: 1 }, 'aabb'), /not initialized/);
    });

    it('should throw for invalid signature length', () => {
      let data = { test: true };
      assert.throws(() => keystore.verify(data, 'tooshort'));
    });
  });
});
