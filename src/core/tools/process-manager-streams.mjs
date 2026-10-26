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

// Like waitForCompletion, but a queued user/actor message or a cancellation can
// end the grace wait immediately. The process keeps running; the caller returns
// the async handle instead of continuing to block the agent turn.
async function waitForCompletionOrInterrupt(promise, timeoutMs, options = {}) {
  let timeout;
  let poll;
  let timeoutSymbol = Symbol('timeout');
  let interruptSymbol = Symbol('interrupt');
  let candidates = [
    promise,
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve(timeoutSymbol), timeoutMs);
      timeout.unref?.();
    }),
  ];
  if (typeof options.isInterrupted === 'function') {
    candidates.push(new Promise((resolve) => {
      poll = setInterval(() => {
        try {
          if (options.isInterrupted())
            resolve(interruptSymbol);
        } catch (_error) {}
      }, 50);
      poll.unref?.();
    }));
  }

  let result = await Promise.race(candidates);
  clearTimeout(timeout);
  if (poll)
    clearInterval(poll);
  return {
    completed: result !== timeoutSymbol && result !== interruptSymbol,
    interrupted: result === interruptSymbol,
    value: result,
  };
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
  waitForCompletionOrInterrupt,
  waitForRecords,
};
