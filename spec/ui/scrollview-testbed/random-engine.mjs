'use strict';

// Deterministic random chat history for the scrollview testbed. Items are
// generated from (seed, index), so a page can be fetched at any time and the
// same item always comes back identically. That is the testbed's stand-in for a
// server-side head index.

const WORDS = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
  'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore',
  'magna', 'aliqua', 'enim', 'ad', 'minim', 'veniam', 'quis', 'nostrud',
  'exercitation', 'ullamco', 'laboris', 'nisi', 'aliquip', 'ex', 'ea', 'commodo',
  'consequat', 'duis', 'aute', 'irure', 'in', 'reprehenderit', 'voluptate',
  'velit', 'esse', 'cillum', 'eu', 'fugiat', 'nulla', 'pariatur', 'excepteur',
  'sint', 'occaecat', 'cupidatat', 'non', 'proident', 'sunt', 'culpa', 'qui',
  'officia', 'deserunt', 'mollit', 'anim', 'id', 'est', 'laborum',
];

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

export function createLoremEngine({
  seed = 0xC0FFEE,
  total = 17000,
  pageSize = 40,
  latencyMs = 220,
  failureRate = 0,
} = {}) {
  let random = mulberry32(seed);
  let state = {
    seed,
    total,
    pageSize,
    latencyMs,
    failureRate,
    revision: 1,
    requests: 0,
    failures: 0,
    itemCache: new Map(),
    updates: new Map(),
  };

  function word() {
    return WORDS[Math.floor(random() * WORDS.length)];
  }

  function sentence(words = 10) {
    let parts = [];
    for (let index = 0; index < words; index++)
      parts.push(word());
    let text = parts.join(' ');
    return text.charAt(0).toUpperCase() + text.slice(1) + '.';
  }

  function paragraph(words = 40) {
    let sentences = [];
    let remaining = words;
    while (remaining > 0) {
      let count = Math.min(remaining, 6 + Math.floor(random() * 10));
      sentences.push(sentence(count));
      remaining -= count;
    }
    return sentences.join(' ');
  }

  function itemAt(index) {
    let key = `item-${state.seed}-${index}`;
    if (state.itemCache.has(key))
      return state.itemCache.get(key);
    let source = mulberry32((state.seed ^ (index * 2654435761)) >>> 0);
    let roll = source();
    let role = roll < 0.42 ? 'user' : roll < 0.9 ? 'agent' : 'system';
    let kind = 'text';
    let text = paragraph(10 + Math.floor(source() * 80));
    if (role === 'agent' && source() < 0.18) {
      kind = 'code';
      text = `export function demo${index}(value) {\n  const result = value * ${Math.floor(source() * 100)};\n  return result;\n}\n\n// ${sentence(8)}`;
    } else if (role === 'agent' && source() < 0.12) {
      kind = 'list';
      text = Array.from({ length: 4 + Math.floor(source() * 6) }, (_value, itemIndex) => `- ${sentence(5 + itemIndex)}`).join('\n');
    } else if (role === 'user' && source() < 0.2) {
      text = sentence(5 + Math.floor(source() * 14));
    }
    let baseHeight = role === 'user' ? 72 : kind === 'code' ? 150 : kind === 'list' ? 130 : 96;
    let item = {
      key,
      id: key,
      index,
      role,
      kind,
      title: role === 'user' ? 'You' : role === 'system' ? 'System' : `Agent ${1 + (index % 4)}`,
      text,
      revision: state.updates.get(key)?.revision || 0,
      estimatedHeight: baseHeight + Math.round(source() * 40),
    };
    state.itemCache.set(key, item);
    return item;
  }

  async function loadPage({ start = 0, end = start + state.pageSize } = {}) {
    state.requests++;
    let delay = state.latencyMs > 0 ? state.latencyMs * (0.6 + random() * 0.8) : 0;
    if (delay > 0)
      await new Promise((resolve) => setTimeout(resolve, delay));
    if (state.failureRate > 0 && random() < state.failureRate) {
      state.failures++;
      throw new Error(`Simulated page load failure for ${start}-${end}`);
    }
    let from = Math.max(0, Math.trunc(start));
    let to = Math.min(state.total, Math.max(from, Math.trunc(end)));
    let items = [];
    for (let index = from; index < to; index++)
      items.push(itemAt(index));
    return {
      start: from,
      end: to,
      items,
      total: state.total,
      hasMoreOlder: from > 0,
      hasMoreNewer: to < state.total,
    };
  }

  function append(role = 'agent') {
    let index = state.total;
    state.total++;
    let key = `item-${state.seed}-${index}`;
    let item = {
      key,
      id: key,
      index,
      role,
      kind: 'text',
      title: role === 'user' ? 'You' : 'Agent 4',
      text: sentence(8 + Math.floor(random() * 20)),
      revision: 0,
      estimatedHeight: role === 'user' ? 72 : 92,
    };
    state.itemCache.set(key, item);
    return item;
  }

  function updateRandom() {
    if (state.total === 0)
      return null;
    let index = Math.floor(random() * state.total);
    let item = itemAt(index);
    let revision = item.revision + 1;
    let updated = {
      ...item,
      text: `${item.text}\n\n${paragraph(10 + Math.floor(random() * 40))}`,
      revision,
      estimatedHeight: item.estimatedHeight + 24,
    };
    state.itemCache.set(item.key, updated);
    state.updates.set(item.key, updated);
    return updated;
  }

  function streamLast(words = 8) {
    if (state.total === 0)
      return null;
    let index = state.total - 1;
    let item = itemAt(index);
    let revision = item.revision + 1;
    let updated = {
      ...item,
      text: `${item.text} ${sentence(words)}`,
      revision,
      estimatedHeight: item.estimatedHeight + 8,
    };
    state.itemCache.set(item.key, updated);
    state.updates.set(item.key, updated);
    return updated;
  }

  function reset(overrides = {}) {
    state = {
      ...state,
      total: overrides.total ?? 17000,
      pageSize: overrides.pageSize ?? state.pageSize,
      latencyMs: overrides.latencyMs ?? state.latencyMs,
      failureRate: overrides.failureRate ?? state.failureRate,
      revision: state.revision + 1,
      requests: 0,
      failures: 0,
      itemCache: new Map(),
      updates: new Map(),
    };
    random = mulberry32(state.seed);
  }

  return {
    get total() { return state.total; },
    get pageSize() { return state.pageSize; },
    get latencyMs() { return state.latencyMs; },
    set latencyMs(value) { state.latencyMs = Math.max(0, Number(value) || 0); },
    get failureRate() { return state.failureRate; },
    set failureRate(value) { state.failureRate = Math.min(1, Math.max(0, Number(value) || 0)); },
    get revision() { return state.revision; },
    get requests() { return state.requests; },
    get failures() { return state.failures; },
    itemAt,
    loadPage,
    append,
    updateRandom,
    streamLast,
    reset,
  };
}
