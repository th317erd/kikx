'use strict';

export function buildSuspensionWarning({ isCoordinator = false, suspendedAgentIDs = [], platform = process.platform, restarted = false } = {}) {
  let suspended = suspendedAgentIDs.length > 0
    ? suspendedAgentIDs.join(', ')
    : 'none';
  let windows = platform === 'win32';

  if (isCoordinator) {
    return [
      '!!!WARNING!!! The user just suspended this session.',
      windows
        ? 'ALL IN-FLIGHT tool calls were ABORTED (Windows cannot suspend processes). Do not assume any interrupted command succeeded.'
        : restarted
          ? 'The server restarted while this session was suspended. In-flight commands did not survive that restart; inspect their recorded status before restarting any work.'
          : 'All in-flight commands were PAUSED with SIGSTOP and remain suspended. They will not make progress until explicitly resumed.',
      `Suspended agents: ${suspended}.`,
      'You are the coordinator and have been woken only because a real user sent this message. Every non-coordinator bot remains suspended until you explicitly resume it.',
      'Your job now is recovery: tell the user which bots are suspended, ask what they want to happen, and use session-control (action list/resume/suspend) for agents plus exec-list/exec-status/exec-resume/exec-kill for commands. On Windows, restart interrupted work only after user or coordinator confirmation.',
      'Do not assume the session is healthy until you have inspected the suspended agents and their commands.',
    ].join('\n');
  }

  return [
    '!!!WARNING!!! The user just suspended this session.',
    windows
      ? 'ALL IN-FLIGHT tool calls were ABORTED (Windows cannot suspend processes). Check their status and restart only when the coordinator or user confirms.'
      : restarted
        ? 'The server restarted while this session was suspended. Your in-flight commands did not survive that restart; inspect their recorded status before restarting any work.'
        : 'Your in-flight commands were PAUSED with SIGSTOP and remain suspended. They will not make progress until explicitly resumed.',
    'Use exec-list and exec-status to inspect your commands, then exec-resume to continue one or exec-kill to terminate one as appropriate. You may only manage your own commands.',
    'You were explicitly resumed by the coordinator. Do not assume other suspended bots or their commands are healthy.',
  ].join('\n');
}
