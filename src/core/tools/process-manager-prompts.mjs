'use strict';

function buildProcessWakePrompt(record, wake) {
  let responseLine = record.completionLarge
    ? [
      `Async exec ID# ${record.processID} finished, but the completion response is large (${record.completionSizeBytes} bytes).`,
      record.completionToolOutputID
        ? `Use output-read with {"id":"${record.completionToolOutputID}","start":0,"end":<exclusive_byte_offset>} to fetch ranges of the persisted response.`
        : '',
      record.completionToolOutputID
        ? `Use output-grep with {"id":"${record.completionToolOutputID}","pattern":"<regexp>"} to search/filter it without reading everything.`
        : '',
    ].filter(Boolean).join(' ')
    : record.completionToolOutputID
      ? `The full completion result was stored in AeorDB as tool output ${record.completionToolOutputID}. Use output-read {"id":"${record.completionToolOutputID}"} to read it.`
      : 'The completion result could not be stored; inspect exec-status for the storage error.';

  let statusLine = record.status === 'interrupted'
    ? `Async process ${record.processID} was interrupted by a server restart; its child is no longer managed. Captured output is preserved below.`
    : `Async process ${record.processID} has completed with status ${record.status}.`;

  return [
    statusLine,
    `Command: ${record.command}`,
    `Exit code: ${record.exitCode}; signal: ${record.signal}; durationMs: ${record.durationMs}.`,
    responseLine,
    wake.continuationPrompt,
  ].filter(Boolean).join('\n\n');
}

function buildDefaultWakePrompt(record) {
  return [
    `Async exec ID# ${record.processID} has completed.`,
    'Review the completion output, continue the user task if needed, and report the result when appropriate.',
  ].join(' ');
}

export { buildDefaultWakePrompt, buildProcessWakePrompt };
