'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentInterface } from '../../../src/core/plugins/index.mjs';
import { DEFAULT_COMPACTION_WINDOW_SAFETY_RATIO } from '../../../src/core/compaction/index.mjs';
import { createMergeSummaryRunner } from '../../../src/core/merge/session-merge-summary.mjs';

class LargeWindowProvider extends AgentInterface {
  static pluginID = 'large-window';

  resolveContextWindow() {
    return 100000;
  }

  async *ask() {}
}

test('merge summary budgeting applies the chars-per-token safety margin', async () => {
  let captured = null;
  let compactionService = {
    async resolveCompactionAgent() {
      return { id: 'compactor', pluginID: 'large-window', config: {} };
    },
    resolveProviderClass() {
      return LargeWindowProvider;
    },
    resolveCompactionBudget(options) {
      captured = options;
      return 1000;
    },
  };

  let runner = await createMergeSummaryRunner({ compactionService });

  assert.equal(runner.contextBudget, 1000);
  assert.equal(captured.safetyRatio, DEFAULT_COMPACTION_WINDOW_SAFETY_RATIO);
});
