'use strict';

export function shutdownHTTPServer(server, options = {}) {
  let {
    forceAfterMS = 250,
    timeoutMS = 5000,
  } = options;

  return new Promise((resolve) => {
    let settled = false;
    let forceTimer;
    let timeoutTimer;

    let finish = (result) => {
      if (settled)
        return;

      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(timeoutTimer);
      resolve(result);
    };

    forceTimer = setTimeout(() => {
      try {
        server.closeAllConnections?.();
      } catch (error) {
        finish({
          timedOut: false,
          error,
        });
      }
    }, forceAfterMS);
    timeoutTimer = setTimeout(() => {
      finish({ timedOut: true, error: null });
    }, timeoutMS);

    forceTimer.unref?.();
    timeoutTimer.unref?.();

    try {
      server.close((error) => {
        finish({
          timedOut: false,
          error: error || null,
        });
      });
      server.closeIdleConnections?.();
    } catch (error) {
      finish({
        timedOut: false,
        error,
      });
    }
  });
}
