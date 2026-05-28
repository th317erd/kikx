'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FrameManager } from '../frame-manager/frame-manager.mjs';
import { EventRecorder } from './test-utils/event-recorder.mjs';
import { HistoryWalker } from './test-utils/history-walker.mjs';
import { IntegrityChecker } from './test-utils/integrity-checker.mjs';

// ── Helpers ──

function shuffle(array) {
  let arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function phantom(id, groupID, groupType, parentID, content) {
  return {
    id,
    type:    'token',
    phantom: true,
    groupID,
    groupType,
    parentID,
    content,
  };
}

// ── S1: Basic two-user conversation ──

describe('S1: Basic two-user conversation', () => {
  it('should handle a full Alice-Agent-Alice-Agent exchange', () => {
    let fm = new FrameManager({ history: true });
    let er = new EventRecorder();
    er.attach(fm);

    // Alice sends first interaction
    fm.merge([
      { id: 'alice-1', type: 'interaction', parentID: null, content: { text: 'Hello agent' } },
    ]);

    // Agent streams response: 5 phantoms with same groupID
    let agentGroup1 = 'agent-resp-1';
    for (let i = 1; i <= 5; i++) {
      fm.merge([
        phantom(`p1-${i}`, agentGroup1, 'message', 'alice-1', { text: `chunk-${i}` }),
      ]);
    }

    // Alice sends follow-up interaction
    fm.merge([
      { id: 'alice-2', type: 'interaction', parentID: null, content: { text: 'Tell me more' } },
    ]);

    // Agent streams again: 3 phantoms, different groupID
    let agentGroup2 = 'agent-resp-2';
    for (let i = 1; i <= 3; i++) {
      fm.merge([
        phantom(`p2-${i}`, agentGroup2, 'message', 'alice-2', { text: `more-chunk-${i}` }),
      ]);
    }

    // ── Verify order ──
    let all = fm.toArray();
    let ids = all.map((f) => f.id);
    assert.deepEqual(ids, ['alice-1', agentGroup1, 'alice-2', agentGroup2]);

    // ── Verify parent-child intact ──
    let childrenOfAlice1 = fm.getChildren('alice-1');
    assert.equal(childrenOfAlice1.length, 1);
    assert.equal(childrenOfAlice1[0].id, agentGroup1);

    let childrenOfAlice2 = fm.getChildren('alice-2');
    assert.equal(childrenOfAlice2.length, 1);
    assert.equal(childrenOfAlice2[0].id, agentGroup2);

    // ── Verify group frames contain merged content ──
    let group1Head = fm.getHead(agentGroup1);
    assert.deepEqual(group1Head.content, { text: 'chunk-5' });

    let group2Head = fm.getHead(agentGroup2);
    assert.deepEqual(group2Head.content, { text: 'more-chunk-3' });

    // ── Verify no phantoms stored ──
    for (let i = 1; i <= 5; i++)
      assert.equal(fm.get(`p1-${i}`), undefined, `phantom p1-${i} must not be stored`);
    for (let i = 1; i <= 3; i++)
      assert.equal(fm.get(`p2-${i}`), undefined, `phantom p2-${i} must not be stored`);

    // ── Verify events fired correctly ──
    // Two interactions => 2 frame:added
    er.assertCount('frame:added', 4); // 2 interactions + 2 group creations
    er.assertFiredWith('frame:added', (p) => p.frame.id === 'alice-1');
    er.assertFiredWith('frame:added', (p) => p.frame.id === agentGroup1);
    er.assertFiredWith('frame:added', (p) => p.frame.id === 'alice-2');
    er.assertFiredWith('frame:added', (p) => p.frame.id === agentGroup2);

    // Subsequent phantoms fire frame:updated (4 for group1, 2 for group2)
    let updatedEvents = er.getEvents('frame:updated').filter((e) => e.name === 'frame:updated');
    assert.equal(updatedEvents.length, 6);

    // ── Verify version history ──
    // Group1 had 5 phantoms => 5 versions (1 creation + 4 updates)
    HistoryWalker.assertChainLength(fm, agentGroup1, 5);
    HistoryWalker.assertChainIntegrity(fm, agentGroup1);

    // Group2 had 3 phantoms => 3 versions
    HistoryWalker.assertChainLength(fm, agentGroup2, 3);
    HistoryWalker.assertChainIntegrity(fm, agentGroup2);

    // ── Integrity ──
    er.detach();
    IntegrityChecker.assertValid(fm);
  });
});

// ── S2: Multi-agent concurrent streaming ──

describe('S2: Multi-agent concurrent streaming', () => {
  it('should keep interleaved agent streams independent', () => {
    let fm = new FrameManager({ history: true });
    let er = new EventRecorder();
    er.attach(fm);

    // Alice sends interaction
    fm.merge([
      { id: 'alice-msg', type: 'interaction', parentID: null, content: { text: 'Question' } },
    ]);

    // Agent-1 starts streaming (groupID: 'g1', groupType: 'reflection')
    fm.merge([phantom('a1-p1', 'g1', 'reflection', 'alice-msg', { text: 'thinking-1' })]);

    // Agent-2 starts streaming (groupID: 'g2', groupType: 'message')
    fm.merge([phantom('a2-p1', 'g2', 'message', 'alice-msg', { text: 'response-1' })]);

    // Interleave: agent1, agent2, agent1, agent2, agent1
    fm.merge([phantom('a1-p2', 'g1', 'reflection', 'alice-msg', { text: 'thinking-2' })]);
    fm.merge([phantom('a2-p2', 'g2', 'message', 'alice-msg', { text: 'response-2' })]);
    fm.merge([phantom('a1-p3', 'g1', 'reflection', 'alice-msg', { text: 'thinking-3' })]);

    // ── Verify each group collapsed independently ──
    let g1Head = fm.getHead('g1');
    let g2Head = fm.getHead('g2');

    assert.equal(g1Head.type, 'reflection');
    assert.deepEqual(g1Head.content, { text: 'thinking-3' });

    assert.equal(g2Head.type, 'message');
    assert.deepEqual(g2Head.content, { text: 'response-2' });

    // ── No cross-contamination ──
    assert.notEqual(g1Head.content.text, g2Head.content.text);
    assert.equal(g1Head.id, 'g1');
    assert.equal(g2Head.id, 'g2');

    // ── Both are children of alice-msg ──
    let children = fm.getChildren('alice-msg');
    let childIds = children.map((c) => c.id).sort();
    assert.deepEqual(childIds, ['g1', 'g2']);

    // ── Version histories independent ──
    HistoryWalker.assertChainLength(fm, 'g1', 3);
    HistoryWalker.assertChainLength(fm, 'g2', 2);
    HistoryWalker.assertChainIntegrity(fm, 'g1');
    HistoryWalker.assertChainIntegrity(fm, 'g2');

    // ── No phantoms stored ──
    for (let id of ['a1-p1', 'a1-p2', 'a1-p3', 'a2-p1', 'a2-p2'])
      assert.equal(fm.get(id), undefined, `phantom ${id} must not be stored`);

    er.detach();
    IntegrityChecker.assertValid(fm);
  });
});

// ── S3: Permission flow ──

describe('S3: Permission flow', () => {
  it('should handle permission prompt creation, grant, and setProcessed', () => {
    let fm = new FrameManager({ history: true });
    let er = new EventRecorder();
    er.attach(fm);

    // Agent sends interaction with a permission-prompt child
    fm.merge([
      { id: 'agent-interaction', type: 'interaction', parentID: null, content: { text: 'I need to run a tool' } },
      { id: 'perm-prompt-1', type: 'permission-prompt', parentID: 'agent-interaction', content: { tool: 'bash', command: 'ls /', status: 'pending' } },
    ]);

    assert.ok(fm.get('perm-prompt-1'), 'permission prompt should be stored');
    assert.equal(fm.getChildren('agent-interaction').length, 1);

    // User sends a permission-grant targeting the prompt
    fm.merge([
      { id: 'perm-grant-1', type: 'permission-grant', targets: ['perm-prompt-1'], content: { status: 'granted', grantedBy: 'alice' } },
    ]);

    // Verify merge updated the prompt
    let promptHead = fm.getHead('perm-prompt-1');
    assert.equal(promptHead.content.status, 'granted');
    assert.equal(promptHead.content.grantedBy, 'alice');
    assert.equal(promptHead.content.tool, 'bash');     // original content preserved
    assert.equal(promptHead.content.command, 'ls /');   // original content preserved

    // frame:updated should have fired for the prompt
    er.assertFiredWith('frame:updated', (p) => p.frame.id === 'perm-prompt-1');

    // Server calls setProcessed
    fm.setProcessed('perm-prompt-1', 'fp-abc123');

    let processedPrompt = fm.getHead('perm-prompt-1');
    assert.equal(processedPrompt.processed, 'fp-abc123');
    assert.ok(processedPrompt.processedAt, 'processedAt should be set');

    // frame:processed should fire
    er.assertFired('frame:processed');
    er.assertFiredWith('frame:processed', (p) => p.frame.id === 'perm-prompt-1');

    // Version history: creation + grant merge = 2 versions, plus setProcessed updates head in place
    HistoryWalker.assertChainIntegrity(fm, 'perm-prompt-1');
    let history = HistoryWalker.walk(fm, 'perm-prompt-1');
    assert.ok(history.length >= 2, 'should have at least 2 versions in chain');

    er.detach();
    IntegrityChecker.assertValid(fm);
  });
});

// ── S4: HML prompt flow ──

describe('S4: HML prompt flow', () => {
  it('should handle HML prompt creation and user response', () => {
    let fm = new FrameManager({ history: true });
    let er = new EventRecorder();
    er.attach(fm);

    // Agent sends interaction with an HML prompt child
    fm.merge([
      { id: 'agent-int-2', type: 'interaction', parentID: null, content: { text: 'Need your input' } },
      {
        id:       'hml-prompt-1',
        type:     'hml-prompt',
        parentID: 'agent-int-2',
        content:  {
          fields: [
            { name: 'name', label: 'Your name', type: 'text' },
            { name: 'agree', label: 'Do you agree?', type: 'boolean' },
          ],
          status: 'pending',
        },
      },
    ]);

    assert.ok(fm.get('hml-prompt-1'));
    let promptChildren = fm.getChildren('agent-int-2');
    assert.equal(promptChildren.length, 1);
    assert.equal(promptChildren[0].id, 'hml-prompt-1');

    // User responds with hml-prompt-value targeting the prompt
    fm.merge([
      {
        id:      'hml-response-1',
        type:    'hml-prompt-value',
        targets: ['hml-prompt-1'],
        content: {
          values: { name: 'Alice', agree: true },
          status: 'answered',
        },
      },
    ]);

    // Verify the prompt was updated with user response
    let promptHead = fm.getHead('hml-prompt-1');
    assert.equal(promptHead.content.status, 'answered');
    assert.deepEqual(promptHead.content.values, { name: 'Alice', agree: true });
    // Original fields preserved
    assert.ok(Array.isArray(promptHead.content.fields));
    assert.equal(promptHead.content.fields.length, 2);

    // Events
    er.assertFiredWith('frame:updated', (p) => p.frame.id === 'hml-prompt-1');

    // Version history
    HistoryWalker.assertChainLength(fm, 'hml-prompt-1', 2);
    HistoryWalker.assertChainIntegrity(fm, 'hml-prompt-1');

    HistoryWalker.assertHeadContent(fm, 'hml-prompt-1', { status: 'answered' });

    er.detach();
    IntegrityChecker.assertValid(fm);
  });
});

// ── S5: Bulk load then live ──

describe('S5: Bulk load then live', () => {
  it('should transition from bulk to live with correct events and ordering', () => {
    let fm = new FrameManager({ history: true });
    let er = new EventRecorder();
    er.attach(fm);

    // Build 20 frames: 5 interactions each with 3 message children
    let bulkFrames = [];
    for (let i = 0; i < 5; i++) {
      bulkFrames.push({
        id:      `int-${i}`,
        type:    'interaction',
        parentID: null,
        content: { text: `interaction-${i}` },
      });
      for (let j = 0; j < 3; j++) {
        bulkFrames.push({
          id:       `msg-${i}-${j}`,
          type:     'message',
          parentID: `int-${i}`,
          content:  { text: `message-${i}-${j}` },
        });
      }
    }

    assert.equal(bulkFrames.length, 20);

    // Bulk load with events suppressed
    fm.merge(bulkFrames, { events: false });

    // Verify bulk-loaded event fired once
    er.assertCount('frames:bulk-loaded', 1);
    er.assertFiredWith('frames:bulk-loaded', (p) => p.count === 20);

    // No per-frame events during bulk
    let addedDuringBulk = er.events.filter(
      (e) => e.name === 'frame:added' && e.order < er.events.find((x) => x.name === 'frames:bulk-loaded').order,
    );
    assert.equal(addedDuringBulk.length, 0, 'No frame:added during bulk load');

    er.reset();

    // Live: user sends new interaction, agent streams response
    fm.merge([
      { id: 'live-int', type: 'interaction', parentID: null, content: { text: 'live question' } },
    ]);

    fm.merge([phantom('lp-1', 'live-resp', 'message', 'live-int', { text: 'live-1' })]);
    fm.merge([phantom('lp-2', 'live-resp', 'message', 'live-int', { text: 'live-2' })]);

    // Verify live events resume
    er.assertFired('frame:added');
    er.assertFiredWith('frame:added', (p) => p.frame.id === 'live-int');
    er.assertFiredWith('frame:added', (p) => p.frame.id === 'live-resp');
    er.assertFired('frame:updated');

    // Verify ordering correct across bulk/live boundary
    let all = fm.toArray();
    assert.equal(all.length, 22); // 20 bulk + 1 live interaction + 1 live group frame

    let allIds = all.map((f) => f.id);
    // Bulk frames come first
    assert.ok(allIds.indexOf('int-0') < allIds.indexOf('live-int'));
    assert.ok(allIds.indexOf('live-int') < allIds.indexOf('live-resp'));

    // Parent-child correct for live frames
    let liveChildren = fm.getChildren('live-int');
    assert.equal(liveChildren.length, 1);
    assert.equal(liveChildren[0].id, 'live-resp');

    er.detach();
    IntegrityChecker.assertValid(fm);
  });
});

// ── S5b: Randomized bulk load ──

describe('S5b: Randomized bulk load', () => {
  it('should produce identical final state from 3 random shuffles', () => {
    // Build 20 frames: 5 interactions each with 3 message children
    let baseFrames = [];
    for (let i = 0; i < 5; i++) {
      baseFrames.push({
        id:       `int-${i}`,
        type:     'interaction',
        parentID: null,
        content:  { text: `interaction-${i}` },
      });
      for (let j = 0; j < 3; j++) {
        baseFrames.push({
          id:       `msg-${i}-${j}`,
          type:     'message',
          parentID: `int-${i}`,
          content:  { text: `message-${i}-${j}` },
        });
      }
    }

    // Ordered baseline
    let orderedFm = new FrameManager({ history: true });
    orderedFm.merge([...baseFrames], { events: false });

    let expectedIds     = orderedFm.toArray().map((f) => f.id).sort();
    let expectedContent = {};
    for (let f of baseFrames)
      expectedContent[f.id] = f.content;

    // Run 3 shuffles
    for (let run = 0; run < 3; run++) {
      let shuffledFm = new FrameManager({ history: true });
      shuffledFm.merge(shuffle(baseFrames), { events: false });

      // Same frame IDs
      let actualIds = shuffledFm.toArray().map((f) => f.id).sort();
      assert.deepEqual(actualIds, expectedIds, `Run ${run}: frame IDs must match`);

      // Same content per frame
      for (let id of expectedIds) {
        let frame = shuffledFm.get(id);
        assert.ok(frame, `Run ${run}: frame ${id} must exist`);
        assert.deepEqual(frame.content, expectedContent[id], `Run ${run}: content for ${id} must match`);
      }

      // Same parent-child relationships
      for (let i = 0; i < 5; i++) {
        let children    = shuffledFm.getChildren(`int-${i}`);
        let childIds    = children.map((c) => c.id).sort();
        let expectedChi = [`msg-${i}-0`, `msg-${i}-1`, `msg-${i}-2`];
        assert.deepEqual(childIds, expectedChi, `Run ${run}: children of int-${i} must match`);
      }

      IntegrityChecker.assertValid(shuffledFm);
    }
  });
});

// ── S6: Late history backfill ──

describe('S6: Late history backfill', () => {
  it('should correctly backfill older frames after live interaction', () => {
    let fm = new FrameManager({ history: true });
    let er = new EventRecorder();
    er.attach(fm);

    // Load "recent page" frames (order 11-20, simulating page 2)
    let recentFrames = [];
    for (let i = 11; i <= 20; i++) {
      recentFrames.push({
        id:      `frame-${i}`,
        type:    'message',
        parentID: null,
        content: { text: `message-${i}`, originalOrder: i },
      });
    }
    fm.merge(recentFrames, { events: false });

    // User interacts live (gets order 21+)
    fm.merge([
      { id: 'live-msg', type: 'interaction', parentID: null, content: { text: 'live message' } },
    ]);

    // Load older page (order 1-10, backfill)
    let olderFrames = [];
    for (let i = 1; i <= 10; i++) {
      olderFrames.push({
        id:      `frame-${i}`,
        type:    'message',
        parentID: null,
        content: { text: `message-${i}`, originalOrder: i },
      });
    }
    fm.merge(olderFrames, { events: false });

    // Verify all 21 frames exist
    let all = fm.toArray();
    assert.equal(all.length, 21);

    // Verify each frame is retrievable
    for (let i = 1; i <= 20; i++) {
      let f = fm.get(`frame-${i}`);
      assert.ok(f, `frame-${i} should exist`);
      assert.equal(f.content.originalOrder, i);
    }
    assert.ok(fm.get('live-msg'));

    // The FrameManager assigns NEW order values, so backfilled frames get higher order
    // than "recent" frames. The final toArray is sorted by order (insertion order).
    // Recent (11-20) first, then live-msg, then backfill (1-10).
    let allIds = all.map((f) => f.id);
    // Recent page was loaded first
    for (let i = 11; i <= 20; i++)
      assert.ok(allIds.indexOf(`frame-${i}`) < allIds.indexOf('live-msg'), `frame-${i} should come before live-msg`);

    // Backfilled frames come after live-msg in order (they were inserted later)
    for (let i = 1; i <= 10; i++)
      assert.ok(allIds.indexOf(`frame-${i}`) > allIds.indexOf('live-msg'), `backfilled frame-${i} should come after live-msg`);

    er.detach();
    IntegrityChecker.assertValid(fm);
  });
});

// ── S7: Concurrent users ──

describe('S7: Concurrent users', () => {
  it('should handle overlapping Alice and Bob interactions without corruption', () => {
    let fm = new FrameManager({ history: true });
    let er = new EventRecorder();
    er.attach(fm);

    // Bob's agent is mid-stream when Alice sends
    fm.merge([
      { id: 'bob-int', type: 'interaction', parentID: null, content: { text: 'Bob asks' } },
    ]);
    fm.merge([phantom('bob-p1', 'bob-resp', 'message', 'bob-int', { text: 'bob-chunk-1' })]);

    // Alice sends interaction while Bob's agent is streaming
    fm.merge([
      { id: 'alice-int', type: 'interaction', parentID: null, content: { text: 'Alice asks' } },
    ]);

    // Bob's stream continues
    fm.merge([phantom('bob-p2', 'bob-resp', 'message', 'bob-int', { text: 'bob-chunk-2' })]);

    // Alice's agent starts streaming while Bob's is finishing
    fm.merge([phantom('alice-p1', 'alice-resp', 'message', 'alice-int', { text: 'alice-chunk-1' })]);

    // Bob sends another interaction while Alice's agent is mid-stream
    fm.merge([
      { id: 'bob-int-2', type: 'interaction', parentID: null, content: { text: 'Bob follows up' } },
    ]);

    // Alice's stream continues
    fm.merge([phantom('alice-p2', 'alice-resp', 'message', 'alice-int', { text: 'alice-chunk-2' })]);

    // Bob's agent finishes
    fm.merge([phantom('bob-p3', 'bob-resp', 'message', 'bob-int', { text: 'bob-final' })]);

    // ── Verify no corruption ──
    // Bob's first response
    let bobResp = fm.getHead('bob-resp');
    assert.equal(bobResp.parentID, 'bob-int');
    assert.deepEqual(bobResp.content, { text: 'bob-final' });

    // Alice's response
    let aliceResp = fm.getHead('alice-resp');
    assert.equal(aliceResp.parentID, 'alice-int');
    assert.deepEqual(aliceResp.content, { text: 'alice-chunk-2' });

    // Each participant's frames independent
    let bobChildren   = fm.getChildren('bob-int');
    let aliceChildren = fm.getChildren('alice-int');

    assert.equal(bobChildren.length, 1);
    assert.equal(bobChildren[0].id, 'bob-resp');

    assert.equal(aliceChildren.length, 1);
    assert.equal(aliceChildren[0].id, 'alice-resp');

    // bob-int-2 has no children yet
    assert.equal(fm.getChildren('bob-int-2').length, 0);

    // Version histories
    HistoryWalker.assertChainLength(fm, 'bob-resp', 3);
    HistoryWalker.assertChainLength(fm, 'alice-resp', 2);
    HistoryWalker.assertChainIntegrity(fm, 'bob-resp');
    HistoryWalker.assertChainIntegrity(fm, 'alice-resp');

    // All phantoms unstored
    for (let id of ['bob-p1', 'bob-p2', 'bob-p3', 'alice-p1', 'alice-p2'])
      assert.equal(fm.get(id), undefined);

    er.detach();
    IntegrityChecker.assertValid(fm);
  });
});

// ── S8: Multi-target merge ──

describe('S8: Multi-target merge', () => {
  it('should apply correction to multiple targets and then a single target independently', () => {
    let fm = new FrameManager({ history: true });
    let er = new EventRecorder();
    er.attach(fm);

    // Create 3 frames
    fm.merge([
      { id: 'F1', type: 'message', content: { text: 'frame-1', status: 'draft' } },
      { id: 'F2', type: 'message', content: { text: 'frame-2', status: 'draft' } },
      { id: 'F3', type: 'message', content: { text: 'frame-3', status: 'draft' } },
    ]);

    // Send correction targeting all three
    fm.merge([
      { id: 'correction-1', type: 'correction', targets: ['F1', 'F2', 'F3'], content: { status: 'reviewed' } },
    ]);

    // Verify all three updated
    for (let id of ['F1', 'F2', 'F3']) {
      let head = fm.getHead(id);
      assert.equal(head.content.status, 'reviewed', `${id} should be reviewed`);
      assert.ok(head.content.text, `${id} should retain original text`);
    }

    // Send another merge targeting only F1
    fm.merge([
      { id: 'correction-2', type: 'correction', targets: ['F1'], content: { status: 'approved', approvedBy: 'admin' } },
    ]);

    // F1 updated further
    let f1Head = fm.getHead('F1');
    assert.equal(f1Head.content.status, 'approved');
    assert.equal(f1Head.content.approvedBy, 'admin');
    assert.equal(f1Head.content.text, 'frame-1');

    // F2 and F3 unchanged from first correction
    let f2Head = fm.getHead('F2');
    let f3Head = fm.getHead('F3');
    assert.equal(f2Head.content.status, 'reviewed');
    assert.equal(f3Head.content.status, 'reviewed');
    assert.equal(f2Head.content.approvedBy, undefined);
    assert.equal(f3Head.content.approvedBy, undefined);

    // Independent FramePointer chains
    HistoryWalker.assertChainLength(fm, 'F1', 3); // original + correction1 + correction2
    HistoryWalker.assertChainLength(fm, 'F2', 2); // original + correction1
    HistoryWalker.assertChainLength(fm, 'F3', 2); // original + correction1

    HistoryWalker.assertChainIntegrity(fm, 'F1');
    HistoryWalker.assertChainIntegrity(fm, 'F2');
    HistoryWalker.assertChainIntegrity(fm, 'F3');

    // Diff verification on F1
    let diffF1 = HistoryWalker.diff(fm, 'F1', 0, 2);
    assert.deepEqual(diffF1.added, { approvedBy: 'admin' });
    assert.deepEqual(diffF1.changed.status, { from: 'draft', to: 'approved' });

    er.detach();
    IntegrityChecker.assertValid(fm);
  });
});

// ── S9: Deletion and visibility ──

describe('S9: Deletion and visibility', () => {
  it('should track hidden/deleted toggle progression in version history', () => {
    let fm = new FrameManager({ history: true });
    let er = new EventRecorder();
    er.attach(fm);

    // Create frames
    fm.merge([
      { id: 'vis-frame', type: 'message', content: { text: 'hello' } },
      { id: 'del-frame', type: 'message', content: { text: 'goodbye' } },
    ]);

    // Both start hidden:true (Frame default)
    assert.equal(fm.getHead('vis-frame').hidden, true);
    assert.equal(fm.getHead('del-frame').hidden, true);

    // Unhide vis-frame
    fm.merge([
      { id: 'unhide-1', type: 'update', targets: ['vis-frame'], hidden: false, content: {} },
    ]);
    assert.equal(fm.getHead('vis-frame').hidden, false);

    // Delete del-frame
    fm.merge([
      { id: 'delete-1', type: 'update', targets: ['del-frame'], deleted: true, content: {} },
    ]);
    assert.equal(fm.getHead('del-frame').deleted, true);

    // Un-delete del-frame
    fm.merge([
      { id: 'undelete-1', type: 'update', targets: ['del-frame'], deleted: false, content: {} },
    ]);
    assert.equal(fm.getHead('del-frame').deleted, false);

    // Version history shows toggle progression for del-frame
    let delHistory = HistoryWalker.walk(fm, 'del-frame');
    assert.equal(delHistory.length, 3); // original, deleted, un-deleted
    assert.equal(delHistory[0].deleted, false);  // original: default false
    assert.equal(delHistory[1].deleted, true);   // after delete
    assert.equal(delHistory[2].deleted, false);  // after un-delete

    // vis-frame history
    let visHistory = HistoryWalker.walk(fm, 'vis-frame');
    assert.equal(visHistory.length, 2); // original, unhidden
    assert.equal(visHistory[0].hidden, true);    // original: default hidden
    assert.equal(visHistory[1].hidden, false);   // after unhide

    HistoryWalker.assertChainIntegrity(fm, 'vis-frame');
    HistoryWalker.assertChainIntegrity(fm, 'del-frame');

    er.detach();
    IntegrityChecker.assertValid(fm);
  });
});

// ── S10: Standalone phantoms ──

describe('S10: Standalone phantoms', () => {
  it('should emit phantom events but never store standalone phantoms', () => {
    let fm = new FrameManager({ history: true });
    let er = new EventRecorder();
    er.attach(fm);

    // Send 2 standalone phantoms (typing indicators)
    fm.merge([
      { id: 'typing-1', type: 'typing-indicator', phantom: true, content: { active: true, user: 'alice' } },
    ]);
    fm.merge([
      { id: 'typing-2', type: 'typing-indicator', phantom: true, content: { active: true, user: 'bob' } },
    ]);

    // Then send a real message
    fm.merge([
      { id: 'real-msg', type: 'message', parentID: null, content: { text: 'Hello everyone' } },
    ]);

    // ── No phantoms stored ──
    assert.equal(fm.get('typing-1'), undefined, 'standalone phantom must not be stored');
    assert.equal(fm.get('typing-2'), undefined, 'standalone phantom must not be stored');

    // ── Real message stored ──
    assert.ok(fm.get('real-msg'), 'real message should be stored');

    // ── toArray only has real message ──
    let all = fm.toArray();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, 'real-msg');

    // ── frame:phantom events fired ──
    er.assertCount('frame:phantom', 2);
    er.assertFiredWith('frame:phantom', (p) => p.frame.id === 'typing-1');
    er.assertFiredWith('frame:phantom', (p) => p.frame.id === 'typing-2');

    // Namespaced events too
    er.assertFired('frame:phantom:typing-1');
    er.assertFired('frame:phantom:typing-2');

    // frame:added only for real message
    er.assertCount('frame:added', 1);
    er.assertFiredWith('frame:added', (p) => p.frame.id === 'real-msg');

    er.detach();
    IntegrityChecker.assertValid(fm);
  });
});

// ── S11: Full realistic conversation (BOSS FIGHT) ──

describe('S11: Full realistic conversation (BOSS FIGHT)', () => {
  it('should survive a complete multi-participant, multi-feature workflow', () => {
    let fm = new FrameManager({ history: true });
    let er = new EventRecorder();
    er.attach(fm);

    // ── Step 1: Bulk load 10 frames (randomized) ──
    let bulkFrames = [];
    for (let i = 0; i < 3; i++) {
      bulkFrames.push({
        id:       `bulk-int-${i}`,
        type:     'interaction',
        parentID: null,
        content:  { text: `bulk-interaction-${i}` },
      });
      // 2 children each, plus one extra for interaction-0
      let childCount = (i === 0) ? 3 : 2;
      for (let j = 0; j < childCount; j++) {
        bulkFrames.push({
          id:       `bulk-msg-${i}-${j}`,
          type:     'message',
          parentID: `bulk-int-${i}`,
          content:  { text: `bulk-message-${i}-${j}` },
        });
      }
    }
    assert.equal(bulkFrames.length, 10);

    let shuffledBulk = shuffle(bulkFrames);
    fm.merge(shuffledBulk, { events: false });

    er.assertCount('frames:bulk-loaded', 1);
    er.assertFiredWith('frames:bulk-loaded', (p) => p.count === 10);

    // Verify bulk integrity
    for (let f of bulkFrames)
      assert.ok(fm.get(f.id), `bulk frame ${f.id} should exist`);

    er.reset();

    // ── Step 2: Alice sends message ──
    fm.merge([
      { id: 'alice-msg-1', type: 'interaction', parentID: null, content: { text: 'Alice starts' } },
    ]);

    er.assertFiredWith('frame:added', (p) => p.frame.id === 'alice-msg-1');

    // ── Step 3: Agent-1 streams reflection (3 phantoms) ──
    for (let i = 1; i <= 3; i++) {
      fm.merge([phantom(`refl-p${i}`, 'reflection-1', 'reflection', 'alice-msg-1', { text: `reflect-${i}` })]);
    }

    let reflectionHead = fm.getHead('reflection-1');
    assert.equal(reflectionHead.type, 'reflection');
    assert.deepEqual(reflectionHead.content, { text: 'reflect-3' });

    // ── Step 4: Agent-1 streams message response (4 phantoms) ──
    for (let i = 1; i <= 4; i++) {
      fm.merge([phantom(`resp-p${i}`, 'agent1-response', 'message', 'alice-msg-1', { text: `response-${i}` })]);
    }

    let agent1Resp = fm.getHead('agent1-response');
    assert.equal(agent1Resp.type, 'message');
    assert.deepEqual(agent1Resp.content, { text: 'response-4' });

    // Both are children of alice-msg-1
    let aliceChildren = fm.getChildren('alice-msg-1');
    let aliceChildIds = aliceChildren.map((c) => c.id).sort();
    assert.deepEqual(aliceChildIds, ['agent1-response', 'reflection-1']);

    // ── Step 5: Agent sends HML prompt ──
    fm.merge([
      {
        id:       'hml-prompt',
        type:     'hml-prompt',
        parentID: 'alice-msg-1',
        content:  {
          fields: [{ name: 'confirm', label: 'Confirm action?', type: 'boolean' }],
          status: 'pending',
        },
      },
    ]);

    assert.ok(fm.get('hml-prompt'));

    // ── Step 6: Alice responds to HML prompt ──
    fm.merge([
      {
        id:      'hml-answer',
        type:    'hml-prompt-value',
        targets: ['hml-prompt'],
        content: { values: { confirm: true }, status: 'answered' },
      },
    ]);

    let hmlHead = fm.getHead('hml-prompt');
    assert.equal(hmlHead.content.status, 'answered');
    assert.deepEqual(hmlHead.content.values, { confirm: true });
    assert.ok(Array.isArray(hmlHead.content.fields)); // original fields preserved

    // ── Step 7: Bob sends message ──
    fm.merge([
      { id: 'bob-msg-1', type: 'interaction', parentID: null, content: { text: 'Bob joins' } },
    ]);

    // ── Step 8: Agent-2 streams response to Bob (3 phantoms) ──
    for (let i = 1; i <= 3; i++) {
      fm.merge([phantom(`bob-p${i}`, 'agent2-response', 'message', 'bob-msg-1', { text: `bob-resp-${i}` })]);
    }

    let agent2Resp = fm.getHead('agent2-response');
    assert.deepEqual(agent2Resp.content, { text: 'bob-resp-3' });
    assert.equal(agent2Resp.parentID, 'bob-msg-1');

    // ── Step 9: Permission prompt created ──
    fm.merge([
      {
        id:       'perm-prompt',
        type:     'permission-prompt',
        parentID: 'alice-msg-1',
        content:  { tool: 'file-write', path: '/tmp/test', status: 'pending' },
      },
    ]);

    // ── Step 10: Alice grants permission ──
    fm.merge([
      {
        id:      'perm-grant',
        type:    'permission-grant',
        targets: ['perm-prompt'],
        content: { status: 'granted', grantedBy: 'alice' },
      },
    ]);

    let permHead = fm.getHead('perm-prompt');
    assert.equal(permHead.content.status, 'granted');
    assert.equal(permHead.content.tool, 'file-write');

    // ── Step 11: Server sets processed ──
    fm.setProcessed('perm-prompt', 'fp-xyz');

    let processedPerm = fm.getHead('perm-prompt');
    assert.equal(processedPerm.processed, 'fp-xyz');
    assert.ok(processedPerm.processedAt);

    er.assertFired('frame:processed');

    // ── Step 12: Alice sends follow-up ──
    fm.merge([
      { id: 'alice-msg-2', type: 'interaction', parentID: null, content: { text: 'Alice follows up' } },
    ]);

    // ── Step 13: Agent-1 streams final response ──
    for (let i = 1; i <= 3; i++) {
      fm.merge([phantom(`final-p${i}`, 'agent1-final', 'message', 'alice-msg-2', { text: `final-${i}` })]);
    }

    let finalResp = fm.getHead('agent1-final');
    assert.deepEqual(finalResp.content, { text: 'final-3' });
    assert.equal(finalResp.parentID, 'alice-msg-2');

    // ── Step 14: Backfill 5 older frames ──
    let backfillFrames = [];
    for (let i = 0; i < 5; i++) {
      backfillFrames.push({
        id:       `backfill-${i}`,
        type:     'message',
        parentID: null,
        content:  { text: `old-message-${i}` },
      });
    }
    fm.merge(backfillFrames, { events: false });

    // ══════════════════════════════════════
    // VERIFY EVERYTHING
    // ══════════════════════════════════════

    // -- Total frame count --
    let all = fm.toArray();
    // 10 bulk + alice-msg-1 + reflection-1 + agent1-response + hml-prompt + hml-answer +
    // bob-msg-1 + agent2-response + perm-prompt + perm-grant + alice-msg-2 + agent1-final +
    // 5 backfill = 21 + 5 = ~26ish
    // Let's count precisely:
    // Bulk: 10
    // Live frames: alice-msg-1, reflection-1, agent1-response, hml-prompt, hml-answer,
    //   bob-msg-1, agent2-response, perm-prompt, perm-grant, alice-msg-2, agent1-final = 11
    // Backfill: 5
    // Total: 26
    assert.equal(all.length, 26);

    // -- Events --
    // frame:added should have fired for each live non-target frame
    // alice-msg-1, reflection-1(group create), agent1-response(group create),
    // hml-prompt, bob-msg-1, agent2-response(group create), perm-prompt, alice-msg-2,
    // agent1-final(group create)
    // Note: hml-answer and perm-grant have targets, so no frame:added for them

    // frame:updated should have fired for target merges and phantom updates
    er.assertFired('frame:updated');

    // frame:processed should have fired for perm-prompt
    er.assertFiredWith('frame:processed', (p) => p.frame.id === 'perm-prompt');

    // frames:bulk-loaded should fire for backfill
    // (we reset earlier, so this is the backfill one)
    er.assertFired('frames:bulk-loaded');

    // -- Ordering --
    let allIds = all.map((f) => f.id);

    // Bulk frames come before live frames
    assert.ok(allIds.indexOf('bulk-int-0') < allIds.indexOf('alice-msg-1'));

    // Live frames in correct relative order
    assert.ok(allIds.indexOf('alice-msg-1') < allIds.indexOf('bob-msg-1'));
    assert.ok(allIds.indexOf('bob-msg-1') < allIds.indexOf('alice-msg-2'));
    assert.ok(allIds.indexOf('alice-msg-2') < allIds.indexOf('agent1-final'));

    // Backfill comes after all live frames
    assert.ok(allIds.indexOf('agent1-final') < allIds.indexOf('backfill-0'));

    // -- Parent-child relationships --
    // alice-msg-1 has: reflection-1, agent1-response, hml-prompt, perm-prompt
    let alice1Children = fm.getChildren('alice-msg-1');
    let alice1ChildIds = alice1Children.map((c) => c.id).sort();
    assert.deepEqual(alice1ChildIds, ['agent1-response', 'hml-prompt', 'perm-prompt', 'reflection-1']);

    // bob-msg-1 has: agent2-response
    let bobChildren = fm.getChildren('bob-msg-1');
    assert.equal(bobChildren.length, 1);
    assert.equal(bobChildren[0].id, 'agent2-response');

    // alice-msg-2 has: agent1-final
    let alice2Children = fm.getChildren('alice-msg-2');
    assert.equal(alice2Children.length, 1);
    assert.equal(alice2Children[0].id, 'agent1-final');

    // Bulk parent-child intact
    let bulkInt0Children = fm.getChildren('bulk-int-0');
    let bulkInt0ChildIds = bulkInt0Children.map((c) => c.id).sort();
    assert.deepEqual(bulkInt0ChildIds, ['bulk-msg-0-0', 'bulk-msg-0-1', 'bulk-msg-0-2']);

    // -- Version histories --
    // reflection-1: 3 phantoms = 3 versions
    HistoryWalker.assertChainLength(fm, 'reflection-1', 3);
    HistoryWalker.assertChainIntegrity(fm, 'reflection-1');

    // agent1-response: 4 phantoms = 4 versions
    HistoryWalker.assertChainLength(fm, 'agent1-response', 4);
    HistoryWalker.assertChainIntegrity(fm, 'agent1-response');

    // hml-prompt: original + merge from hml-answer = 2 versions
    HistoryWalker.assertChainLength(fm, 'hml-prompt', 2);
    HistoryWalker.assertChainIntegrity(fm, 'hml-prompt');

    // perm-prompt: original + merge from perm-grant = 2 versions (setProcessed updates in place)
    HistoryWalker.assertChainLength(fm, 'perm-prompt', 2);
    HistoryWalker.assertChainIntegrity(fm, 'perm-prompt');

    // agent2-response: 3 phantoms = 3 versions
    HistoryWalker.assertChainLength(fm, 'agent2-response', 3);
    HistoryWalker.assertChainIntegrity(fm, 'agent2-response');

    // agent1-final: 3 phantoms = 3 versions
    HistoryWalker.assertChainLength(fm, 'agent1-final', 3);
    HistoryWalker.assertChainIntegrity(fm, 'agent1-final');

    // -- No phantoms stored --
    let phantomIds = [
      'refl-p1', 'refl-p2', 'refl-p3',
      'resp-p1', 'resp-p2', 'resp-p3', 'resp-p4',
      'bob-p1', 'bob-p2', 'bob-p3',
      'final-p1', 'final-p2', 'final-p3',
    ];
    for (let pid of phantomIds)
      assert.equal(fm.get(pid), undefined, `phantom ${pid} must not be stored`);

    // -- No corruption: all backfill frames accessible --
    for (let i = 0; i < 5; i++)
      assert.ok(fm.get(`backfill-${i}`), `backfill-${i} should exist`);

    // -- THE FINAL BOSS CHECK --
    er.detach();
    IntegrityChecker.assertValid(fm);
  });
});
