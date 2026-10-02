'use strict';

// P9 compaction-bubble presentation helpers.
//
// Kept DOM-free so status coloring, warning/error normalization and retry
// visibility can be unit-tested without a browser. The custom element in
// `kikx-compaction-frame.mjs` only wires these into DOM.

// Map the frame's raw status onto the UI's four visual states. `success` is the
// completed case; `error` covers failed/error; `trimmed` is a warned-but-degraded
// boundary; anything else (including `running`) is neutral.
export function normalizeCompactionStatus(status) {
  if (status === 'complete' || status === 'success')
    return 'success';

  if (status === 'failed' || status === 'error')
    return 'error';

  if (status === 'trimmed')
    return 'trimmed';

  return 'running';
}

// Status pill classes beyond the shared `kikx-tool-card__status`.
export function compactionStatusClass(status) {
  return `kikx-tool-card__status--${normalizeCompactionStatus(status)}`;
}

// Card classes: the shared tool-card base plus a status modifier for coloring.
export function compactionCardClass(status) {
  return `kikx-tool-card kikx-compaction-card kikx-compaction-card--${normalizeCompactionStatus(status)}`;
}

export function compactionSummaryLine({ status, frameCount = 0, content = {} } = {}) {
  let normalized = normalizeCompactionStatus(status);

  if (normalized === 'success') {
    if (frameCount > 0)
      return `Compaction complete. ${frameCount} frame${frameCount === 1 ? '' : 's'} compressed.`;

    return content.text || 'Nothing to compact.';
  }

  if (normalized === 'error')
    return content.text || 'Compaction failed.';

  if (normalized === 'trimmed')
    return content.text || 'Compaction failed; context was trimmed to proceed.';

  if (frameCount > 0)
    return `Compacting session context across ${frameCount} frame${frameCount === 1 ? '' : 's'}...`;

  return content.text || 'Compacting session context...';
}

// Normalize `warnings`/`errors` to `{ message, kind }`. Accepts plain strings and
// objects, drops entries with no usable message, and never mutates the input.
export function normalizeCompactionIssues(entries) {
  let list = Array.isArray(entries) ? entries : (entries == null ? [] : [ entries ]);
  let normalized = [];

  for (let entry of list) {
    if (typeof entry === 'string') {
      let message = entry.trim();
      if (message !== '')
        normalized.push({ message, kind: 'compaction' });
      continue;
    }

    if (!entry || typeof entry !== 'object')
      continue;

    let message = typeof entry.message === 'string' ? entry.message.trim() : '';
    if (message === '')
      continue;

    normalized.push({
      message,
      kind: typeof entry.kind === 'string' && entry.kind.trim() !== '' ? entry.kind : 'compaction',
    });
  }

  return normalized;
}

export function compactionWarnings(content = {}) {
  return normalizeCompactionIssues(content.warnings);
}

export function compactionErrors(content = {}) {
  return normalizeCompactionIssues(content.errors);
}

// Retry is offered on any degraded boundary: a failure (error) or a trim.
export function compactionRetryable(status) {
  let normalized = normalizeCompactionStatus(status);
  return normalized === 'error' || normalized === 'trimmed';
}

export function compactionRetryURL(sessionID, frameID) {
  return `/api/v1/sessions/${encodeURIComponent(sessionID)}/compaction/${encodeURIComponent(frameID)}/retry`;
}
