'use strict';

import { describe, it }  from 'node:test';
import assert             from 'node:assert/strict';
import { computeDiff }   from '../../../../src/core/internal-plugins/files/diff.mjs';

describe('computeDiff', () => {

  // ---------------------------------------------------------------------------
  // Identity / trivial cases
  // ---------------------------------------------------------------------------

  it('returns empty hunks for identical strings', () => {
    let result = computeDiff('hello\nworld\n', 'hello\nworld\n');
    assert.deepStrictEqual(result.hunks, []);
    assert.equal(result.additions, 0);
    assert.equal(result.removals, 0);
  });

  it('returns empty hunks for two empty strings', () => {
    let result = computeDiff('', '');
    assert.deepStrictEqual(result.hunks, []);
    assert.equal(result.additions, 0);
    assert.equal(result.removals, 0);
  });

  it('handles null/undefined inputs gracefully', () => {
    let result = computeDiff(null, null);
    assert.deepStrictEqual(result.hunks, []);
    assert.equal(result.additions, 0);
    assert.equal(result.removals, 0);
  });

  // ---------------------------------------------------------------------------
  // Pure additions (empty old)
  // ---------------------------------------------------------------------------

  it('shows all additions when old is empty', () => {
    let result = computeDiff('', 'line1\nline2\nline3\n');
    assert.equal(result.additions, 3);
    assert.equal(result.removals, 0);

    let allLines = result.hunks.flatMap((h) => h.lines);
    assert.equal(allLines.length, 3);

    for (let line of allLines)
      assert.equal(line.type, 'add');
  });

  // ---------------------------------------------------------------------------
  // Pure removals (empty new)
  // ---------------------------------------------------------------------------

  it('shows all removals when new is empty', () => {
    let result = computeDiff('line1\nline2\nline3\n', '');
    assert.equal(result.additions, 0);
    assert.equal(result.removals, 3);

    let allLines = result.hunks.flatMap((h) => h.lines);
    assert.equal(allLines.length, 3);

    for (let line of allLines)
      assert.equal(line.type, 'remove');
  });

  // ---------------------------------------------------------------------------
  // Single line change
  // ---------------------------------------------------------------------------

  it('detects a single line change', () => {
    let old = 'aaa\nbbb\nccc\n';
    let now = 'aaa\nBBB\nccc\n';

    let result = computeDiff(old, now);
    assert.equal(result.additions, 1);
    assert.equal(result.removals, 1);

    let allLines = result.hunks.flatMap((h) => h.lines);
    let removed  = allLines.filter((l) => l.type === 'remove');
    let added    = allLines.filter((l) => l.type === 'add');

    assert.equal(removed.length, 1);
    assert.equal(removed[0].content, 'bbb');
    assert.equal(added.length, 1);
    assert.equal(added[0].content, 'BBB');
  });

  // ---------------------------------------------------------------------------
  // Context lines
  // ---------------------------------------------------------------------------

  it('includes context lines around changes', () => {
    let lines = [];
    for (let i = 1; i <= 20; i++)
      lines.push(`line ${i}`);

    let oldText = lines.join('\n') + '\n';
    let newLines = [...lines];
    newLines[9] = 'CHANGED LINE 10';
    let newText = newLines.join('\n') + '\n';

    let result = computeDiff(oldText, newText);
    assert.equal(result.hunks.length, 1);

    let hunk     = result.hunks[0];
    let contexts = hunk.lines.filter((l) => l.type === 'context');

    // Should have up to 3 context lines before and 3 after the change
    assert.ok(contexts.length >= 2, `Expected at least 2 context lines, got ${contexts.length}`);
    assert.ok(contexts.length <= 6, `Expected at most 6 context lines, got ${contexts.length}`);
  });

  // ---------------------------------------------------------------------------
  // Multiple separate changes → multiple hunks
  // ---------------------------------------------------------------------------

  it('produces separate hunks for distant changes', () => {
    let lines = [];
    for (let i = 1; i <= 30; i++)
      lines.push(`line ${i}`);

    let oldText  = lines.join('\n') + '\n';
    let newLines = [...lines];
    newLines[2]  = 'CHANGED LINE 3';
    newLines[27] = 'CHANGED LINE 28';
    let newText  = newLines.join('\n') + '\n';

    let result = computeDiff(oldText, newText);

    // Two changes far apart should produce 2 hunks
    assert.ok(result.hunks.length >= 2, `Expected at least 2 hunks, got ${result.hunks.length}`);
  });

  // ---------------------------------------------------------------------------
  // Line numbers
  // ---------------------------------------------------------------------------

  it('assigns correct line numbers to diff lines', () => {
    let old = 'aaa\nbbb\nccc\n';
    let now = 'aaa\nBBB\nccc\n';

    let result = computeDiff(old, now);
    let lines  = result.hunks.flatMap((h) => h.lines);

    let removed = lines.find((l) => l.type === 'remove');
    let added   = lines.find((l) => l.type === 'add');

    assert.equal(removed.oldLine, 2);
    assert.equal(removed.newLine, null);
    assert.equal(added.newLine, 2);
    assert.equal(added.oldLine, null);
  });

  // ---------------------------------------------------------------------------
  // Insertion in the middle
  // ---------------------------------------------------------------------------

  it('detects inserted lines', () => {
    let old = 'aaa\nccc\n';
    let now = 'aaa\nbbb\nccc\n';

    let result = computeDiff(old, now);
    assert.equal(result.additions, 1);
    assert.equal(result.removals, 0);

    let added = result.hunks.flatMap((h) => h.lines).filter((l) => l.type === 'add');
    assert.equal(added.length, 1);
    assert.equal(added[0].content, 'bbb');
  });

  // ---------------------------------------------------------------------------
  // Deletion in the middle
  // ---------------------------------------------------------------------------

  it('detects deleted lines', () => {
    let old = 'aaa\nbbb\nccc\n';
    let now = 'aaa\nccc\n';

    let result = computeDiff(old, now);
    assert.equal(result.additions, 0);
    assert.equal(result.removals, 1);

    let removed = result.hunks.flatMap((h) => h.lines).filter((l) => l.type === 'remove');
    assert.equal(removed.length, 1);
    assert.equal(removed[0].content, 'bbb');
  });

  // ---------------------------------------------------------------------------
  // Strings without trailing newlines
  // ---------------------------------------------------------------------------

  it('handles strings without trailing newlines', () => {
    let result = computeDiff('hello\nworld', 'hello\nearth');
    assert.equal(result.additions, 1);
    assert.equal(result.removals, 1);
  });

  // ---------------------------------------------------------------------------
  // Large identical file (no diff)
  // ---------------------------------------------------------------------------

  it('returns empty hunks for a large identical file', () => {
    let lines = [];
    for (let i = 0; i < 500; i++)
      lines.push(`line ${i}`);

    let text   = lines.join('\n') + '\n';
    let result = computeDiff(text, text);

    assert.deepStrictEqual(result.hunks, []);
    assert.equal(result.additions, 0);
    assert.equal(result.removals, 0);
  });

  // ---------------------------------------------------------------------------
  // Single line files
  // ---------------------------------------------------------------------------

  it('handles single-line old to single-line new', () => {
    let result = computeDiff('old\n', 'new\n');
    assert.equal(result.additions, 1);
    assert.equal(result.removals, 1);
  });

  // ---------------------------------------------------------------------------
  // Completely different content
  // ---------------------------------------------------------------------------

  it('handles completely different content', () => {
    let result = computeDiff('aaa\nbbb\nccc\n', 'xxx\nyyy\nzzz\n');
    assert.equal(result.additions, 3);
    assert.equal(result.removals, 3);
  });

  // ---------------------------------------------------------------------------
  // Hunk metadata
  // ---------------------------------------------------------------------------

  it('sets correct hunk oldStart/newStart', () => {
    let old = 'aaa\nbbb\nccc\n';
    let now = 'aaa\nBBB\nccc\n';

    let result = computeDiff(old, now);
    assert.equal(result.hunks.length, 1);

    let hunk = result.hunks[0];
    assert.equal(typeof hunk.oldStart, 'number');
    assert.equal(typeof hunk.newStart, 'number');
    assert.equal(typeof hunk.oldCount, 'number');
    assert.equal(typeof hunk.newCount, 'number');
    assert.ok(hunk.oldStart >= 1);
    assert.ok(hunk.newStart >= 1);
  });
});
