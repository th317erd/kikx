'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FrameManager } from '../frame-manager/frame-manager.mjs';
import { Frame } from '../frame-manager/frame.mjs';

describe('Live Frames (Phantom Handling)', () => {
  describe('phantom with groupID — first phantom creates group frame', () => {
    it('should create a group frame from the first phantom', () => {
      let manager = new FrameManager();
      let results = manager.merge([
        { id: 'p1', type: 'token', phantom: true, groupID: 'g1', groupType: 'assistant-message', content: { text: 'He' } },
      ]);

      assert.equal(results.length, 1);
      assert.equal(results[0].id, 'g1');
    });

    it('should set correct properties on the group frame', () => {
      let manager = new FrameManager();
      let results = manager.merge([
        { id: 'p1', type: 'token', phantom: true, groupID: 'g1', groupType: 'assistant-message', content: { text: 'He' }, parentID: 'session-1' },
      ]);

      let group = results[0];
      assert.equal(group.id, 'g1');
      assert.equal(group.type, 'assistant-message');
      assert.deepEqual(group.content, { text: 'He' });
      assert.equal(group.phantom, false, 'group frame should NOT be phantom');
      assert.equal(group.hidden, true, 'group frame should default to hidden');
      assert.equal(group.deleted, false, 'group frame should default to not deleted');
      assert.equal(group.parentID, 'session-1');
      assert.ok(group instanceof Frame);
    });

    it('should store the group frame and make it retrievable by groupID', () => {
      let manager = new FrameManager();
      manager.merge([
        { id: 'p1', type: 'token', phantom: true, groupID: 'g1', groupType: 'assistant-message', content: { text: 'He' } },
      ]);

      let stored = manager.get('g1');
      assert.ok(stored, 'group frame should be stored');
      assert.equal(stored.id, 'g1');
      assert.equal(stored.type, 'assistant-message');
    });

    it('should NOT store the phantom frame itself', () => {
      let manager = new FrameManager();
      manager.merge([
        { id: 'p1', type: 'token', phantom: true, groupID: 'g1', groupType: 'assistant-message', content: { text: 'He' } },
      ]);

      let phantom = manager.get('p1');
      assert.equal(phantom, undefined, 'phantom frame itself must not be stored');
    });

    it('should emit frame:added for the group frame on first phantom', () => {
      let manager  = new FrameManager();
      let captured = null;

      manager.on('frame:added', (payload) => { captured = payload; });
      manager.merge([
        { id: 'p1', type: 'token', phantom: true, groupID: 'g1', groupType: 'assistant-message', content: { text: 'He' } },
      ]);

      assert.ok(captured, 'frame:added should fire');
      assert.equal(captured.frame.id, 'g1');
    });

    it('should emit frame:added:{groupID} on first phantom', () => {
      let manager  = new FrameManager();
      let captured = null;

      manager.on('frame:added:g1', (payload) => { captured = payload; });
      manager.merge([
        { id: 'p1', type: 'token', phantom: true, groupID: 'g1', groupType: 'assistant-message', content: { text: 'He' } },
      ]);

      assert.ok(captured, 'frame:added:g1 should fire');
      assert.equal(captured.frame.id, 'g1');
    });

    it('should use phantom type as fallback when groupType is not set', () => {
      let manager = new FrameManager();
      let results = manager.merge([
        { id: 'p1', type: 'token', phantom: true, groupID: 'g1', content: { text: 'He' } },
      ]);

      assert.equal(results[0].type, 'token');
    });
  });

  describe('phantom with groupID — subsequent phantoms merge into group', () => {
    it('should deep-merge content from second phantom into group frame', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'p1', type: 'token', phantom: true, groupID: 'g1', groupType: 'assistant-message', content: { text: 'He' } },
      ]);

      let results = manager.merge([
        { id: 'p2', type: 'token', phantom: true, groupID: 'g1', groupType: 'assistant-message', content: { text: 'Hello' } },
      ]);

      assert.equal(results.length, 1);
      assert.equal(results[0].id, 'g1');
      assert.deepEqual(results[0].content, { text: 'Hello' });
    });

    it('should accumulate content across three phantoms', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'p1', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: { tokens: ['a'] } },
      ]);

      manager.merge([
        { id: 'p2', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: { tokens: ['b'], count: 2 } },
      ]);

      let results = manager.merge([
        { id: 'p3', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: { tokens: ['c'], status: 'done' } },
      ]);

      let group = results[0];
      assert.equal(group.id, 'g1');
      // Arrays replace entirely in deepMerge
      assert.deepEqual(group.content.tokens, ['c']);
      assert.equal(group.content.status, 'done');
    });

    it('should emit frame:updated on subsequent phantoms', () => {
      let manager  = new FrameManager();
      let captured = null;

      manager.merge([
        { id: 'p1', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: { text: 'He' } },
      ]);

      manager.on('frame:updated', (payload) => { captured = payload; });
      manager.merge([
        { id: 'p2', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: { text: 'Hello' } },
      ]);

      assert.ok(captured, 'frame:updated should fire');
      assert.equal(captured.frame.id, 'g1');
      assert.ok(captured.previousHead, 'should include previousHead');
    });

    it('should emit frame:updated:{groupID} on subsequent phantoms', () => {
      let manager  = new FrameManager();
      let captured = null;

      manager.merge([
        { id: 'p1', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: { text: 'He' } },
      ]);

      manager.on('frame:updated:g1', (payload) => { captured = payload; });
      manager.merge([
        { id: 'p2', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: { text: 'Hello' } },
      ]);

      assert.ok(captured, 'frame:updated:g1 should fire');
      assert.equal(captured.frame.id, 'g1');
    });

    it('should NOT emit frame:added on subsequent phantoms', () => {
      let manager = new FrameManager();
      let count   = 0;

      manager.on('frame:added', () => { count++; });

      manager.merge([
        { id: 'p1', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: { text: 'He' } },
      ]);

      assert.equal(count, 1, 'frame:added fires once for group creation');

      manager.merge([
        { id: 'p2', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: { text: 'Hello' } },
      ]);

      assert.equal(count, 1, 'frame:added should NOT fire again on update');
    });

    it('should update stored group frame after merge', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'p1', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: { text: 'He' } },
      ]);

      manager.merge([
        { id: 'p2', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: { text: 'Hello' } },
      ]);

      let stored = manager.get('g1');
      assert.deepEqual(stored.content, { text: 'Hello' });
    });
  });

  describe('phantom without groupID — standalone ephemeral', () => {
    it('should NOT store standalone phantom', () => {
      let manager = new FrameManager();
      manager.merge([
        { id: 'typing-1', type: 'typing-indicator', phantom: true, content: { active: true } },
      ]);

      let stored = manager.get('typing-1');
      assert.equal(stored, undefined, 'standalone phantom must not be stored');
    });

    it('should NOT add to results', () => {
      let manager = new FrameManager();
      let results = manager.merge([
        { id: 'typing-1', type: 'typing-indicator', phantom: true, content: { active: true } },
      ]);

      assert.equal(results.length, 0);
    });

    it('should emit frame:phantom event', () => {
      let manager  = new FrameManager();
      let captured = null;

      manager.on('frame:phantom', (payload) => { captured = payload; });
      manager.merge([
        { id: 'typing-1', type: 'typing-indicator', phantom: true, content: { active: true } },
      ]);

      assert.ok(captured, 'frame:phantom should fire');
      assert.equal(captured.frame.id, 'typing-1');
      assert.equal(captured.frame.phantom, true);
    });

    it('should emit frame:phantom:{id} event', () => {
      let manager  = new FrameManager();
      let captured = null;

      manager.on('frame:phantom:typing-1', (payload) => { captured = payload; });
      manager.merge([
        { id: 'typing-1', type: 'typing-indicator', phantom: true, content: { active: true } },
      ]);

      assert.ok(captured, 'frame:phantom:typing-1 should fire');
      assert.equal(captured.frame.id, 'typing-1');
    });

    it('should NOT emit frame:added for standalone phantom', () => {
      let manager = new FrameManager();
      let fired   = false;

      manager.on('frame:added', () => { fired = true; });
      manager.merge([
        { id: 'typing-1', type: 'typing-indicator', phantom: true, content: { active: true } },
      ]);

      assert.equal(fired, false);
    });
  });

  describe('groupType conflict', () => {
    it('should skip phantom when groupType conflicts with existing group type', () => {
      let manager = new FrameManager();

      // First phantom creates group with type 'assistant-message'
      manager.merge([
        { id: 'p1', type: 'token', phantom: true, groupID: 'g1', groupType: 'assistant-message', content: { text: 'He' } },
      ]);

      // Second phantom has conflicting groupType
      let results = manager.merge([
        { id: 'p2', type: 'token', phantom: true, groupID: 'g1', groupType: 'system-message', content: { text: 'conflict' } },
      ]);

      assert.equal(results.length, 0, 'conflicting phantom should be skipped');

      // Group frame should be unchanged
      let stored = manager.get('g1');
      assert.deepEqual(stored.content, { text: 'He' });
      assert.equal(stored.type, 'assistant-message');
    });

    it('should not emit any events for conflicting phantom', () => {
      let manager = new FrameManager();
      let events  = [];

      manager.merge([
        { id: 'p1', type: 'token', phantom: true, groupID: 'g1', groupType: 'assistant-message', content: { text: 'He' } },
      ]);

      manager.on('frame:updated', () => { events.push('updated'); });
      manager.on('frame:added', () => { events.push('added'); });

      manager.merge([
        { id: 'p2', type: 'token', phantom: true, groupID: 'g1', groupType: 'system-message', content: { text: 'bad' } },
      ]);

      assert.deepEqual(events, []);
    });
  });

  describe('group frame parentID', () => {
    it('should inherit parentID from the first phantom', () => {
      let manager = new FrameManager();
      manager.merge([
        { id: 'p1', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: {}, parentID: 'session-42' },
      ]);

      let group = manager.get('g1');
      assert.equal(group.parentID, 'session-42');
    });

    it('should index group frame as child of parentID', () => {
      let manager = new FrameManager();

      // Create parent first
      manager.merge([
        { id: 'session-42', type: 'session' },
      ]);

      manager.merge([
        { id: 'p1', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: {}, parentID: 'session-42' },
      ]);

      let children = manager.getChildren('session-42');
      let groupChild = children.find((c) => c.id === 'g1');
      assert.ok(groupChild, 'group frame should be a child of parentID');
    });
  });

  describe('events suppressed (options.events === false)', () => {
    it('should NOT emit frame:added when events suppressed on first phantom', () => {
      let manager = new FrameManager();
      let fired   = false;

      manager.on('frame:added', () => { fired = true; });
      manager.merge([
        { id: 'p1', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: { text: 'He' } },
      ], { events: false });

      assert.equal(fired, false);
    });

    it('should NOT emit frame:updated when events suppressed on subsequent phantom', () => {
      let manager = new FrameManager();

      manager.merge([
        { id: 'p1', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: { text: 'He' } },
      ]);

      let fired = false;
      manager.on('frame:updated', () => { fired = true; });

      manager.merge([
        { id: 'p2', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: { text: 'Hello' } },
      ], { events: false });

      assert.equal(fired, false);
    });

    it('should NOT emit frame:phantom when events suppressed for standalone phantom', () => {
      let manager = new FrameManager();
      let fired   = false;

      manager.on('frame:phantom', () => { fired = true; });
      manager.merge([
        { id: 'typing-1', type: 'typing-indicator', phantom: true, content: { active: true } },
      ], { events: false });

      assert.equal(fired, false);
    });

    it('should still include group frame in bulk-loaded count', () => {
      let manager  = new FrameManager();
      let captured = null;

      manager.on('frames:bulk-loaded', (payload) => { captured = payload; });
      manager.merge([
        { id: 'p1', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: { text: 'He' } },
      ], { events: false });

      assert.ok(captured);
      assert.equal(captured.count, 1, 'group frame should count in bulk-loaded');
    });
  });

  describe('version history with phantom merges (history: true)', () => {
    it('should track merge progression in version history', () => {
      let manager = new FrameManager({ history: true });

      manager.merge([
        { id: 'p1', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: { text: 'H' } },
      ]);

      manager.merge([
        { id: 'p2', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: { text: 'He' } },
      ]);

      manager.merge([
        { id: 'p3', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: { text: 'Hel' } },
      ]);

      let history = manager.getVersionHistory('g1');
      assert.equal(history.length, 3, 'should have 3 versions');
      assert.deepEqual(history[0].content, { text: 'H' });
      assert.deepEqual(history[1].content, { text: 'He' });
      assert.deepEqual(history[2].content, { text: 'Hel' });
    });

    it('should return latest version from getHead after merges', () => {
      let manager = new FrameManager({ history: true });

      manager.merge([
        { id: 'p1', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: { text: 'H' } },
      ]);

      manager.merge([
        { id: 'p2', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: { text: 'Hello' } },
      ]);

      let head = manager.getHead('g1');
      assert.deepEqual(head.content, { text: 'Hello' });
    });
  });

  describe('version history with phantom merges (history: false)', () => {
    it('should update group frame in-place when history is false', () => {
      let manager = new FrameManager({ history: false });

      manager.merge([
        { id: 'p1', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: { text: 'H' } },
      ]);

      manager.merge([
        { id: 'p2', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: { text: 'Hello' } },
      ]);

      let head = manager.getHead('g1');
      assert.deepEqual(head.content, { text: 'Hello' });

      let history = manager.getVersionHistory('g1');
      assert.equal(history.length, 1, 'no history chain when history:false');
    });
  });

  describe('interleaved phantoms from different groups', () => {
    it('should maintain independent groups when phantoms interleave', () => {
      let manager = new FrameManager();

      // Interleave phantoms from two different groups
      manager.merge([
        { id: 'pA1', type: 'token', phantom: true, groupID: 'gA', groupType: 'msg', content: { text: 'Alpha' } },
      ]);

      manager.merge([
        { id: 'pB1', type: 'token', phantom: true, groupID: 'gB', groupType: 'msg', content: { text: 'Beta' } },
      ]);

      manager.merge([
        { id: 'pA2', type: 'token', phantom: true, groupID: 'gA', groupType: 'msg', content: { text: 'Alpha updated' } },
      ]);

      manager.merge([
        { id: 'pB2', type: 'token', phantom: true, groupID: 'gB', groupType: 'msg', content: { text: 'Beta updated' } },
      ]);

      let groupA = manager.getHead('gA');
      let groupB = manager.getHead('gB');

      assert.deepEqual(groupA.content, { text: 'Alpha updated' });
      assert.deepEqual(groupB.content, { text: 'Beta updated' });
    });

    it('should track independent version histories', () => {
      let manager = new FrameManager({ history: true });

      manager.merge([
        { id: 'pA1', type: 'token', phantom: true, groupID: 'gA', groupType: 'msg', content: { v: 1 } },
      ]);

      manager.merge([
        { id: 'pB1', type: 'token', phantom: true, groupID: 'gB', groupType: 'msg', content: { v: 10 } },
      ]);

      manager.merge([
        { id: 'pA2', type: 'token', phantom: true, groupID: 'gA', groupType: 'msg', content: { v: 2 } },
      ]);

      let historyA = manager.getVersionHistory('gA');
      let historyB = manager.getVersionHistory('gB');

      assert.equal(historyA.length, 2);
      assert.equal(historyB.length, 1);
      assert.deepEqual(historyA[0].content, { v: 1 });
      assert.deepEqual(historyA[1].content, { v: 2 });
      assert.deepEqual(historyB[0].content, { v: 10 });
    });

    it('should emit correct events for each group independently', () => {
      let manager = new FrameManager();
      let addedIds   = [];
      let updatedIds = [];

      manager.on('frame:added', (p) => { addedIds.push(p.frame.id); });
      manager.on('frame:updated', (p) => { updatedIds.push(p.frame.id); });

      manager.merge([
        { id: 'pA1', type: 'token', phantom: true, groupID: 'gA', groupType: 'msg', content: { text: 'a' } },
      ]);

      manager.merge([
        { id: 'pB1', type: 'token', phantom: true, groupID: 'gB', groupType: 'msg', content: { text: 'b' } },
      ]);

      manager.merge([
        { id: 'pA2', type: 'token', phantom: true, groupID: 'gA', groupType: 'msg', content: { text: 'a2' } },
      ]);

      assert.deepEqual(addedIds, ['gA', 'gB']);
      assert.deepEqual(updatedIds, ['gA']);
    });
  });

  describe('mixed phantom and normal frames', () => {
    it('should handle normal and phantom frames in the same merge call', () => {
      let manager = new FrameManager();
      let results = manager.merge([
        { id: 'normal-1', type: 'message', content: { text: 'hello' } },
        { id: 'p1', type: 'token', phantom: true, groupID: 'g1', groupType: 'msg', content: { text: 'He' } },
        { id: 'normal-2', type: 'message', content: { text: 'world' } },
      ]);

      assert.equal(results.length, 3);
      assert.equal(results[0].id, 'normal-1');
      assert.equal(results[1].id, 'g1', 'phantom should produce group frame in results');
      assert.equal(results[2].id, 'normal-2');

      // Normal frames stored
      assert.ok(manager.get('normal-1'));
      assert.ok(manager.get('normal-2'));
      // Group frame stored
      assert.ok(manager.get('g1'));
      // Phantom not stored
      assert.equal(manager.get('p1'), undefined);
    });
  });
});
