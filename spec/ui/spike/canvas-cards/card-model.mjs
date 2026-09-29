'use strict';

const AGENT_NAMES = [
  'DeepSeek 1', 'Codex', 'Mr. Bennett', 'Iron-Hand', 'Gemini', 'Claude',
  'Scout', 'Archivist', 'Refactor Bot', 'QA Bot',
];

const USER_LINES = [
  'Can you look at the frame router and tell me where delivery duplicates?',
  'Add a spec for the compaction boundary.',
  'Why is the token count climbing so fast?',
  'Make the sidebar collapse into cards.',
  'Ship it after the tests are green.',
  'Give me a status update.',
];

const AGENT_LINES = [
  'I traced it to the queued placeholder commit. The router must use the frame version bound to each commit instead of the head at drain time.',
  'Added the spec; it fails first as expected, then passes after the fix.',
  'Compaction was throwing on every pass, so retries ballooned the heap until the process aborted.',
  'The card grid can use per-card offscreen canvases and composite with transform only.',
  'Tests are green: 372 pass, 0 fail.',
  'Reading the render path now; I will report the bubble layout plan shortly.',
];

const TOOL_LINES = [
  'exec: npm test',
  'read-file: src/core/routing/frame-router.mjs',
  'grep: responseFrameID',
  'write-file: src/shared/frame-manager.mjs',
  'todo-add: extract chat view',
];

const RANDOM_WORDS = [
  'routing', 'frames', 'compaction', 'tokens', 'canvas', 'bubbles', 'layout',
  'commit', 'stream', 'session', 'preview', 'thumbnail', 'grid', 'animation',
  'performance', 'budget', 'paint', 'offscreen', 'cache', 'measure',
];

function createRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function createCardModel(index = 0, seed = 1) {
  let random = createRandom(seed + index * 7919);
  let agentName = AGENT_NAMES[index % AGENT_NAMES.length];
  return {
    id: `session_${index}`,
    title: `Project ${Math.floor(index / 5) + 1} · Session ${index + 1}`,
    agentName,
    bubbles: [
      { role: 'user', text: USER_LINES[index % USER_LINES.length] },
      { role: 'agent', text: AGENT_LINES[index % AGENT_LINES.length], streaming: false },
      { role: 'tool', text: TOOL_LINES[index % TOOL_LINES.length] },
      { role: 'agent', text: 'Working through it now.', streaming: true },
    ],
    random,
    tick: 0,
  };
}

export function randomPhrase(card, wordCount = 3) {
  let words = [];
  for (let index = 0; index < wordCount; index++)
    words.push(RANDOM_WORDS[Math.floor(card.random() * RANDOM_WORDS.length)]);

  return words.join(' ');
}

export function tickCard(card, tick = 1) {
  card.tick += tick;
  let last = card.bubbles[card.bubbles.length - 1];

  if (!last.streaming)
    card.bubbles.push({ role: 'agent', text: randomPhrase(card), streaming: true });
  else
    last.text += ` ${randomPhrase(card, 2)}`;

  if (card.tick % 20 === 0 && card.bubbles.length > 0) {
    let index = Math.floor(card.random() * card.bubbles.length);
    card.bubbles[index] = {
      role: 'agent',
      text: `${randomPhrase(card, 6)}`,
      streaming: false,
    };
  }

  if (card.bubbles.length > 12)
    card.bubbles.splice(0, card.bubbles.length - 12);
}

export function buildCardModels(count = 30, seed = 1) {
  let cards = [];
  for (let index = 0; index < count; index++)
    cards.push(createCardModel(index, seed));

  return cards;
}
