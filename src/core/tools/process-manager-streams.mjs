'use strict';

async function waitForCompletion(promise, timeoutMs) {
  let timeout;
  let timeoutSymbol = Symbol('timeout');
  let result = await Promise.race([
    promise,
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve(timeoutSymbol), timeoutMs);
      timeout.unref?.();
    }),
  ]);
  clearTimeout(timeout);
  return result === timeoutSymbol ? null : result;
}

async function waitForRecords(records, timeoutMs) {
  if (!records.length || timeoutMs <= 0)
    return;

  let timeout;
  await Promise.race([
    Promise.allSettled(records.map((record) => record.completionPromise)),
    new Promise((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
      timeout.unref?.();
    }),
  ]);
  clearTimeout(timeout);
}

function forceCloseCaptureStreams(record, stdoutStream, stderrStream) {
  record.stdioClosedByManager = true;

  closeCaptureStream(record.handle?.child?.stdout, stdoutStream);
  closeCaptureStream(record.handle?.child?.stderr, stderrStream);
}

function closeCaptureStream(readable, writable) {
  try {
    readable?.unpipe?.(writable);
  } catch (_error) {}

  try {
    readable?.destroy?.();
  } catch (_error) {}

  try {
    writable?.end?.();
  } catch (_error) {}
}

export {
  closeCaptureStream,
  forceCloseCaptureStreams,
  waitForCompletion,
  waitForRecords,
};
