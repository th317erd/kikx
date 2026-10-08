'use strict';

// Process-level error policy. Node's default is to terminate on both an
// uncaught exception and an unhandled rejection. Terminating drops every live
// SSE stream and every in-flight agent turn, so Kikx needs a deliberate policy
// rather than the default. The policy is:
//
//   - uncaughtException: the stack has already unwound and process state is
//     unknown, so continuing is unsafe. Log with full context, hand off to
//     `onFatal` (the server attempts a graceful shutdown), then exit non-zero if
//     nothing else owns recovery. Never swallow it silently.
//   - unhandledRejection: a stray rejected promise is contained, not evidence
//     that the process is corrupt. Log it so the bug is observable, but keep
//     serving clients instead of dropping every connection.
//
// Both branches log first, so a programming error is always visible even when
// the recovery choice is "keep running".

export const DEFAULT_FATAL_EXIT_CODE = 1;

export function installProcessErrorPolicy(options = {}) {
  let {
    processRef = process,
    logger = console,
    onFatal = null,
    exitCode = DEFAULT_FATAL_EXIT_CODE,
  } = options;

  let handleUncaughtException = (error) => {
    logger?.error?.('Kikx process uncaughtException', error);
    if (typeof onFatal === 'function') {
      try {
        onFatal(error, 'uncaughtException');
      } catch (handlerError) {
        logger?.error?.('Kikx fatal handler threw', handlerError);
        processRef.exit?.(exitCode);
      }
      return;
    }

    processRef.exit?.(exitCode);
  };

  let handleUnhandledRejection = (reason, promise) => {
    logger?.error?.('Kikx process unhandledRejection', reason, promise);
    if (typeof onFatal === 'function') {
      try {
        onFatal(reason, 'unhandledRejection');
      } catch (handlerError) {
        logger?.error?.('Kikx fatal handler threw', handlerError);
      }
    }
  };

  processRef.on('uncaughtException', handleUncaughtException);
  processRef.on('unhandledRejection', handleUnhandledRejection);

  return () => {
    processRef.off?.('uncaughtException', handleUncaughtException);
    processRef.off?.('unhandledRejection', handleUnhandledRejection);
  };
}
