'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FrameManager } from '../frame-manager/frame-manager.mjs';
import { IntegrityChecker } from './test-utils/integrity-checker.mjs';
import { HistoryWalker } from './test-utils/history-walker.mjs';

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 9b — Adversarial Tests (H1-H22)
//
// Deliberate hack attempts that try to break the system.
// The FrameManager's validation posture is SILENT REJECTION: invalid input is
// silently dropped/ignored, never throws (except merge() with non-array = TypeError).
// Every test ends with IntegrityChecker.assertValid(fm) unless otherwise noted.
// ═══════════════════════════════════════════════════════════════════════════════

describe('Adversarial Tests', () => {

  // ─── Property Attacks (H1-H6) ──────────────────────────────────────────────

  describe('Property Attacks', () => {
    it('H1: merge cannot hijack frame id', () => {
      let fm = new FrameManager();

      fm.merge([
        { id: 'f1', type: 'message', content: { text: 'original' } },
      ]);

      let originalID = fm.get('f1').id;

      // Attack: attempt to overwrite the id via a merge targeting f1
      fm.merge([
        { id: 'atk-1', type: 'merge', targets: ['f1'], content: { hijack: true }, id: 'hijacked' },
      ]);

      // The attack frame uses its own id 'atk-1' (or 'hijacked' if the literal wins),
      // but f1 must keep its original id regardless.
      let f1 = fm.getHead('f1');
      assert.equal(f1.id, originalID, 'Frame f1 should keep its original id');

      IntegrityChecker.assertValid(fm);
    });

    it('H2: merge cannot overwrite createdAt', () => {
      let fm = new FrameManager();

      fm.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      let originalCreatedAt = fm.get('f1').createdAt;

      // Attack: attempt to overwrite createdAt via merge targeting f1
      fm.merge([
        { id: 'atk-2', type: 'merge', targets: ['f1'], content: { text: 'modified' }, createdAt: 0 },
      ]);

      let f1 = fm.getHead('f1');
      assert.equal(f1.createdAt, originalCreatedAt, 'Frame f1 should keep original createdAt');

      IntegrityChecker.assertValid(fm);
    });

    it('H3: merge cannot change frame type', () => {
      let fm = new FrameManager();

      fm.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      // Attack: attempt to change the type via merge targeting f1
      fm.merge([
        { id: 'atk-3', type: 'permission-grant', targets: ['f1'], content: { escalated: true } },
      ]);

      let f1 = fm.getHead('f1');
      assert.equal(f1.type, 'message', 'Frame f1 should keep type "message"');

      IntegrityChecker.assertValid(fm);
    });

    it('H4: merge cannot reparent a frame', () => {
      let fm = new FrameManager();

      // Create interaction I1 with child F1
      fm.merge([
        { id: 'i1', type: 'interaction', content: {} },
        { id: 'f1', type: 'message', parentID: 'i1', content: { text: 'child of i1' } },
        { id: 'i2', type: 'interaction', content: {} },
      ]);

      assert.equal(fm.get('f1').parentID, 'i1');

      // Attack: try to reparent f1 to i2 via merge
      fm.merge([
        { id: 'atk-4', type: 'merge', targets: ['f1'], content: {}, parentID: 'i2' },
      ]);

      let f1 = fm.getHead('f1');
      assert.equal(f1.parentID, 'i1', 'Frame f1 should remain child of i1');

      IntegrityChecker.assertValid(fm);
    });

    it('H5: merge cannot forge processed/processedAt', () => {
      let fm = new FrameManager();

      fm.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      // Attack: try to forge processed and processedAt via merge
      fm.merge([
        { id: 'atk-5', type: 'merge', targets: ['f1'], content: {}, processed: 'forged', processedAt: 12345 },
      ]);

      let f1 = fm.getHead('f1');
      assert.equal(f1.processed, null, 'processed should remain null');
      assert.equal(f1.processedAt, null, 'processedAt should remain null');

      IntegrityChecker.assertValid(fm);
    });

    it('H6: merge cannot change frame order', () => {
      let fm = new FrameManager();

      fm.merge([
        { id: 'f1', type: 'message', content: {} },
        { id: 'f2', type: 'message', content: {} },
        { id: 'f3', type: 'message', content: {} },
      ]);

      let originalOrder = fm.get('f2').order;

      // Attack: try to change f2's order to 999 via merge
      fm.merge([
        { id: 'atk-6', type: 'merge', targets: ['f2'], content: {}, order: 999 },
      ]);

      let f2 = fm.getHead('f2');
      assert.equal(f2.order, originalOrder, 'Frame f2 should keep its original order');

      IntegrityChecker.assertValid(fm);
    });
  });

  // ─── Structural Attacks (H7-H12) ───────────────────────────────────────────

  describe('Structural Attacks', () => {
    it('H7: self-referencing target is safely ignored', () => {
      let fm = new FrameManager();

      fm.merge([
        { id: 'f1', type: 'message', content: { text: 'original' } },
      ]);

      // Attack: merge a frame where id and target are the same
      fm.merge([
        { id: 'f1', type: 'merge', targets: ['f1'], content: { text: 'self-merge' } },
      ]);

      // f1 should not be corrupted; self-referencing target is skipped
      let f1 = fm.getHead('f1');
      assert.ok(f1, 'f1 should still exist');

      HistoryWalker.assertChainIntegrity(fm, 'f1');
      IntegrityChecker.assertValid(fm);
    });

    it('H8: duplicate targets apply merge only once', () => {
      let fm = new FrameManager();

      fm.merge([
        { id: 'f1', type: 'message', content: { count: 0 } },
      ]);

      // Attack: triple-duplicate target
      fm.merge([
        { id: 'atk-8', type: 'merge', targets: ['f1', 'f1', 'f1'], content: { count: 1 } },
      ]);

      let f1 = fm.getHead('f1');
      assert.equal(f1.content.count, 1);

      // Chain length: original f1 + one merge = 2 versions in the pointer chain
      HistoryWalker.assertChainLength(fm, 'f1', 2);
      HistoryWalker.assertChainIntegrity(fm, 'f1');
      IntegrityChecker.assertValid(fm);
    });

    it('H9: no circular FramePointer chain from chained merges', () => {
      let fm = new FrameManager();

      fm.merge([
        { id: 'f1', type: 'message', content: { text: 'a' } },
        { id: 'f2', type: 'message', content: { text: 'b' } },
        { id: 'f3', type: 'message', content: { text: 'c' } },
      ]);

      // Chain of merges: f2->f1, f3->f2, f1->f3
      fm.merge([
        { id: 'atk-9a', type: 'merge', targets: ['f1'], content: { from: 'f2' } },
      ]);
      fm.merge([
        { id: 'atk-9b', type: 'merge', targets: ['f2'], content: { from: 'f3' } },
      ]);
      fm.merge([
        { id: 'atk-9c', type: 'merge', targets: ['f3'], content: { from: 'f1' } },
      ]);

      // Verify no circular pointer chains
      HistoryWalker.assertChainIntegrity(fm, 'f1');
      HistoryWalker.assertChainIntegrity(fm, 'f2');
      HistoryWalker.assertChainIntegrity(fm, 'f3');
      IntegrityChecker.assertValid(fm);
    });

    it('H10: phantom with groupID merges content into existing frame', () => {
      let fm = new FrameManager();

      // Create a normal frame f1
      fm.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      // Send a phantom with groupID=f1.id — this should merge content into f1
      fm.merge([
        { id: 'phantom-1', type: 'message', phantom: true, groupID: 'f1', content: { extra: 'data' } },
      ]);

      let f1 = fm.getHead('f1');
      assert.equal(f1.content.text, 'hello', 'Original content preserved');
      assert.equal(f1.content.extra, 'data', 'Phantom content merged in');
      assert.equal(f1.id, 'f1', 'Frame keeps its original id');

      IntegrityChecker.assertValid(fm);
    });

    it('H11: frame with nonexistent parentID is stored (orphan)', () => {
      let fm = new FrameManager();

      fm.merge([
        { id: 'orphan-1', type: 'message', parentID: 'nonexistent', content: { text: 'lost' } },
      ]);

      // Frame should be stored even though parent doesn't exist
      let orphan = fm.get('orphan-1');
      assert.ok(orphan, 'Orphan frame should be stored');
      assert.equal(orphan.parentID, 'nonexistent');
      assert.equal(orphan.content.text, 'lost');

      // IntegrityChecker will correctly flag the orphan parent reference.
      // Verify it reports the specific error.
      let result = IntegrityChecker.check(fm);
      assert.equal(result.valid, false, 'IntegrityChecker should flag orphan parentID');
      assert.ok(
        result.errors.some(e => e.includes('nonexistent') && e.includes('does not exist')),
        'Error should mention the nonexistent parent',
      );
    });

    it('H12: conflicting phantom groupType is skipped', () => {
      let fm = new FrameManager();

      // First phantom creates the group frame with type 'message'
      fm.merge([
        { id: 'p1', type: 'phantom', phantom: true, groupID: 'g1', groupType: 'message', content: { text: 'first' } },
      ]);

      let g1 = fm.getHead('g1');
      assert.equal(g1.type, 'message');

      // Second phantom with conflicting groupType should be skipped
      fm.merge([
        { id: 'p2', type: 'phantom', phantom: true, groupID: 'g1', groupType: 'reflection', content: { text: 'second' } },
      ]);

      let g1After = fm.getHead('g1');
      assert.equal(g1After.type, 'message', 'Group frame should keep type "message"');
      assert.equal(g1After.content.text, 'first', 'Content should not be updated from skipped phantom');

      IntegrityChecker.assertValid(fm);
    });
  });

  // ─── Content Attacks (H13-H16) ─────────────────────────────────────────────

  describe('Content Attacks', () => {
    it('H13: deeply nested content (50 levels) does not cause stack overflow', () => {
      let fm = new FrameManager();

      fm.merge([
        { id: 'f1', type: 'message', content: {} },
      ]);

      // Build 50 levels of nesting
      let nested = {};
      let cursor = nested;
      for (let i = 0; i < 50; i++) {
        cursor.level = {};
        cursor = cursor.level;
      }
      cursor.deep = 'bottom';

      fm.merge([
        { id: 'atk-13', type: 'merge', targets: ['f1'], content: nested },
      ]);

      // Verify the merge completed and the deep value is reachable
      let f1 = fm.getHead('f1');
      let walk = f1.content;
      for (let i = 0; i < 50; i++) {
        assert.ok(walk.level, `Nesting level ${i} should exist`);
        walk = walk.level;
      }
      assert.equal(walk.deep, 'bottom', 'Bottom of nesting should be reachable');

      IntegrityChecker.assertValid(fm);
    });

    it('H14: content with 1000 keys merges without issue', () => {
      let fm = new FrameManager();

      fm.merge([
        { id: 'f1', type: 'message', content: { existing: 'value' } },
      ]);

      // Build content with 1000 keys
      let bigContent = {};
      for (let i = 0; i < 1000; i++) {
        bigContent[`key_${i}`] = `value_${i}`;
      }

      fm.merge([
        { id: 'atk-14', type: 'merge', targets: ['f1'], content: bigContent },
      ]);

      let f1 = fm.getHead('f1');
      assert.equal(f1.content.existing, 'value', 'Original content preserved');
      assert.equal(f1.content.key_0, 'value_0', 'First new key present');
      assert.equal(f1.content.key_999, 'value_999', 'Last new key present');
      assert.equal(Object.keys(f1.content).length, 1001, 'Should have 1001 keys total');

      IntegrityChecker.assertValid(fm);
    });

    it('H15: prototype pollution is blocked', () => {
      let fm = new FrameManager();

      fm.merge([
        { id: 'f1', type: 'message', content: { safe: true } },
      ]);

      // Attack 1: __proto__ pollution
      fm.merge([
        { id: 'atk-15a', type: 'merge', targets: ['f1'], content: { '__proto__': { polluted: true } } },
      ]);

      assert.equal(({}).polluted, undefined, '__proto__ pollution must not leak to Object.prototype');

      let f1 = fm.getHead('f1');
      assert.equal(f1.content.safe, true, 'Original content preserved');
      assert.equal(f1.content.polluted, undefined, 'Polluted key should not exist on content');

      // Attack 2: constructor.prototype pollution
      fm.merge([
        { id: 'atk-15b', type: 'merge', targets: ['f1'], content: { constructor: { prototype: { polluted: true } } } },
      ]);

      assert.equal(({}).polluted, undefined, 'constructor.prototype pollution must not leak');

      // The 'constructor' key is blocked by deepMerge, so it should not be an own-property
      let f1After = fm.getHead('f1');
      assert.equal(
        Object.prototype.hasOwnProperty.call(f1After.content, 'constructor'),
        false,
        'constructor should not be an own-property of content',
      );

      IntegrityChecker.assertValid(fm);
    });

    it('H16: non-plain objects (Date, RegExp) are stored as atomic values', () => {
      let fm = new FrameManager();

      fm.merge([
        { id: 'f1', type: 'message', content: { text: 'hello' } },
      ]);

      let testDate  = new Date('2025-01-01T00:00:00Z');
      let testRegex = /test/gi;

      fm.merge([
        { id: 'atk-16', type: 'merge', targets: ['f1'], content: { date: testDate, regex: testRegex } },
      ]);

      let f1 = fm.getHead('f1');

      // Date and RegExp are not plain objects, so deepMerge treats them as atomic (Rule 4)
      assert.ok(f1.content.date instanceof Date, 'Date should be stored as-is');
      assert.ok(f1.content.regex instanceof RegExp, 'RegExp should be stored as-is');
      assert.equal(f1.content.text, 'hello', 'Original content preserved');

      IntegrityChecker.assertValid(fm);
    });
  });

  // ─── Merge Invariant Attacks (H17-H22) ─────────────────────────────────────

  describe('Merge Invariant Attacks', () => {
    it('H17: frame with no id is silently skipped', () => {
      let fm = new FrameManager();

      let events = [];
      fm.on('frame:added', (e) => events.push(e));

      fm.merge([
        { type: 'message', content: { text: 'no id' } },
      ]);

      assert.equal(events.length, 0, 'No events should fire for id-less frame');
      assert.equal(fm.toArray().length, 0, 'No frames should be stored');

      IntegrityChecker.assertValid(fm);
    });

    it('H18: frame with no type is silently skipped', () => {
      let fm = new FrameManager();

      let events = [];
      fm.on('frame:added', (e) => events.push(e));

      fm.merge([
        { id: 'f1', content: { text: 'no type' } },
      ]);

      assert.equal(events.length, 0, 'No events should fire for type-less frame');
      assert.equal(fm.toArray().length, 0, 'No frames should be stored');

      IntegrityChecker.assertValid(fm);
    });

    it('H19: merge with non-array argument throws TypeError', () => {
      let fm = new FrameManager();

      assert.throws(() => fm.merge({ id: 'f1', type: 'message' }), TypeError);
      assert.throws(() => fm.merge(null), TypeError);
      assert.throws(() => fm.merge('string'), TypeError);
      assert.throws(() => fm.merge(42), TypeError);

      IntegrityChecker.assertValid(fm);
    });

    it('H20: merge with empty array is a no-op', () => {
      let fm = new FrameManager();

      let events = [];
      fm.on('frame:added', (e) => events.push(e));
      fm.on('frame:updated', (e) => events.push(e));

      let result = fm.merge([]);

      assert.deepEqual(result, [], 'Should return empty array');
      assert.equal(events.length, 0, 'No events should fire');
      assert.equal(fm.toArray().length, 0, 'No frames should exist');

      IntegrityChecker.assertValid(fm);
    });

    it('H21: 100 sequential merges targeting same frame produce correct chain', () => {
      let fm = new FrameManager();

      fm.merge([
        { id: 'f1', type: 'message', content: { count: 0 } },
      ]);

      for (let i = 1; i <= 100; i++) {
        fm.merge([
          { id: `atk-21-${i}`, type: 'merge', targets: ['f1'], content: { count: i } },
        ]);
      }

      let f1 = fm.getHead('f1');
      assert.equal(f1.content.count, 100, 'HEAD should have the last merge content');

      // Chain: 1 original + 100 merges = 101 versions
      HistoryWalker.assertChainLength(fm, 'f1', 101);
      HistoryWalker.assertChainIntegrity(fm, 'f1');

      IntegrityChecker.assertValid(fm);
    });

    it('H22: second merge with same id overwrites (last-write-wins)', () => {
      let fm = new FrameManager();

      // First merge: live frame
      fm.merge([
        { id: 'f1', type: 'message', content: { text: 'live' } },
      ]);

      assert.equal(fm.getHead('f1').content.text, 'live');

      // Second merge: bulk load with same id but different content
      fm.merge([
        { id: 'f1', type: 'message', content: { text: 'historical' } },
      ], { events: false });

      let f1 = fm.getHead('f1');
      assert.equal(f1.content.text, 'historical', 'Last write should win');

      IntegrityChecker.assertValid(fm);
    });
  });
});
