'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { MentionFramePlugin } from '../../../src/core/mentions/index.mjs';
import { BaseFramePlugin, FrameRouter } from '../../../src/core/routing/index.mjs';
import { FrameEngine } from '../../../src/core/frames/index.mjs';

test('MentionFramePlugin attaches resolved actor mentions before lower-priority plugins run', async () => {
  let observedFrames = [];
  class ObserverPlugin extends BaseFramePlugin {
    async process(next) {
      observedFrames.push(this.context.newFrame);
      await next(this.context);
    }
  }

  let frames = new FrameEngine({
    clock: () => 1000,
    idGenerator: idSequence([ 'commit_1', 'commit_2' ]),
  });
  let router = new FrameRouter({ logger: quietLogger() });
  router.registerSelector('Type:UserMessage', MentionFramePlugin, MentionFramePlugin.pluginID);
  router.registerSelector('Type:UserMessage', ObserverPlugin, 'observer');
  router.connectTo(frames, { id: 'ses_1' }, {
    services: {
      agentManager: {
        async resolveAgent(reference) {
          if (reference === 'agent-1') {
            return {
              id: 'agent-1',
              name: 'Coordinator',
              pluginID: 'test-agent',
            };
          }

          if (reference === 'Test Agent') {
            return {
              id: 'agent-2',
              name: 'Test Agent',
              pluginID: 'test-agent',
            };
          }

          let error = new Error(`Agent not found: ${reference}`);
          error.status = 404;
          throw error;
        },
      },
      actorResolver: {
        async resolveActor(reference) {
          if (reference !== 'Ada Lovelace')
            return null;

          return {
            id: 'user-1',
            type: 'user',
            username: 'ada',
            fullName: 'Ada Lovelace',
          };
        },
      },
    },
  });

  frames.merge([{
    id: 'msg_1',
    type: 'UserMessage',
    sessionID: 'ses_1',
    interactionID: 'int_1',
    authorType: 'user',
    content: {
      text: 'Please ask @agent-1, @\'Test Agent\', and @"Ada Lovelace"; ignore wyatt@example.com.',
    },
    hidden: false,
  }]);
  await router.flush();

  assert.equal(observedFrames.length, 1);
  assert.deepEqual(observedFrames[0].mentions, {
    'agent-1': {
      id: 'agent-1',
      type: 'agent',
      name: 'Coordinator',
      username: null,
      fullName: 'Coordinator',
      reference: 'agent-1',
    },
    'agent-2': {
      id: 'agent-2',
      type: 'agent',
      name: 'Test Agent',
      username: null,
      fullName: 'Test Agent',
      reference: 'Test Agent',
    },
    'user-1': {
      id: 'user-1',
      type: 'user',
      name: 'ada',
      username: 'ada',
      fullName: 'Ada Lovelace',
      reference: 'Ada Lovelace',
    },
  });
  assert.deepEqual(frames.get('msg_1').mentions, observedFrames[0].mentions);
  assert.equal(frames.getLatestCommit().silent, true);
});

test('MentionFramePlugin skips unknown mentions and avoids redundant frame updates', async () => {
  let frames = new FrameEngine({
    clock: () => 1000,
    idGenerator: idSequence([ 'commit_1' ]),
  });
  let router = new FrameRouter({ logger: quietLogger() });
  router.registerSelector('Type:UserMessage', MentionFramePlugin, MentionFramePlugin.pluginID);
  router.connectTo(frames, { id: 'ses_1' }, {
    services: {
      agentManager: {
        async resolveAgent() {
          let error = new Error('not found');
          error.status = 404;
          throw error;
        },
      },
    },
  });

  frames.merge([{
    id: 'msg_1',
    type: 'UserMessage',
    sessionID: 'ses_1',
    interactionID: 'int_1',
    content: { text: 'Unknown @nobody' },
  }]);
  await router.flush();

  assert.equal(frames.get('msg_1').mentions, undefined);
  assert.equal(frames.getCommits().length, 1);
});

function idSequence(ids) {
  let next = ids.slice();
  return () => next.shift() || `id_${next.length}`;
}

function quietLogger() {
  return {
    error() {},
    warn() {},
    log() {},
  };
}
