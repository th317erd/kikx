'use strict';

// ============================================================================
// Render Loop Prevention Tests
// ============================================================================
// Tests for Smell 2.2: Multiple Render Triggers
//
// These tests verify that:
// 1. Rapid render calls are batched properly
// 2. Render loop detection resets after a time window
// 3. Dirty checking prevents unnecessary renders

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ============================================================================
// Test: RAF-based Render Batching
// ============================================================================

describe('Render Batching', () => {
  /**
   * Simulates a render scheduler with RAF batching.
   * Multiple calls within one frame are batched into a single render.
   */
  class RenderScheduler {
    constructor() {
      this._renderCount = 0;
      this._rafId = null;
      this._dirty = false;
      this._lastRenderTime = 0;
      this._renderWindowMs = 100; // Reset counter after 100ms of inactivity
    }

    scheduleRender() {
      this._dirty = true;

      // If already scheduled, skip
      if (this._rafId !== null) {
        return;
      }

      // Schedule via RAF (simulated with setTimeout in tests)
      this._rafId = setTimeout(() => {
        this._rafId = null;
        if (this._dirty) {
          this._executeRender();
        }
      }, 16); // ~60fps
    }

    _executeRender() {
      const now = Date.now();

      // Reset counter if enough time has passed since last render
      if (now - this._lastRenderTime > this._renderWindowMs) {
        this._renderCount = 0;
      }

      this._renderCount++;
      this._lastRenderTime = now;
      this._dirty = false;

      // Detect actual infinite loops (many renders in short window)
      if (this._renderCount > 50) {
        throw new Error('Render loop detected: too many renders in time window');
      }
    }

    getRenderCount() {
      return this._renderCount;
    }

    cancelPending() {
      if (this._rafId !== null) {
        clearTimeout(this._rafId);
        this._rafId = null;
      }
    }
  }

  it('should batch multiple rapid render calls into one', async () => {
    const scheduler = new RenderScheduler();

    // Call scheduleRender 10 times rapidly
    for (let i = 0; i < 10; i++) {
      scheduler.scheduleRender();
    }

    // Wait for RAF to fire
    await new Promise(r => setTimeout(r, 50));

    // Should have only rendered once
    assert.strictEqual(scheduler.getRenderCount(), 1, 'Should batch into single render');

    scheduler.cancelPending();
  });

  it('should allow multiple renders spread over time', async () => {
    const scheduler = new RenderScheduler();

    // First render
    scheduler.scheduleRender();
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(scheduler.getRenderCount(), 1);

    // Second render after waiting
    scheduler.scheduleRender();
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(scheduler.getRenderCount(), 2);

    // Third render after waiting
    scheduler.scheduleRender();
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(scheduler.getRenderCount(), 3);

    scheduler.cancelPending();
  });

  it('should reset render count after inactivity window', async () => {
    const scheduler = new RenderScheduler();
    scheduler._renderWindowMs = 50; // Shorter for test

    // Do several renders
    scheduler.scheduleRender();
    await new Promise(r => setTimeout(r, 20));
    scheduler.scheduleRender();
    await new Promise(r => setTimeout(r, 20));
    scheduler.scheduleRender();
    await new Promise(r => setTimeout(r, 20));

    const countAfterBurst = scheduler.getRenderCount();

    // Wait for inactivity window
    await new Promise(r => setTimeout(r, 100));

    // Next render should reset count
    scheduler.scheduleRender();
    await new Promise(r => setTimeout(r, 20));

    assert.strictEqual(scheduler.getRenderCount(), 1, 'Should reset count after inactivity');

    scheduler.cancelPending();
  });
});

// ============================================================================
// Test: Dirty Checking
// ============================================================================

describe('Dirty Checking', () => {
  /**
   * Simulates a state container with dirty checking.
   * Only triggers render if state actually changed.
   */
  class StateWithDirtyCheck {
    constructor() {
      this._state = {};
      this._renderCallCount = 0;
    }

    setState(key, value) {
      // Only mark dirty if value actually changed
      if (this._state[key] === value) {
        return false; // No change
      }

      this._state[key] = value;
      this._render();
      return true; // Changed
    }

    getState(key) {
      return this._state[key];
    }

    _render() {
      this._renderCallCount++;
    }

    getRenderCallCount() {
      return this._renderCallCount;
    }
  }

  it('should not render when setting same value', () => {
    const state = new StateWithDirtyCheck();

    state.setState('name', 'Alice');
    assert.strictEqual(state.getRenderCallCount(), 1);

    // Set same value again - should NOT trigger render
    const changed = state.setState('name', 'Alice');
    assert.strictEqual(changed, false, 'Should return false when unchanged');
    assert.strictEqual(state.getRenderCallCount(), 1, 'Should not render for same value');
  });

  it('should render when setting different value', () => {
    const state = new StateWithDirtyCheck();

    state.setState('name', 'Alice');
    assert.strictEqual(state.getRenderCallCount(), 1);

    // Set different value - should trigger render
    const changed = state.setState('name', 'Bob');
    assert.strictEqual(changed, true, 'Should return true when changed');
    assert.strictEqual(state.getRenderCallCount(), 2, 'Should render for new value');
  });

  it('should track multiple state keys independently', () => {
    const state = new StateWithDirtyCheck();

    state.setState('a', 1);
    state.setState('b', 2);
    assert.strictEqual(state.getRenderCallCount(), 2);

    // Change only 'a' - should render
    state.setState('a', 10);
    assert.strictEqual(state.getRenderCallCount(), 3);

    // Set 'b' to same value - should NOT render
    state.setState('b', 2);
    assert.strictEqual(state.getRenderCallCount(), 3, 'Should not render when b unchanged');
  });
});

// ============================================================================
// Test: Render Loop Detection (Improved)
// ============================================================================

describe('Improved Render Loop Detection', () => {
  /**
   * Improved render loop detector that:
   * 1. Uses time-based window instead of absolute count
   * 2. Allows legitimate rapid renders
   * 3. Only triggers on true infinite loops
   */
  class ImprovedRenderLoopDetector {
    constructor(options = {}) {
      this._renderTimes = [];
      this._windowMs = options.windowMs || 1000;
      this._maxRendersInWindow = options.maxRendersInWindow || 100;
    }

    recordRender() {
      const now = Date.now();

      // Remove renders outside the window
      this._renderTimes = this._renderTimes.filter(
        t => now - t < this._windowMs
      );

      // Add current render
      this._renderTimes.push(now);

      // Check for loop
      if (this._renderTimes.length > this._maxRendersInWindow) {
        return { isLoop: true, count: this._renderTimes.length };
      }

      return { isLoop: false, count: this._renderTimes.length };
    }

    getRecentRenderCount() {
      const now = Date.now();
      return this._renderTimes.filter(t => now - t < this._windowMs).length;
    }

    reset() {
      this._renderTimes = [];
    }
  }

  it('should not trigger on spread-out renders', async () => {
    const detector = new ImprovedRenderLoopDetector({
      windowMs: 50, // Short window
      maxRendersInWindow: 5,
    });

    // 10 renders, but spread out with waits between
    for (let i = 0; i < 10; i++) {
      // Wait for window to clear between each render
      await new Promise(r => setTimeout(r, 60));
      const result = detector.recordRender();
      assert.strictEqual(result.isLoop, false, `Render ${i} should not trigger loop`);
      assert.strictEqual(result.count, 1, `Should only count current render (window cleared)`);
    }
  });

  it('should trigger on rapid renders exceeding threshold', () => {
    const detector = new ImprovedRenderLoopDetector({
      windowMs: 1000, // Long window
      maxRendersInWindow: 10,
    });

    // Rapid renders that exceed threshold
    let loopDetected = false;
    for (let i = 0; i < 15; i++) {
      const result = detector.recordRender();
      if (result.isLoop) {
        loopDetected = true;
        break;
      }
    }

    assert.strictEqual(loopDetected, true, 'Should detect loop for rapid renders');
  });

  it('should reset after time window passes', async () => {
    const detector = new ImprovedRenderLoopDetector({
      windowMs: 50,
      maxRendersInWindow: 5,
    });

    // Do some renders
    for (let i = 0; i < 4; i++) {
      detector.recordRender();
    }

    assert.strictEqual(detector.getRecentRenderCount(), 4);

    // Wait for window to pass
    await new Promise(r => setTimeout(r, 100));

    assert.strictEqual(detector.getRecentRenderCount(), 0, 'Should have 0 recent renders');

    // Next render should be fine
    const result = detector.recordRender();
    assert.strictEqual(result.isLoop, false);
    assert.strictEqual(result.count, 1);
  });
});

// ============================================================================
// Test: Event Cascade Prevention (Smell 2.3)
// ============================================================================

describe('Event Cascade Prevention', () => {
  /**
   * Improved event handling using WeakSet for "consumed" events.
   * Better than object property mutation.
   */
  const consumedEvents = new WeakSet();

  function consumeEvent(event) {
    if (consumedEvents.has(event)) {
      return false; // Already consumed
    }
    consumedEvents.add(event);
    return true; // First consumer
  }

  function isEventConsumed(event) {
    return consumedEvents.has(event);
  }

  it('should allow first handler to consume event', () => {
    const event = { type: 'keydown', key: 'Enter' };

    const consumed = consumeEvent(event);

    assert.strictEqual(consumed, true, 'First handler should consume');
    assert.strictEqual(isEventConsumed(event), true, 'Event should be marked consumed');
  });

  it('should prevent second handler from consuming same event', () => {
    const event = { type: 'keydown', key: 'Enter' };

    const first = consumeEvent(event);
    const second = consumeEvent(event);

    assert.strictEqual(first, true, 'First should consume');
    assert.strictEqual(second, false, 'Second should not consume');
  });

  it('should handle different event objects independently', () => {
    const event1 = { type: 'keydown', key: 'Enter' };
    const event2 = { type: 'keydown', key: 'Enter' };

    consumeEvent(event1);
    const consumedEvent2 = consumeEvent(event2);

    assert.strictEqual(consumedEvent2, true, 'Different event objects should be independent');
  });
});
