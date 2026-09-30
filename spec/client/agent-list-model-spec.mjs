'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_MASTER_AGENTS,
  agentFilterLabel,
  agentFilterPills,
  filterAgents,
  rankMasters,
} from '../../src/client/components/agent-list-model.mjs';

const AGENTS = [
  { id: 'a', name: 'A', pluginID: 'codex-agent', enabled: true, crownedClock: null },
  { id: 'b', name: 'B', pluginID: 'codex-agent', enabled: false, crownedClock: null },
  { id: 'c', name: 'C', pluginID: 'ollama-agent', enabled: true, crownedClock: '0002' },
  { id: 'd', name: 'D', pluginID: 'google-agent', enabled: true, crownedClock: null },
];
const PROVIDERS = [
  { pluginID: 'codex-agent', displayName: 'Codex' },
  { pluginID: 'ollama-agent', displayName: 'Ollama' },
  { pluginID: 'google-agent', displayName: 'Gemini' },
];

test('agentFilterPills derives provider pills in first-seen order plus specials', () => {
  assert.deepEqual(agentFilterPills(AGENTS, PROVIDERS), [
    { id: 'all', label: 'All' },
    { id: 'masters', label: 'Masters' },
    { id: 'provider:codex-agent', label: 'Codex' },
    { id: 'provider:ollama-agent', label: 'Ollama' },
    { id: 'provider:google-agent', label: 'Gemini' },
    { id: 'hidden', label: 'Hidden' },
  ]);
});

test('agentFilterPills falls back to the pluginID when a provider is unknown', () => {
  let pills = agentFilterPills([ { id: 'x', pluginID: 'mystery' } ], []);
  assert.ok(pills.some((pill) => pill.id === 'provider:mystery' && pill.label === 'mystery'));
});

test('filterAgents filters by all, masters, hidden, and provider', () => {
  assert.deepEqual(filterAgents(AGENTS, 'all').map((agent) => agent.id), [ 'a', 'b', 'c', 'd' ]);
  assert.deepEqual(filterAgents(AGENTS, 'masters').map((agent) => agent.id), [ 'c' ]);
  assert.deepEqual(filterAgents(AGENTS, 'hidden').map((agent) => agent.id), [ 'b' ]);
  assert.deepEqual(filterAgents(AGENTS, 'provider:codex-agent').map((agent) => agent.id), [ 'a', 'b' ]);
  // Unknown filter returns everything (defensive default).
  assert.deepEqual(filterAgents(AGENTS, 'nonsense').map((agent) => agent.id), [ 'a', 'b', 'c', 'd' ]);
});

test('agentFilterLabel resolves the active pill label', () => {
  assert.equal(agentFilterLabel(AGENTS, PROVIDERS, 'masters'), 'Masters');
  assert.equal(agentFilterLabel(AGENTS, PROVIDERS, 'provider:google-agent'), 'Gemini');
  assert.equal(agentFilterLabel(AGENTS, PROVIDERS, 'missing'), 'All');
});

test('rankMasters keeps only the newest three crowns, newest first', () => {
  let crowned = [];
  for (let index = 1; index <= 5; index++)
    crowned.push({ id: `m${index}`, crownedClock: String(index).padStart(4, '0'), crownedAt: index });

  let ranked = rankMasters(crowned);
  assert.equal(ranked.length, MAX_MASTER_AGENTS);
  assert.deepEqual(ranked.map((agent) => agent.id), [ 'm5', 'm4', 'm3' ]);
});

test('masters filter returns only the top three crowned agents', () => {
  let agents = [];
  for (let index = 1; index <= 4; index++)
    agents.push({ id: `m${index}`, pluginID: 'codex-agent', enabled: true, crownedClock: String(index).padStart(4, '0'), crownedAt: index });

  assert.deepEqual(filterAgents(agents, 'masters').map((agent) => agent.id), [ 'm4', 'm3', 'm2' ]);
});
