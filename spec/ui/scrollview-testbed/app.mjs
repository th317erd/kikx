'use strict';

import './aeor-scrollview.mjs';
import { createLoremEngine } from './random-engine.mjs';

const host = document.querySelector('#scrollhost');
const metricsEl = document.querySelector('#metrics');
const logEl = document.querySelector('#log');
const scrollview = document.createElement('aeor-scrollview');
scrollview.setAttribute('overscan', '1.5');
host.appendChild(scrollview);

let engine = createLoremEngine({ total: 17000, pageSize: 40, latencyMs: 220 });
let longTasks = [];
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
  node.innerHTML = '';
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

function updateItem(node, item) {
  let body = node.querySelector('.message__body');
  if (body && body.textContent !== item.text)
    body.textContent = item.text;
  let index = node.querySelector('.message__head span:last-child');
  if (index)
    index.textContent = `#${item.index}`;
}

const source = {
  get total() { return engine.total; },
  get pageSize() { return engine.pageSize; },
  get requests() { return engine.requests; },
  get failures() { return engine.failures; },
  itemAt: (index) => engine.itemAt(index),
  estimateHeight: (index) => 70 + (index % 9) * 6,
  loadPage: (request) => engine.loadPage(request),
  renderItem,
  updateItem,
};

function setSource() {
  scrollview.setSource(source);
  scrollview.scrollToEnd({ follow: true });
  log(`source set: ${engine.total} items`);
}

function setTotalAndFollow() {
  scrollview.setTotal(engine.total);
  if (scrollview.follow)
    scrollview.refreshRange();
}

document.querySelector('#end').addEventListener('click', () => {
  scrollview.scrollToEnd({ follow: true });
  log('jump to bottom');
});
document.querySelector('#random').addEventListener('click', () => {
  let index = Math.floor(Math.random() * Math.max(1, engine.total));
  scrollview.scrollToIndex(index, { align: 'center' });
  log(`jump random #${index}`);
});
document.querySelector('#short').addEventListener('click', () => {
  engine = createLoremEngine({ total: 8, pageSize: 5, latencyMs: 120 });
  scrollview.setSource(source);
  scrollview.scrollToEnd({ follow: false });
  log('short thread: 8 items');
});
document.querySelector('#long').addEventListener('click', () => {
  engine = createLoremEngine({ total: 17000, pageSize: 40, latencyMs: 220 });
  scrollview.setSource(source);
  scrollview.scrollToEnd({ follow: true });
  log('reset 17k');
});
document.querySelector('#jump').addEventListener('click', () => {
  let index = Number(document.querySelector('#jump-index').value) || 0;
  scrollview.scrollToIndex(index, { align: 'start' });
  log(`jump #${index}`);
});
document.querySelector('#append').addEventListener('click', () => {
  let item = engine.append('agent');
  scrollview.setTotal(engine.total);
  scrollview.updateItem?.(item.index, item);
  scrollview.setTotal(engine.total);
  if (scrollview.follow)
    scrollview.scrollToEnd({ follow: true });
  log(`append #${item.index}`);
});
document.querySelector('#stream').addEventListener('click', () => {
  let item = engine.streamLast(14);
  if (!item)
    return;
  scrollview.updateItem(item.index, item);
  log(`stream #${item.index}`);
});
document.querySelector('#update').addEventListener('click', () => {
  let item = engine.updateRandom();
  if (!item)
    return;
  scrollview.updateItem(item.index, item);
  log(`update #${item.index}`);
});
document.querySelector('#latency').addEventListener('input', (event) => {
  engine.latencyMs = Number(event.target.value) || 0;
  log(`latency ${engine.latencyMs}ms`);
});
document.querySelector('#failure').addEventListener('change', (event) => {
  engine.failureRate = Number(event.target.value) || 0;
  log(`failure rate ${engine.failureRate}`);
});
document.querySelector('#follow').addEventListener('click', () => {
  scrollview.follow = !scrollview.follow;
  if (scrollview.follow)
    scrollview.scrollToEnd({ follow: true });
  log(`follow ${scrollview.follow}`);
});
document.querySelector('#clear').addEventListener('click', () => {
  engine = createLoremEngine({ total: 17000, pageSize: 40, latencyMs: 220 });
  longTasks = [];
  scrollview.setSource(source);
  scrollview.scrollToEnd({ follow: true });
  log('reset');
});

scrollview.addEventListener('scrollview-range-request', (event) => log(`request ${JSON.stringify(event.detail)}`));
scrollview.addEventListener('scrollview-load-state', (event) => log(`state ${JSON.stringify(event.detail)}`));
scrollview.addEventListener('scrollview-follow-change', (event) => log(`follow -> ${event.detail.follow}`));

setInterval(() => {
  let metrics = scrollview.metrics();
  metricsEl.textContent = JSON.stringify({
    ...metrics,
    longTasks,
    bodyNodes: document.querySelectorAll('*').length,
    now: Math.round(performance.now()),
  }, null, 2);
}, 250);

setSource();
