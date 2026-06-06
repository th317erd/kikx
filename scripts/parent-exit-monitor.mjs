'use strict';

export function createParentExitMonitor(options = {}) {
  let {
    parentPID = process.ppid,
    getParentPID = () => process.ppid,
    isProcessAlive = defaultIsProcessAlive,
    onParentExit,
    intervalMS = 500,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = options;

  if (typeof onParentExit !== 'function')
    throw new TypeError('onParentExit must be a function');

  let stopped = false;
  let timer = setIntervalFn(() => {
    if (stopped)
      return;

    let currentParentPID = getParentPID();
    let parentAlive = isProcessAlive(parentPID);
    if (currentParentPID === parentPID && parentAlive)
      return;

    stopped = true;
    clearIntervalFn(timer);
    onParentExit({
      parentPID,
      currentParentPID,
      parentAlive,
    });
  }, intervalMS);

  timer?.unref?.();

  return {
    stop() {
      if (stopped)
        return;

      stopped = true;
      clearIntervalFn(timer);
    },
  };
}

export function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH')
      return false;

    if (error.code === 'EPERM')
      return true;

    throw error;
  }
}
