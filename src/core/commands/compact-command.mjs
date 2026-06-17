'use strict';

export class CompactCommand {
  static description = 'Manually compact the current session context.';

  constructor(context = {}) {
    this.context = context;
  }

  async execute({ frame, session, services }) {
    let compactionService = services?.compactionService || services?.context?.require?.('compactionService');
    if (!compactionService)
      throw new Error('/compact requires a compaction service');

    let frameRuntime = services?.frameRuntime || services?.context?.require?.('frameRuntime');
    let entry = frameRuntime?.requireSessionEntry
      ? frameRuntime.requireSessionEntry(frame.sessionID)
      : null;
    let frameEngine = this.context.engine || entry?.frameEngine;
    if (!frameEngine)
      throw new Error('/compact requires an active frame engine');

    compactionService.startManualCompaction({
      session: session || entry?.session,
      frameEngine,
      triggerFrame: frame,
      services,
    });

    return {
      status: 'ok',
      message: 'Compaction started.',
      suppressCommandResult: true,
    };
  }
}

