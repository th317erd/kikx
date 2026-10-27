'use strict';

import './page-scrollview.mjs';
import { createLoremEngine } from './random-engine.mjs';

const host = document.querySelector('#scrollhost');
const metricsEl = document.querySelector('#metrics');
const logEl = document.querySelector('#log');
const view = document.createElement('aeor-page-scrollview');
view.setAttribute('scroll-animation-duration', '250');
view.setAttribute('page-enter-duration', '250');
view.setAttribute('page-load-debounce', '150');
host.appendChild(view);

let engine = createLoremEngine({ total: 17000, pageSize: 40, latencyMs: 220 });
let longTasks = [];
let rapidTimer = null;
try {
  new PerformanceObserver((list) => {
    for (let entry of list.getEntries())
      longTasks.push(Math.round(entry.duration));
    longTasks = longTasks.slice(-20);
  }).observe({ type: 'longtask', buffered: true });
} catch (_) {}

function log(message) {
  let line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  logEl.prepend(line);
  while (logEl.children.length > 40)
    logEl.lastElementChild.remove();
}

function renderItem(item) {
  let node = document.createElement('article');
  node.className = 'message';
  node.dataset.role = item.role;
  node.dataset.kind = item.kind;
  let head = document.createElement('div');
  head.className = 'message__head';
  let role = document.createElement('span');
  role.className = 'message__role';
  role.textContent = item.title;
  let index = document.createElement('span');
  index.textContent = `#${item.index}`;
  head.append(role, index);
  let body = document.createElement('div');
  body.className = 'message__body';
  body.textContent = item.text;
  node.append(head, body);
  return node;
}

const source = {
  get total() { return engine.total; },
  get pageSize() { return engine.pageSize; },
  estimatePageHeight: () => engine.pageSize * 110,
  loadPage: (request) => engine.loadPage({ start: request.start, end: request.end }),
  renderItem,
};

function setSource() {
  stopRapidFire();
  view.setSource(source);
  view.scrollToEnd({ follow: true });
  log(`source set: ${engine.total} items / ${Math.ceil(engine.total / engine.pageSize)} pages`);
}

function stopRapidFire() {
  if (rapidTimer)
    clearTimeout(rapidTimer);
  rapidTimer = null;
  let button = document.querySelector('#rapid');
  if (button)
    button.textContent = 'Start rapid fire';
}

function rapidTick() {
  let item = engine.append(Math.random() < 0.35 ? 'user' : 'agent');
  view.appendItem(item);
  log(`rapid #${item.index}`);
  let seconds = Math.max(0.5, Number(document.querySelector('#rapid-interval').value) || 2.5);
  rapidTimer = setTimeout(rapidTick, seconds * 1000);
}

document.querySelector('#end').addEventListener('click', () => {
  view.scrollToEnd({ follow: true, animate: document.querySelector('#animate').checked });
  log('jump bottom');
});
document.querySelector('#random').addEventListener('click', () => {
  let pages = Math.ceil(engine.total / engine.pageSize);
  let index = Math.floor(Math.random() * pages);
  view.scrollToPage(index, { align: 'center', animate: document.querySelector('#animate').checked });
  log(`jump page ${index}`);
});
document.querySelector('#short').addEventListener('click', () => {
  stopRapidFire();
  engine = createLoremEngine({ total: 8, pageSize: 5, latencyMs: 120 });
  view.setSource(source);
  view.scrollToEnd({ follow: false });
  log('short thread');
});
document.querySelector('#long').addEventListener('click', () => {
  stopRapidFire();
  engine = createLoremEngine({ total: 17000, pageSize: 40, latencyMs: 220 });
  view.setSource(source);
  view.scrollToEnd({ follow: true });
  log('reset 17k');
});
document.querySelector('#jump').addEventListener('click', () => {
  let index = Number(document.querySelector('#page-index').value) || 0;
  view.scrollToPage(index, { align: 'start', animate: document.querySelector('#animate').checked });
  log(`jump page ${index}`);
});
document.querySelector('#append').addEventListener('click', () => {
  let item = engine.append('agent');
  view.appendItem(item);
  log(`append item #${item.index}`);
});
document.querySelector('#rapid').addEventListener('click', (event) => {
  if (rapidTimer) {
    stopRapidFire();
    log('rapid fire stopped');
  } else {
    event.target.textContent = 'Stop rapid fire';
    log('rapid fire started');
    rapidTick();
  }
});

document.querySelector('#scroll-animation').addEventListener('input', (event) => {
  view.scrollAnimationDuration = Number(event.target.value) || 0;
});
document.querySelector('#page-enter').addEventListener('input', (event) => {
  view.pageEnterDuration = Number(event.target.value) || 0;
});
document.querySelector('#page-debounce').addEventListener('input', (event) => {
  view.pageLoadDebounce = Number(event.target.value) || 0;
});

document.querySelector('#latency').addEventListener('input', (event) => {
  engine.latencyMs = Number(event.target.value) || 0;
});
document.querySelector('#failure').addEventListener('change', (event) => {
  engine.failureRate = Number(event.target.value) || 0;
});
document.querySelector('#follow').addEventListener('click', () => {
  view.follow = !view.follow;
  if (view.follow)
    view.scrollToEnd({ follow: true });
  log(`follow ${view.follow}`);
});

setInterval(() => {
  metricsEl.textContent = JSON.stringify({ ...view.metrics(), longTasks, nodes: document.querySelectorAll('*').length }, null, 2);
}, 250);

setSource();
