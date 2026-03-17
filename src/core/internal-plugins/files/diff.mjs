'use strict';

// =============================================================================
// Minimal Diff Algorithm
// =============================================================================
// Computes a unified-style diff between two strings, split by newlines.
// Returns an array of hunks, each containing lines with type annotations
// suitable for rendering in a diff viewer.
//
// Uses a simple LCS (Longest Common Subsequence) approach for correctness
// without external dependencies.
// =============================================================================

const CONTEXT_LINES = 3;

/**
 * Compute diff between two strings.
 *
 * @param {string} oldText  — original content
 * @param {string} newText  — modified content
 * @returns {{ hunks: Array<{ oldStart: number, oldCount: number, newStart: number, newCount: number, lines: Array<{ type: 'add'|'remove'|'context', content: string, oldLine: number|null, newLine: number|null }> }>, additions: number, removals: number }}
 */
export function computeDiff(oldText, newText) {
  let oldLines = (oldText || '').split('\n');
  let newLines = (newText || '').split('\n');

  // Strip trailing empty line from final newline (consistent with file conventions)
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '')
    oldLines.pop();

  if (newLines.length > 0 && newLines[newLines.length - 1] === '')
    newLines.pop();

  let changes = myersDiff(oldLines, newLines);
  let hunks   = buildHunks(changes, oldLines, newLines);

  let additions = 0;
  let removals  = 0;

  for (let hunk of hunks) {
    for (let line of hunk.lines) {
      if (line.type === 'add')
        additions++;
      else if (line.type === 'remove')
        removals++;
    }
  }

  return { hunks, additions, removals };
}

// ---------------------------------------------------------------------------
// Myers diff — O((N+M)D) edit script
// ---------------------------------------------------------------------------

function myersDiff(oldLines, newLines) {
  let N = oldLines.length;
  let M = newLines.length;

  if (N === 0 && M === 0)
    return [];

  if (N === 0)
    return newLines.map((line, i) => ({ type: 'add', value: line, newIndex: i }));

  if (M === 0)
    return oldLines.map((line, i) => ({ type: 'remove', value: line, oldIndex: i }));

  let max   = N + M;
  let vSize = 2 * max + 1;
  let v     = new Int32Array(vSize);

  // Backtrack storage: one snapshot of v per d-step
  let trace = [];

  v.fill(-1);
  v[max + 1] = 0;

  outer:
  for (let d = 0; d <= max; d++) {
    // Save v snapshot for backtracking
    trace.push(v.slice());

    for (let k = -d; k <= d; k += 2) {
      let index = k + max;
      let x;

      if (k === -d || (k !== d && v[index - 1] < v[index + 1]))
        x = v[index + 1];
      else
        x = v[index - 1] + 1;

      let y = x - k;

      // Follow diagonal (matching lines)
      while (x < N && y < M && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }

      v[index] = x;

      if (x >= N && y >= M)
        break outer;
    }
  }

  // Backtrack to recover edit script
  return backtrack(trace, oldLines, newLines, max);
}

function backtrack(trace, oldLines, newLines, max) {
  let N = oldLines.length;
  let M = newLines.length;
  let x = N;
  let y = M;

  let edits = [];

  for (let d = trace.length - 1; d >= 0; d--) {
    let v = trace[d];
    let k = x - y;

    let prevK;
    if (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max]))
      prevK = k + 1;
    else
      prevK = k - 1;

    let prevX = v[prevK + max];
    let prevY = prevX - prevK;

    // Diagonal moves (equal lines) — walk backwards
    while (x > prevX && y > prevY) {
      x--;
      y--;
      edits.push({ type: 'equal', value: oldLines[x], oldIndex: x, newIndex: y });
    }

    if (d > 0) {
      if (x === prevX) {
        // Insertion
        y--;
        edits.push({ type: 'add', value: newLines[y], newIndex: y });
      } else {
        // Deletion
        x--;
        edits.push({ type: 'remove', value: oldLines[x], oldIndex: x });
      }
    }
  }

  edits.reverse();
  return edits;
}

// ---------------------------------------------------------------------------
// Build unified-diff-style hunks with context lines
// ---------------------------------------------------------------------------

function buildHunks(edits, oldLines, newLines) {
  if (edits.length === 0)
    return [];

  // Find change regions (non-equal edits)
  let changeIndices = [];
  for (let i = 0; i < edits.length; i++) {
    if (edits[i].type !== 'equal')
      changeIndices.push(i);
  }

  if (changeIndices.length === 0)
    return [];

  // Group changes into hunks (merge if within CONTEXT_LINES * 2 of each other)
  let groups  = [];
  let current = { start: changeIndices[0], end: changeIndices[0] };

  for (let i = 1; i < changeIndices.length; i++) {
    if (changeIndices[i] - current.end <= CONTEXT_LINES * 2)
      current.end = changeIndices[i];
    else {
      groups.push(current);
      current = { start: changeIndices[i], end: changeIndices[i] };
    }
  }

  groups.push(current);

  // Build hunks with context
  let hunks = [];

  for (let group of groups) {
    let contextStart = Math.max(0, group.start - CONTEXT_LINES);
    let contextEnd   = Math.min(edits.length - 1, group.end + CONTEXT_LINES);

    let lines    = [];
    let oldStart = null;
    let newStart = null;
    let oldCount = 0;
    let newCount = 0;

    for (let i = contextStart; i <= contextEnd; i++) {
      let edit = edits[i];

      if (edit.type === 'equal') {
        let oldLine = edit.oldIndex + 1;
        let newLine = edit.newIndex + 1;

        if (oldStart === null) oldStart = oldLine;
        if (newStart === null) newStart = newLine;

        lines.push({ type: 'context', content: edit.value, oldLine, newLine });
        oldCount++;
        newCount++;
      } else if (edit.type === 'remove') {
        let oldLine = edit.oldIndex + 1;

        if (oldStart === null) oldStart = oldLine;
        if (newStart === null) {
          // Determine newStart from surrounding context
          let nextNewLine = findNextNewLine(edits, i);
          newStart = (nextNewLine !== null) ? nextNewLine : 1;
        }

        lines.push({ type: 'remove', content: edit.value, oldLine, newLine: null });
        oldCount++;
      } else if (edit.type === 'add') {
        let newLine = edit.newIndex + 1;

        if (newStart === null) newStart = newLine;
        if (oldStart === null) {
          let nextOldLine = findNextOldLine(edits, i);
          oldStart = (nextOldLine !== null) ? nextOldLine : 1;
        }

        lines.push({ type: 'add', content: edit.value, oldLine: null, newLine });
        newCount++;
      }
    }

    if (oldStart === null) oldStart = 1;
    if (newStart === null) newStart = 1;

    hunks.push({ oldStart, oldCount, newStart, newCount, lines });
  }

  return hunks;
}

function findNextNewLine(edits, fromIndex) {
  for (let i = fromIndex + 1; i < edits.length; i++) {
    if (edits[i].type === 'equal' || edits[i].type === 'add')
      return edits[i].newIndex + 1;
  }

  return null;
}

function findNextOldLine(edits, fromIndex) {
  for (let i = fromIndex + 1; i < edits.length; i++) {
    if (edits[i].type === 'equal' || edits[i].type === 'remove')
      return edits[i].oldIndex + 1;
  }

  return null;
}
