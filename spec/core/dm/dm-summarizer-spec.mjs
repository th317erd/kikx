'use strict';

import { describe, it, before, after } from 'node:test';
import assert                           from 'node:assert/strict';

import { DmSummarizer } from '../../../src/core/dm/dm-summarizer.mjs';

// =============================================================================
// Helpers
// =============================================================================

function createMockContext(overrides = {}) {
  let properties = { ...overrides };

  return {
    getProperty: (key) => properties[key],
    setProperty: (key, value) => { properties[key] = value; },
  };
}

function createMockFramePersistence(frames = []) {
  return {
    _frames: frames,
    async loadFrames(_sessionID) {
      return this._frames;
    },
  };
}

function createMockAgentPlugin(responseBlocks = []) {
  return {
    async execute(_params) {
      return (async function* () {
        for (let block of responseBlocks)
          yield block;

        yield { type: 'done', content: {} };
      })();
    },
  };
}

function createMockModels() {
  let agents = new Map();

  return {
    Agent: {
      where: {
        id: {
          EQ: (id) => ({
            async first() {
              return agents.get(id) || null;
            },
          }),
        },
      },
      _set: (id, agent) => agents.set(id, agent),
    },
  };
}

// =============================================================================
// DmSummarizer
// =============================================================================

describe('DmSummarizer', () => {
  it('should construct with context', () => {
    let context    = createMockContext();
    let summarizer = new DmSummarizer(context);
    assert.ok(summarizer);
  });

  it('should throw if context is not provided', () => {
    assert.throws(
      () => new DmSummarizer(null),
      { message: 'DmSummarizer requires a CascadingContext' },
    );
  });

  // ---- framesToConversation ----

  describe('framesToConversation', () => {
    it('should convert user-message and message frames to text', () => {
      let context    = createMockContext();
      let summarizer = new DmSummarizer(context);

      let frames = [
        { type: 'user-message', content: { text: 'Always respond in JSON' } },
        { type: 'message', content: { html: 'Understood, I will respond in JSON format.' } },
        { type: 'user-message', content: { text: 'Be concise' } },
        { type: 'message', content: { html: 'Got it, I will keep responses short.' } },
      ];

      let text = summarizer.framesToConversation(frames);
      assert.ok(text.includes('User: Always respond in JSON'));
      assert.ok(text.includes('Agent: Understood'));
      assert.ok(text.includes('User: Be concise'));
      assert.ok(text.includes('Agent: Got it'));
    });

    it('should skip non-conversation frames', () => {
      let context    = createMockContext();
      let summarizer = new DmSummarizer(context);

      let frames = [
        { type: 'user-message', content: { text: 'Hello' } },
        { type: 'tool-call', content: { toolName: 'search' } },
        { type: 'tool-result', content: { output: 'results' } },
        { type: 'message', content: { html: 'Response' } },
        { type: 'reflection', content: { text: 'thinking' } },
      ];

      let text = summarizer.framesToConversation(frames);
      assert.ok(text.includes('User: Hello'));
      assert.ok(text.includes('Agent: Response'));
      assert.ok(!text.includes('search'));
      assert.ok(!text.includes('results'));
      assert.ok(!text.includes('thinking'));
    });

    it('should return empty string for empty frames', () => {
      let context    = createMockContext();
      let summarizer = new DmSummarizer(context);
      let text       = summarizer.framesToConversation([]);
      assert.equal(text, '');
    });

    it('should handle frames with missing content gracefully', () => {
      let context    = createMockContext();
      let summarizer = new DmSummarizer(context);
      let frames     = [
        { type: 'user-message', content: null },
        { type: 'message' },
      ];
      let text = summarizer.framesToConversation(frames);
      assert.ok(text.includes('User: '));
      assert.ok(text.includes('Agent: '));
    });
  });

  // ---- buildSummaryPrompt ----

  describe('buildSummaryPrompt', () => {
    it('should include conversation text in prompt', () => {
      let context    = createMockContext();
      let summarizer = new DmSummarizer(context);
      let prompt     = summarizer.buildSummaryPrompt('User: Be concise\n\nAgent: OK');
      assert.ok(prompt.includes('User: Be concise'));
      assert.ok(prompt.includes('Agent: OK'));
      assert.ok(prompt.includes('Extract the instructions'));
    });
  });

  // ---- summarize ----

  describe('summarize', () => {
    it('should return null for empty frames', async () => {
      let persistence = createMockFramePersistence([]);
      let context     = createMockContext({ framePersistence: persistence });
      let summarizer  = new DmSummarizer(context);
      let agentPlugin = createMockAgentPlugin([]);

      let result = await summarizer.summarize(agentPlugin, { id: 'agt_test' }, 'ses_dm');
      assert.equal(result, null);
    });

    it('should return summary from agent response', async () => {
      let frames = [
        { type: 'user-message', content: { text: 'Always use JSON' } },
        { type: 'message', content: { html: 'I will use JSON' } },
      ];

      let persistence = createMockFramePersistence(frames);
      let agentRecord = { id: 'agt_test', dmSummary: null, save: async () => {} };
      let models      = createMockModels();
      models.Agent._set('agt_test', agentRecord);

      let context = createMockContext({
        framePersistence: persistence,
        models,
      });

      let summarizer  = new DmSummarizer(context);
      let agentPlugin = createMockAgentPlugin([
        { type: 'message', content: { html: '1. Always respond in JSON format' } },
      ]);

      let result = await summarizer.summarize(agentPlugin, { id: 'agt_test' }, 'ses_dm');
      assert.equal(result, '1. Always respond in JSON format');
    });

    it('should save summary to agent record', async () => {
      let frames = [
        { type: 'user-message', content: { text: 'Be brief' } },
        { type: 'message', content: { html: 'OK' } },
      ];

      let persistence = createMockFramePersistence(frames);
      let saved       = false;
      let agentRecord = {
        id:        'agt_test',
        dmSummary: null,
        save:      async () => { saved = true; },
      };

      let models = createMockModels();
      models.Agent._set('agt_test', agentRecord);

      let context = createMockContext({
        framePersistence: persistence,
        models,
      });

      let summarizer  = new DmSummarizer(context);
      let agentPlugin = createMockAgentPlugin([
        { type: 'message', content: { html: 'Keep responses brief' } },
      ]);

      await summarizer.summarize(agentPlugin, { id: 'agt_test' }, 'ses_dm');
      assert.ok(saved);
      assert.equal(agentRecord.dmSummary, 'Keep responses brief');
    });

    it('should concatenate multiple agent response blocks', async () => {
      let frames = [
        { type: 'user-message', content: { text: 'Configure me' } },
        { type: 'message', content: { html: 'OK' } },
      ];

      let persistence = createMockFramePersistence(frames);
      let agentRecord = { id: 'agt_test', dmSummary: null, save: async () => {} };
      let models      = createMockModels();
      models.Agent._set('agt_test', agentRecord);

      let context = createMockContext({
        framePersistence: persistence,
        models,
      });

      let summarizer  = new DmSummarizer(context);
      let agentPlugin = createMockAgentPlugin([
        { type: 'message', content: { html: 'Part 1' } },
        { type: 'message', content: { html: 'Part 2' } },
      ]);

      let result = await summarizer.summarize(agentPlugin, { id: 'agt_test' }, 'ses_dm');
      assert.ok(result.includes('Part 1'));
      assert.ok(result.includes('Part 2'));
    });

    it('should throw if framePersistence is not on context', async () => {
      let context    = createMockContext({});
      let summarizer = new DmSummarizer(context);

      await assert.rejects(
        () => summarizer.summarize({}, {}, 'ses_test'),
        { message: 'framePersistence not available on context' },
      );
    });
  });
});
