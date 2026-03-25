'use strict';

import { describe, it }  from 'node:test';
import assert             from 'node:assert/strict';
import { FrameManager }  from '../../../src/shared/frame-manager/frame-manager.mjs';

describe('FrameManager registry version tracking', () => {

  // ===========================================================================
  // Constructor
  // ===========================================================================

  it('should default registryVersion to 0', () => {
    let fm = new FrameManager();
    assert.equal(fm.registryVersion, 0);
  });

  it('should accept registryVersion option in constructor', () => {
    let fm = new FrameManager({ registryVersion: 5 });
    assert.equal(fm.registryVersion, 5);
  });

  it('should default registryVersion to 0 when option is falsy', () => {
    let fm = new FrameManager({ registryVersion: 0 });
    assert.equal(fm.registryVersion, 0);

    let fm2 = new FrameManager({ registryVersion: null });
    assert.equal(fm2.registryVersion, 0);

    let fm3 = new FrameManager({ registryVersion: undefined });
    assert.equal(fm3.registryVersion, 0);
  });

  // ===========================================================================
  // registryVersion getter
  // ===========================================================================

  it('should expose registryVersion via getter', () => {
    let fm = new FrameManager({ registryVersion: 42 });
    assert.equal(fm.registryVersion, 42);
  });

  // ===========================================================================
  // setRegistryVersion
  // ===========================================================================

  it('should update registryVersion via setRegistryVersion()', () => {
    let fm = new FrameManager();
    assert.equal(fm.registryVersion, 0);

    fm.setRegistryVersion(3);
    assert.equal(fm.registryVersion, 3);
  });

  it('should allow setting registryVersion to 0', () => {
    let fm = new FrameManager({ registryVersion: 7 });
    fm.setRegistryVersion(0);
    assert.equal(fm.registryVersion, 0);
  });

  it('should overwrite previous registryVersion', () => {
    let fm = new FrameManager();
    fm.setRegistryVersion(1);
    fm.setRegistryVersion(2);
    fm.setRegistryVersion(3);
    assert.equal(fm.registryVersion, 3);
  });

  // ===========================================================================
  // isRegistryStale
  // ===========================================================================

  it('should return false when versions match', () => {
    let fm = new FrameManager({ registryVersion: 5 });
    assert.equal(fm.isRegistryStale(5), false);
  });

  it('should return true when current version is higher (registry advanced)', () => {
    let fm = new FrameManager({ registryVersion: 3 });
    assert.equal(fm.isRegistryStale(4), true);
  });

  it('should return true when current version is lower (unexpected rollback)', () => {
    let fm = new FrameManager({ registryVersion: 5 });
    assert.equal(fm.isRegistryStale(2), true);
  });

  it('should return false for default version compared to 0', () => {
    let fm = new FrameManager();
    assert.equal(fm.isRegistryStale(0), false);
  });

  it('should return true for default version compared to non-zero', () => {
    let fm = new FrameManager();
    assert.equal(fm.isRegistryStale(1), true);
  });

  it('should reflect setRegistryVersion in isRegistryStale', () => {
    let fm = new FrameManager();
    assert.equal(fm.isRegistryStale(3), true);

    fm.setRegistryVersion(3);
    assert.equal(fm.isRegistryStale(3), false);

    fm.setRegistryVersion(4);
    assert.equal(fm.isRegistryStale(3), true);
  });

  // ===========================================================================
  // Isolation — registry version does not affect other FrameManager behavior
  // ===========================================================================

  it('should not affect merge behavior', () => {
    let fm = new FrameManager({ registryVersion: 10 });
    let results = fm.merge([
      { id: 'f1', type: 'Message', content: { text: 'hello' } },
    ]);

    assert.equal(results.length, 1);
    assert.equal(fm.registryVersion, 10);
  });

  it('should not be affected by snapshot/restore', () => {
    let fm = new FrameManager({
      registryVersion:  7,
      commitValidator:  () => ({ allowed: false, reason: 'test rejection' }),
    });

    // Merge will be rejected by validator, triggering snapshot restore
    let results = fm.merge([
      { id: 'f1', type: 'Message', content: { text: 'hello' } },
    ]);

    assert.equal(results.length, 0);
    // registryVersion should survive the restore (it's not part of the snapshot)
    assert.equal(fm.registryVersion, 7);
  });
});
