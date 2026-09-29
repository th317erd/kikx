'use strict';

import { buildCardModels, tickCard } from './card-model.mjs';
import { createCanvasMiniCard } from './canvas-mini-card.mjs';
import { createHtmlMiniCard } from './html-mini-card.mjs';

const params = new URLSearchParams(location.search);
const CARD_COUNT = Number(params.get('cards') || 30);
const UPDATE_HZ = Number(params.get('hz') || 10);
const HEAVY_CONTENT = () => `paragraph: ${'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(4)}`;

const grid = document.querySelector('#grid');
const modeSelect = document.querySelector('#mode');
const fpsReadout = document.querySelector('#fps');
const frameReadout = document.querySelector('#frame');
const cardsReadout = document.querySelector('#cards');
const renderReadout = document.querySelector('#render');

let mode = params.get('mode') || 'canvas';
let heavy = params.get('heavy') === '1';
let cards = [];
let lastFrame = performance.now();
let frameTimes = [];
let workTimes = [];
let renderTimes = [];
let tickAccumulator = 0;
let running = true;

let loafSupported = false;
let loafEntries = [];
try {
  let observer = new PerformanceObserver((list) => {
    for (let entry of list.getEntries())
      loafEntries.push(entry);
  });
  observer.observe({ type: 'long-animation-frame', buffered: true });
  loafSupported = true;
} catch (_error) {
  loafSupported = false;
}

function buildCards() {
  let models = buildCardModels(CARD_COUNT);
  if (heavy) {
    for (let card of models) {
      for (let index = 0; index < 8; index++) {
        card.bubbles.push({
          role: index % 3 === 0 ? 'user' : index % 3 === 1 ? 'agent' : 'tool',
          text: HEAVY_CONTENT(),
          streaming: false,
        });
      }
    }
  }

  return models;
}

function render() {
  for (let card of cards)
    card.renderer.draw();
}

function rebuild() {
  grid.textContent = '';
  grid.classList.toggle('spike-grid--heavy', heavy);

  for (let card of cards) {
    let renderer = mode === 'html' ? createHtmlMiniCard(card) : createCanvasMiniCard(card);
    card.renderer = renderer;
    grid.appendChild(renderer.element);
  }

  cardsReadout.textContent = String(cards.length);
  render();
}

function setScenario(nextMode, nextHeavy) {
  mode = nextMode;
  heavy = nextHeavy;
  modeSelect.value = nextMode;
  cards = buildCards();
  rebuild();
}

function forceLayout() {
  if (mode !== 'html')
    return 0;

  let start = performance.now();
  let total = 0;
  for (let card of cards)
    total += card.renderer.element.offsetHeight;

  return performance.now() - start;
}

function frame(now) {
  if (!running)
    return;

  let delta = now - lastFrame;
  lastFrame = now;
  frameTimes.push(delta);
  if (frameTimes.length > 240)
    frameTimes.shift();

  let updateInterval = 1000 / UPDATE_HZ;
  tickAccumulator += delta;
  let updated = false;
  while (tickAccumulator >= updateInterval) {
    tickAccumulator -= updateInterval;
    for (let card of cards)
      tickCard(card, 1);
    updated = true;
  }

  if (updated) {
    let workStart = performance.now();
    render();
    let layoutMs = forceLayout();
    let workMs = performance.now() - workStart;
    workTimes.push(workMs);
    if (workTimes.length > 240)
      workTimes.shift();
    if (layoutMs > 0) {
      renderTimes.push(layoutMs);
      if (renderTimes.length > 240)
        renderTimes.shift();
    }
  }

  let average = frameTimes.reduce((sum, value) => sum + value, 0) / (frameTimes.length || 1);
  fpsReadout.textContent = (1000 / average).toFixed(1);
  frameReadout.textContent = `frame avg ${average.toFixed(2)}ms · p95 ${percentile(frameTimes, 0.95).toFixed(2)}ms · work p95 ${percentile(workTimes, 0.95).toFixed(2)}ms`;
  renderReadout.textContent = `layout p95 ${percentile(renderTimes, 0.95).toFixed(2)}ms · loaf p95 ${loafPercentile(0.95).toFixed(1)}ms (${loafEntries.length})`;

  requestAnimationFrame(frame);
}

function percentile(values, ratio) {
  if (values.length === 0)
    return 0;

  let sorted = [ ...values ].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function loafPercentile(ratio) {
  if (loafEntries.length === 0)
    return 0;

  let durations = loafEntries.map((entry) => entry.duration).sort((a, b) => a - b);
  return durations[Math.min(durations.length - 1, Math.floor(durations.length * ratio))];
}

function snapshot() {
  let average = frameTimes.reduce((sum, value) => sum + value, 0) / (frameTimes.length || 1);
  let workAverage = workTimes.reduce((sum, value) => sum + value, 0) / (workTimes.length || 1);
  let loafDurations = loafEntries.map((entry) => entry.duration);
  return {
    label: `${mode}/${heavy ? 'heavy' : 'light'}`,
    mode,
    heavy,
    cards: cards.length,
    loafSupported,
    frames: frameTimes.length,
    workSamples: workTimes.length,
    averageFrameMs: average,
    p95FrameMs: percentile(frameTimes, 0.95),
    maxFrameMs: percentile(frameTimes, 1),
    averageWorkMs: workAverage,
    p95WorkMs: percentile(workTimes, 0.95),
    maxWorkMs: percentile(workTimes, 1),
    p95LayoutMs: percentile(renderTimes, 0.95),
    loafCount: loafEntries.length,
    loafAvgMs: loafDurations.reduce((sum, value) => sum + value, 0) / (loafDurations.length || 1),
    loafMaxMs: loafDurations.length ? Math.max(...loafDurations) : 0,
    fps: 1000 / (average || 1),
  };
}

function resetMetrics() {
  frameTimes = [];
  workTimes = [];
  renderTimes = [];
  loafEntries = [];
}

modeSelect.addEventListener('change', () => {
  setScenario(modeSelect.value, heavy);
});

globalThis.__spike = { setScenario, snapshot, reset: resetMetrics, stop() { running = false; } };

setScenario(mode, heavy);
requestAnimationFrame(frame);

// Automated suite mode: run every scenario sequentially, then POST results.
if (params.get('suite') === '1') {
  let reportURL = params.get('reportURL') || 'http://127.0.0.1:8899/report';
  let scenarios = [
    { mode: 'canvas', heavy: false },
    { mode: 'html', heavy: false },
    { mode: 'canvas', heavy: true },
    { mode: 'html', heavy: true },
  ];
  let warmupMs = Number(params.get('warmup') || 1500);
  let measureMs = Number(params.get('measure') || 4000);
  let results = [];

  (async () => {
    for (let scenario of scenarios) {
      setScenario(scenario.mode, scenario.heavy);
      running = true;
      await sleep(warmupMs);
      resetMetrics();
      await sleep(measureMs);
      results.push(snapshot());
    }

    running = false;
    try {
      await fetch(reportURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suite: 'canvas-cards', cards: CARD_COUNT, hz: UPDATE_HZ, results, capturedAt: new Date().toISOString() }),
      });
    } catch (_error) {}
  })();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
