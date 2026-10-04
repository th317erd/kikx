'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentInterface } from '../../../src/core/plugins/agent-interface.mjs';
import {
  SESSION_SYSTEM_PROMPT,
  buildModelMessages,
  frameToModelTurn,
} from '../../../src/core/plugins/agent-model-context.mjs';
import {
  BRIEF_FORBIDDEN_PHRASES,
  buildMessageBrief,
  buildStartBrief,
  findForbiddenBriefPhrase,
} from '../../../src/core/plugins/agent-script-template.mjs';
import {
  AGIS_PRECEPTS_LINES,
  START_BRIEF_BANNER_PREFIX,
  packageVersion,
} from '../../../src/core/plugins/agent-precepts.mjs';

function startBriefMessages(messages) {
  return messages.filter((message) => typeof message.content === 'string'
    && message.content.startsWith(START_BRIEF_BANNER_PREFIX));
}

function messageBriefMessages(messages) {
  return messages.filter((message) => typeof message.content === 'string'
    && message.content.startsWith('Message from '));
}

test('frameToModelTurn maps a UserMessage to a user turn', () => {
  let turn = frameToModelTurn({ id: 'f1', type: 'UserMessage', content: { text: 'hello' } });
  assert.deepEqual(turn, { role: 'user', content: 'hello' });
});

test('frameToModelTurn maps an own AgentMessage to assistant and another agent to user', () => {
  let own = frameToModelTurn(
    { id: 'f1', type: 'AgentMessage', authorID: 'agent_1', content: { text: 'mine' } },
    { currentAgentID: 'agent_1' },
  );
  assert.deepEqual(own, { role: 'assistant', content: 'mine' });

  let other = frameToModelTurn(
    { id: 'f2', type: 'AgentMessage', authorID: 'agent_2', authorDisplayName: 'Mr. Bennett', content: { text: 'theirs' } },
    { currentAgentID: 'agent_1' },
  );
  assert.equal(other.role, 'user');
  assert.match(other.content, /<agent-message source="agent_2" display-name="Mr\. Bennett">theirs<\/agent-message>/);
});

test('frameToModelTurn maps a CommandResult to a user turn', () => {
  let turn = frameToModelTurn({ id: 'f1', type: 'CommandResult', content: { text: 'ok' } });
  assert.deepEqual(turn, { role: 'user', content: '[System command result]\nok' });
});

test('frameToModelTurn projects a hidden CompactionFrame summary into a user turn', () => {
  let turn = frameToModelTurn({
    id: 'cmp_1',
    type: 'CompactionFrame',
    hidden: true,
    content: { kind: 'compaction_frame', status: 'complete', summary: 'Earlier the user asked about deploys.' },
  });
  assert.equal(turn.role, 'user');
  assert.match(turn.content, /Compacted context memory/);
  assert.match(turn.content, /Earlier the user asked about deploys\./);
  // Re-projection guidance tells a small model how to treat priority tags.
  assert.match(turn.content, /priority-tagged/);
  assert.match(turn.content, /Never drop \[high\]/);
});

test('frameToModelTurn recognizes a compaction frame by content.kind alone', () => {
  let turn = frameToModelTurn({
    id: 'cmp_2',
    type: 'Internal',
    hidden: true,
    content: { kind: 'compaction_frame', summary: 'by kind' },
  });
  assert.match(turn?.content || '', /by kind/);
});

test('frameToModelTurn falls back to content.text for a compaction frame with no summary', () => {
  let turn = frameToModelTurn({
    id: 'cmp_3',
    type: 'CompactionFrame',
    hidden: true,
    content: { kind: 'compaction_frame', text: 'fallback text' },
  });
  assert.match(turn?.content || '', /fallback text/);
});

test('frameToModelTurn drops other hidden, deleted, empty, and unknown frames', () => {
  assert.equal(frameToModelTurn({ id: 'f1', type: 'UserMessage', hidden: true, content: { text: 'x' } }), null);
  assert.equal(frameToModelTurn({ id: 'f2', type: 'UserMessage', deleted: true, content: { text: 'x' } }), null);
  assert.equal(frameToModelTurn({ id: 'f3', type: 'UserMessage', content: { text: '   ' } }), null);
  assert.equal(frameToModelTurn({ id: 'f4', type: 'AgentProgress', content: { text: 'x' } }), null);
  assert.equal(frameToModelTurn(null), null);
});

test('Brief A carries the version banner, precepts, tools, and behavior', () => {
  let { text } = buildStartBrief({
    agent: { id: 'agent_1', name: 'Gemma', character: 'You are terse.' },
    isCoordinator: false,
    session: {
      id: 'ses_1',
      participantAgentIDs: [ 'agent_1' ],
      participantUserIDs: [ 'usr_1' ],
      coordinatorAgentID: 'agent_1',
    },
  });

  assert.ok(text.startsWith(`${START_BRIEF_BANNER_PREFIX}${packageVersion()}`));
  assert.match(text, /Character: You are terse\./);
  assert.match(text, /Precepts — always on/);
  assert.match(text, /Orient:/);
  assert.match(text, /Proof: never claim done/i);
  assert.match(text, /agent-respond-and-continue/);
  assert.match(text, /Delegation: agent-list/);
  assert.match(text, /Behavior:/);
  // 2-party session (1 agent + 1 user): no coordinator preamble.
  assert.doesNotMatch(text, /COORDINATOR PREAMBLE/);
});

test('Brief A prefers the compressed character and falls back to the full character', () => {
  let session = {
    id: 'ses_1',
    participantAgentIDs: [ 'agent_1' ],
    participantUserIDs: [ 'usr_1' ],
    coordinatorAgentID: 'agent_1',
  };

  // Compressed value present: Brief A uses it, not the full character.
  let compressed = buildStartBrief({
    agent: {
      id: 'agent_1',
      name: 'Gemma',
      character: 'You are terse but verbose when explaining things at length.',
      characterCompressed: 'Terse.',
    },
    isCoordinator: false,
    session,
  }).text;
  assert.match(compressed, /Character: Terse\./);
  assert.doesNotMatch(compressed, /verbose when explaining/);

  // Historical alias still works for pre-P6 records.
  let aliased = buildStartBrief({
    agent: { id: 'agent_1', name: 'Gemma', character: 'Full.', shortCharacter: 'Short.' },
    isCoordinator: false,
    session,
  }).text;
  assert.match(aliased, /Character: Short\./);

  // No compressed value: fall back to the full character (back-compat).
  let fallback = buildStartBrief({
    agent: { id: 'agent_1', name: 'Gemma', character: 'You are terse.' },
    isCoordinator: false,
    session,
  }).text;
  assert.match(fallback, /Character: You are terse\./);
});

test('Brief A includes the coordinator preamble only for the coordinator with 3+ parties', () => {
  let multiparty = {
    agent: { id: 'agent_1', name: 'Kikx' },
    isCoordinator: true,
    session: {
      id: 'ses_1',
      participantAgentIDs: [ 'agent_1', 'agent_2' ],
      participantUserIDs: [ 'usr_1' ],
      coordinatorAgentID: 'agent_1',
    },
  };

  // 3 parties counting the user (D3) and the assigned coordinator.
  assert.match(buildStartBrief(multiparty).text, /COORDINATOR PREAMBLE/);
  // A non-coordinator never gets it.
  assert.doesNotMatch(buildStartBrief({ ...multiparty, isCoordinator: false }).text, /COORDINATOR PREAMBLE/);
  // Two parties (1 user + 1 agent) suppress it entirely.
  assert.doesNotMatch(buildStartBrief({
    ...multiparty,
    session: {
      id: 'ses_2',
      participantAgentIDs: [ 'agent_1' ],
      participantUserIDs: [ 'usr_1' ],
      coordinatorAgentID: 'agent_1',
    },
  }).text, /COORDINATOR PREAMBLE/);
});

test('Brief B renders microsecond frame timestamps as a sane ISO date', () => {
  // Frame timestamps are Unix microseconds; a bug treated them as milliseconds
  // and produced a year ~58600. The header must show the real 2026 date.
  let micros = 1_790_918_811_000_000;
  let { text } = buildMessageBrief({
    frame: {
      id: 'msg_1', type: 'UserMessage', authorType: 'user',
      authorDisplayName: 'Save Test 544', authorID: 'usr_1',
      timestamp: micros, content: { text: 'Hello!' },
    },
    agent: { id: 'agent_1', name: 'Gemma' },
    session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ], coordinatorAgentID: 'agent_1' },
  });
  let header = text.split('\n')[0];
  assert.match(header, /^Message from Save Test 544 2026-/);
  assert.doesNotMatch(header, /058\d\d/);
});

test('Brief B carries sender, message, and compact dynamic state', () => {
  let { text } = buildMessageBrief({
    frame: {
      id: 'msg_1',
      type: 'UserMessage',
      authorType: 'user',
      authorDisplayName: 'Wyatt Greenway',
      authorID: 'usr_1',
      timestamp: Date.UTC(2026, 9, 1),
      content: { text: 'How are you Gemma?' },
    },
    agent: { id: 'agent_1', name: 'Gemma' },
    isCoordinator: true,
    cwdState: { cwd: '/tmp/kikx-work' },
    todoState: { items: [ { id: 't1' }, { id: 't2' } ] },
    session: {
      id: 'ses_1',
      participantAgentIDs: [ 'agent_1' ],
      participantUserIDs: [ 'usr_1', 'usr_2' ],
      coordinatorAgentID: 'agent_1',
    },
  });

  assert.ok(text.startsWith('Message from Wyatt Greenway '));
  assert.match(text, /How are you Gemma\?/);
  assert.match(text, /todo:    2 item\(s\); review with todo\.list/);
  assert.match(text, /cwd:     \/tmp\/kikx-work/);
  assert.match(text, /coord:   true/);
  assert.match(text, /parties: .*agent_1.* - Coordinator/);
  assert.match(text, /usr_1/);
  assert.match(text, /Answer, or agent-null-response to stay silent\./);
});

test('buildModelMessages assembles system, Brief A (once), history (sans trigger), then Brief B', () => {
  let messages = buildModelMessages({
    prompt: 'newest question',
    frame: { id: 'trigger', type: 'UserMessage', authorType: 'user', authorID: 'usr_1', content: { text: 'newest question' } },
    agent: { id: 'agent_1' },
    session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ], coordinatorAgentID: 'agent_1' },
    frames: [
      { id: 'cmp_1', type: 'CompactionFrame', hidden: true, content: { kind: 'compaction_frame', summary: 'old memory' } },
      { id: 'old_user', type: 'UserMessage', content: { text: 'older turn' } },
      { id: 'trigger', type: 'UserMessage', content: { text: 'newest question' } },
    ],
  });

  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, SESSION_SYSTEM_PROMPT);
  // Brief A appears exactly once, before history.
  assert.equal(startBriefMessages(messages).length, 1);
  let briefAIndex = messages.findIndex((message) => message.role === 'user'
    && typeof message.content === 'string' && message.content.startsWith(START_BRIEF_BANNER_PREFIX));
  let historyIndex = messages.findIndex((message) => message.content === 'older turn');
  assert.ok(briefAIndex < historyIndex, 'Brief A precedes history');
  // Brief B is the final user turn and the message appears exactly once.
  assert.equal(messageBriefMessages(messages).length, 1);
  assert.match(messages.at(-1).content, /Message from /);
  assert.match(messages.at(-1).content, /newest question/);
  assert.equal(messages.filter((m) => typeof m.content === 'string' && m.content === 'newest question').length, 0);
  assert.equal(messages.filter((m) => typeof m.content === 'string' && m.content.includes('newest question')).length, 1);
});

test('buildModelMessages filters compaction levels by the available context window', () => {
  let compactionFrame = {
    id: 'cmp_1',
    type: 'CompactionFrame',
    hidden: true,
    content: {
      kind: 'compaction_frame',
      status: 'complete',
      summary: '[high]\nkeep /tmp/project\n[medium]\nrationale\n[low]\nchatter',
      summaryJSON: {
        high: [ 'keep /tmp/project' ],
        medium: [ 'rationale' ],
        low: [ 'chatter' ],
        unstructured: false,
      },
    },
  };
  let base = {
    agent: { id: 'agent_1' },
    session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ], coordinatorAgentID: 'agent_1' },
    frame: { id: 'trigger', type: 'UserMessage', authorType: 'user', content: { text: 'next' } },
    frames: [ compactionFrame, { id: 'trigger', type: 'UserMessage', content: { text: 'next' } } ],
  };

  // Small window (explicit params.contextWindow): [low] and [medium] dropped.
  let small = buildModelMessages({ ...base, contextWindow: 8192 });
  let smallMemory = small.find((message) => typeof message.content === 'string' && message.content.includes('Compacted context memory'));
  assert.match(smallMemory.content, /keep \/tmp\/project/);
  assert.doesNotMatch(smallMemory.content, /rationale/);
  assert.doesNotMatch(smallMemory.content, /chatter/);

  // Window via config.contextWindowTokens works too.
  let fromConfig = buildModelMessages({ ...base, config: { contextWindowTokens: 8192 } });
  let configMemory = fromConfig.find((message) => typeof message.content === 'string' && message.content.includes('Compacted context memory'));
  assert.doesNotMatch(configMemory.content, /chatter/);

  // Large window: unchanged in meaning (all levels present).
  let large = buildModelMessages({ ...base, contextWindow: 200000 });
  let largeMemory = large.find((message) => typeof message.content === 'string' && message.content.includes('Compacted context memory'));
  assert.match(largeMemory.content, /keep \/tmp\/project/);
  assert.match(largeMemory.content, /rationale/);
  assert.match(largeMemory.content, /chatter/);
});

test('buildModelMessages projects an unknown-window compaction summary unfiltered', () => {
  let messages = buildModelMessages({
    agent: { id: 'agent_1' },
    session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ], coordinatorAgentID: 'agent_1' },
    frame: { id: 'trigger', type: 'UserMessage', authorType: 'user', content: { text: 'next' } },
    frames: [{
      id: 'cmp_1',
      type: 'CompactionFrame',
      hidden: true,
      content: {
        kind: 'compaction_frame',
        summaryJSON: { high: [ 'keep' ], medium: [ 'maybe' ], low: [ 'drop' ], unstructured: false },
      },
    }, { id: 'trigger', type: 'UserMessage', content: { text: 'next' } }],
  });
  let memory = messages.find((message) => typeof message.content === 'string' && message.content.includes('Compacted context memory'));
  assert.match(memory.content, /drop/);
});

test('buildModelMessages uses the triggering frame text when no prompt is supplied', () => {
  let messages = buildModelMessages({
    frame: { id: 'trigger', type: 'UserMessage', authorType: 'user', content: { text: 'from frame' } },
    frames: [],
  });
  assert.match(messages.at(-1).content, /Message from /);
  assert.match(messages.at(-1).content, /from frame/);
});

test('buildModelMessages sends Brief A only once across a multi-turn restart boundary', () => {
  let session = {
    id: 'ses_multi',
    participantAgentIDs: [ 'agent_1' ],
    participantUserIDs: [ 'usr_1' ],
    coordinatorAgentID: 'agent_1',
  };
  let base = {
    agent: { id: 'agent_1' },
    session,
  };
  let priorAgentMessage = {
    id: 'agent_msg_1',
    type: 'AgentMessage',
    authorID: 'agent_1',
    order: 3,
    content: { text: 'prior answer' },
  };

  // Turn 1: no prior agent message -> Brief A.
  let first = buildModelMessages({
    ...base,
    frame: { id: 'msg_1', type: 'UserMessage', authorType: 'user', authorID: 'usr_1', content: { text: 'first' } },
    frames: [],
  });
  assert.equal(startBriefMessages(first).length, 1);

  // Turn 2: a prior agent message and no new boundary -> no Brief A.
  let second = buildModelMessages({
    ...base,
    frame: { id: 'msg_2', type: 'UserMessage', authorType: 'user', authorID: 'usr_1', content: { text: 'second' } },
    frames: [ priorAgentMessage ],
  });
  assert.equal(startBriefMessages(second).length, 0);
  assert.equal(messageBriefMessages(second).length, 1);

  // Post-compaction: a boundary newer than the newest agent message -> Brief A.
  let third = buildModelMessages({
    ...base,
    frame: { id: 'msg_3', type: 'UserMessage', authorType: 'user', authorID: 'usr_1', content: { text: 'third' } },
    frames: [
      { id: 'cmp_1', type: 'CompactionFrame', hidden: true, order: 4, content: { kind: 'compaction_frame', boundaryOrder: 4, summary: 'memory' } },
      priorAgentMessage,
    ],
  });
  assert.equal(startBriefMessages(third).length, 1);
});

test('buildModelMessages keeps raw one-shot/compaction prompts verbatim', () => {
  let messages = buildModelMessages({
    prompt: 'compaction instructions',
    rawPrompt: true,
    compaction: true,
    agent: { id: 'agent_1' },
    session: { id: 'ses_cmp', participantAgentIDs: [ 'agent_1' ], coordinatorAgentID: 'agent_1' },
    frames: [],
  });

  assert.equal(startBriefMessages(messages).length, 0);
  assert.equal(messages.length, 2);
  assert.equal(messages.at(-1).content, 'compaction instructions');
});

test('AgentInterface exposes the shared projection', () => {
  assert.equal(typeof AgentInterface.buildModelMessages, 'function');
  assert.equal(typeof AgentInterface.frameToModelTurn, 'function');
  assert.equal(AgentInterface.SESSION_SYSTEM_PROMPT, SESSION_SYSTEM_PROMPT);

  // Deterministic context: an explicit frame timestamp keeps Brief B stable. Each
  // call gets a fresh session object so the per-agent "Brief A sent" marker from
  // the first call does not suppress Brief A in the second.
  let makeParams = () => ({
    agent: { id: 'agent_1' },
    session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ], coordinatorAgentID: 'agent_1' },
    frame: { id: 'msg_1', type: 'UserMessage', authorType: 'user', authorID: 'usr_1', timestamp: 1000, content: { text: 'p' } },
    frames: [],
  });
  assert.deepEqual(
    AgentInterface.buildModelMessages(makeParams()),
    buildModelMessages(makeParams()),
  );
});

test('the assembled two-tier brief never feeds token usage to the model (P8.1)', () => {
  // A distinctive sentinel avoids colliding with the wall-clock timestamp that
  // Brief B embeds (a plain `42` can appear in the seconds/minutes); pinning the
  // frame timestamp keeps the assembly deterministic regardless of run time.
  let sentinel = 987654321;
  let messages = buildModelMessages({
    prompt: 'How are you?',
    agent: { id: 'agent_1' },
    session: { id: 'ses_1', participantAgentIDs: [ 'agent_1' ], coordinatorAgentID: 'agent_1' },
    frame: {
      id: 'msg_1', type: 'UserMessage', authorType: 'user', authorID: 'usr_1',
      timestamp: 1_790_918_811_000_000, content: { text: 'How are you?' },
    },
    frames: [],
    tokenUsage: { 'openai/chatgpt/codex-agent': { tokensUsed: sentinel } },
    totalTokensUsed: sentinel,
  });

  let assembled = messages.map((message) => message.content).join('\n');
  assert.doesNotMatch(assembled, /token\s*usage/i);
  assert.doesNotMatch(assembled, /tokenUsage/i);
  assert.doesNotMatch(assembled, /totalTokensUsed/i);
  assert.equal(assembled.includes(String(sentinel)), false);
});

test('the built briefs reject stop-inducing and FOMO language (P8.3)', () => {
  assert.ok(BRIEF_FORBIDDEN_PHRASES.includes('stop'));
  assert.ok(BRIEF_FORBIDDEN_PHRASES.includes('fear of missing out'));

  let session = {
    id: 'ses_1',
    participantAgentIDs: [ 'agent_1', 'agent_2' ],
    participantUserIDs: [ 'usr_1' ],
    coordinatorAgentID: 'agent_1',
  };
  let startBrief = buildStartBrief({
    agent: { id: 'agent_1', name: 'Kikx' },
    isCoordinator: true,
    session,
  }).text;
  let messageBrief = buildMessageBrief({
    frame: { id: 'msg_1', type: 'UserMessage', authorType: 'user', authorID: 'usr_1', content: { text: 'go' } },
    agent: { id: 'agent_1' },
    isCoordinator: true,
    session,
  }).text;

  for (let brief of [ startBrief, messageBrief ])
    assert.equal(findForbiddenBriefPhrase(brief), null, `no forbidden phrase in brief: ${findForbiddenBriefPhrase(brief)}`);

  // The detector itself is meaningful: it flags a planted phrase.
  assert.equal(findForbiddenBriefPhrase('We must avoid fear of missing out.'), 'fear of missing out');
});
