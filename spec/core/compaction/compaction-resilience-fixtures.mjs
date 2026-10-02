'use strict';

// Shared fakes and fixtures for the compaction resilience specs. Fakes only —
// no real models are called. Kept out of the `*-spec.mjs` glob so it is a helper,
// not an independently reported test file.

import assert from 'node:assert/strict';

import { AgentInterface } from '../../../src/core/plugins/index.mjs';

export class MixedProvider extends AgentInterface {
  static pluginID = 'mixed';

  async ask(_prompt, params = {}) {
    params.services.calls.push({ method: 'mixed.ask', agentID: params.agent.id });
    return 'mixed compacted summary';
  }
}

export class ThrowingProvider extends AgentInterface {
  static pluginID = 'throwing';

  async ask() {
    throw new Error('provider exploded');
  }
}

export class EmptyProvider extends AgentInterface {
  static pluginID = 'empty';

  async ask() {
    return '';
  }
}

export class NoAskProvider extends AgentInterface {
  static pluginID = 'no-ask';
}

export class UntaggedProvider extends AgentInterface {
  static pluginID = 'untagged';

  async ask() {
    return 'plain untagged line one\nplain untagged line two';
  }
}

export class HighOnlyProvider extends AgentInterface {
  static pluginID = 'high-only';

  async ask() {
    return [ '[high]', 'Only must-keep material' ].join('\n');
  }
}

export function managerFor(agents) {
  return {
    async getAgent(agentID) {
      return agents.get(agentID) || null;
    },
    listModels() {
      return [];
    },
  };
}

export function windowOf(frameEngine, ids) {
  let frames = ids.map((id) => frameEngine.get(id));
  return {
    frames,
    startFrameID: ids[0],
    boundaryFrameID: ids[ids.length - 1],
    boundaryOrder: frames.at(-1)?.order ?? null,
    tokens: frames.length,
  };
}

export function lastEvent(events, type) {
  return events.filter((event) => event.type === type).at(-1) || null;
}

export async function assertNoUnhandledRejection(callback) {
  let seen = [];
  let handler = (reason) => { seen.push(reason); };
  process.on('unhandledRejection', handler);
  try {
    await callback();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  } finally {
    process.off('unhandledRejection', handler);
  }

  assert.deepEqual(seen, []);
}

export function frame(id, text, order) {
  return {
    id,
    type: 'UserMessage',
    sessionID: 'ses_1',
    interactionID: `int_${order}`,
    authorType: 'user',
    authorID: 'user',
    order,
    createdAt: order,
    updatedAt: order,
    timestamp: order,
    hidden: false,
    deleted: false,
    content: { text },
  };
}

export function userFrame(id, text, order) {
  return frame(id, text, order);
}

export function createClock() {
  let value = 0;
  return () => ++value;
}

export function createIDs(ids) {
  let values = ids.slice();
  let index = 0;
  return () => values.shift() || `id_${++index}`;
}
