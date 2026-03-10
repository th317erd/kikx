'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FrameManager } from '../../../src/shared/frame-manager/frame-manager.mjs';

// =============================================================================
// Silent commit flag on FrameManager
// =============================================================================

describe('FrameManager silent commit flag', () => {

  // ---------------------------------------------------------------------------
  // Basic silent commit
  // ---------------------------------------------------------------------------

  describe('basic behavior', () => {
    it('merge with silent: true creates a commit with silent: true', () => {
      let manager = new FrameManager();

      manager.merge(
        [{ id: 'f1', type: 'note', content: { text: 'hello' } }],
        { silent: true },
      );

      let commit = manager.getLatestCommit();
      assert.equal(commit.silent, true);
    });

    it('merge without silent option creates a commit with silent: false (default)', () => {
      let manager = new FrameManager();

      manager.merge(
        [{ id: 'f1', type: 'note', content: { text: 'hello' } }],
      );

      let commit = manager.getLatestCommit();
      assert.equal(commit.silent, false);
    });

    it('merge with silent: false creates a commit with silent: false', () => {
      let manager = new FrameManager();

      manager.merge(
        [{ id: 'f1', type: 'note', content: { text: 'hello' } }],
        { silent: false },
      );

      let commit = manager.getLatestCommit();
      assert.equal(commit.silent, false);
    });

    it('silent commits appear in the commit log', () => {
      let manager = new FrameManager();

      manager.merge(
        [{ id: 'f1', type: 'note', content: { text: 'hello' } }],
        { silent: true },
      );

      let commits = manager.getCommits(0, Infinity);
      assert.equal(commits.length, 1);
      assert.equal(commits[0].silent, true);
    });

    it('silent commits advance the heads/main ref', () => {
      let manager = new FrameManager();

      manager.merge(
        [{ id: 'f1', type: 'note', content: { text: 'first' } }],
      );

      let mainBefore = manager.getRef('heads/main');

      manager.merge(
        [{ id: 'f2', type: 'note', content: { text: 'second' } }],
        { silent: true },
      );

      let mainAfter = manager.getRef('heads/main');
      assert.notEqual(mainAfter, mainBefore);
      assert.equal(mainAfter, manager.getLatestCommit().order);
    });
  });

  // ---------------------------------------------------------------------------
  // Silent commit with other options
  // ---------------------------------------------------------------------------

  describe('combined with other options', () => {
    it('silent + authorType/authorID are both stored correctly', () => {
      let manager = new FrameManager();

      manager.merge(
        [{ id: 'f1', type: 'note', content: { text: 'hello' } }],
        { silent: true, authorType: 'agent', authorID: 'agent-42' },
      );

      let commit = manager.getLatestCommit();
      assert.equal(commit.silent, true);
      assert.equal(commit.authorType, 'agent');
      assert.equal(commit.authorID, 'agent-42');
    });

    it('silent + events:false are both respected', () => {
      let manager  = new FrameManager();
      let events   = [];

      manager.on('frame:added', (data) => events.push(data));
      manager.on('frames:bulk-loaded', (data) => events.push({ bulkLoaded: true, ...data }));

      manager.merge(
        [{ id: 'f1', type: 'note', content: { text: 'hello' } }],
        { silent: true, events: false },
      );

      let commit = manager.getLatestCommit();
      assert.equal(commit.silent, true);

      // events:false suppresses frame:added but emits frames:bulk-loaded
      let frameAddedEvents = events.filter((e) => !e.bulkLoaded);
      assert.equal(frameAddedEvents.length, 0);

      let bulkEvents = events.filter((e) => e.bulkLoaded);
      assert.equal(bulkEvents.length, 1);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('multiple silent commits in sequence all have silent: true', () => {
      let manager = new FrameManager();

      manager.merge(
        [{ id: 'f1', type: 'note', content: { text: 'one' } }],
        { silent: true },
      );

      manager.merge(
        [{ id: 'f2', type: 'note', content: { text: 'two' } }],
        { silent: true },
      );

      manager.merge(
        [{ id: 'f3', type: 'note', content: { text: 'three' } }],
        { silent: true },
      );

      let commits = manager.getCommits(0, Infinity);
      assert.equal(commits.length, 3);

      for (let commit of commits)
        assert.equal(commit.silent, true, `commit order ${commit.order} should be silent`);
    });

    it('mix of silent and non-silent commits each has the correct flag', () => {
      let manager = new FrameManager();

      manager.merge(
        [{ id: 'f1', type: 'note', content: { text: 'loud' } }],
      );

      manager.merge(
        [{ id: 'f2', type: 'note', content: { text: 'quiet' } }],
        { silent: true },
      );

      manager.merge(
        [{ id: 'f3', type: 'note', content: { text: 'loud again' } }],
        { silent: false },
      );

      let commits = manager.getCommits(0, Infinity);
      assert.equal(commits.length, 3);
      assert.equal(commits[0].silent, false);
      assert.equal(commits[1].silent, true);
      assert.equal(commits[2].silent, false);
    });

    it('silent commit with commit validator — validator still runs', () => {
      let validatorCalled = false;

      let manager = new FrameManager({
        commitValidator: (commit, _frames, _actorContext) => {
          validatorCalled = true;
          assert.equal(commit.silent, true);
          return { allowed: true };
        },
      });

      manager.merge(
        [{ id: 'f1', type: 'note', content: { text: 'hello' } }],
        { silent: true },
      );

      assert.equal(validatorCalled, true);

      let commit = manager.getLatestCommit();
      assert.equal(commit.silent, true);
    });

    it('silent commit rejected by validator does not persist', () => {
      let manager = new FrameManager({
        commitValidator: () => ({ allowed: false, reason: 'denied' }),
      });

      let rejected = false;
      manager.on('commit:rejected', () => { rejected = true; });

      let results = manager.merge(
        [{ id: 'f1', type: 'note', content: { text: 'nope' } }],
        { silent: true },
      );

      assert.equal(results.length, 0);
      assert.equal(rejected, true);
      assert.equal(manager.getLatestCommit(), undefined);
    });

    it('silent flag coerces truthy values to boolean', () => {
      let manager = new FrameManager();

      manager.merge(
        [{ id: 'f1', type: 'note', content: { text: 'truthy' } }],
        { silent: 1 },
      );

      let commit = manager.getLatestCommit();
      assert.equal(commit.silent, true);
      assert.equal(typeof commit.silent, 'boolean');
    });

    it('silent flag coerces falsy values to boolean', () => {
      let manager = new FrameManager();

      manager.merge(
        [{ id: 'f1', type: 'note', content: { text: 'falsy' } }],
        { silent: 0 },
      );

      let commit = manager.getLatestCommit();
      assert.equal(commit.silent, false);
      assert.equal(typeof commit.silent, 'boolean');
    });

    it('silent flag with undefined defaults to false', () => {
      let manager = new FrameManager();

      manager.merge(
        [{ id: 'f1', type: 'note', content: { text: 'undef' } }],
        { silent: undefined },
      );

      let commit = manager.getLatestCommit();
      assert.equal(commit.silent, false);
    });
  });
});
