'use strict';

const CARD_WIDTH = 260;
const CARD_HEIGHT = 180;

export function createHtmlMiniCard(card) {
  let root = document.createElement('div');
  root.className = 'spike-card spike-card--html';
  root.style.width = `${CARD_WIDTH}px`;
  root.style.height = `${CARD_HEIGHT}px`;

  let header = document.createElement('div');
  header.className = 'spike-card__header';
  let title = document.createElement('span');
  title.className = 'spike-card__title';
  title.textContent = card.title;
  let agent = document.createElement('span');
  agent.className = 'spike-card__agent';
  agent.textContent = card.agentName;
  header.append(title, agent);

  let body = document.createElement('div');
  body.className = 'spike-card__body';

  let rendered = new Map();
  let root_bubbles = document.createElement('div');
  root_bubbles.className = 'spike-bubbles';
  body.appendChild(root_bubbles);

  function sync() {
    let seen = new Set();

    for (let bubble of card.bubbles) {
      let key = `${bubble.role}:${bubble.text}`;
      seen.add(key);
      let node = rendered.get(key);
      if (node) {
        if (bubble.streaming && !node.classList.contains('is-streaming'))
          node.classList.add('is-streaming');
        continue;
      }

      node = document.createElement('div');
      node.className = `spike-bubble spike-bubble--${bubble.role}${bubble.streaming ? ' is-streaming' : ''}`;
      node.textContent = bubble.text;
      rendered.set(key, node);
      root_bubbles.appendChild(node);
    }

    for (let [key, node] of rendered) {
      if (!seen.has(key)) {
        node.remove();
        rendered.delete(key);
      }
    }
  }

  sync();

  return {
    element: root,
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    draw: sync,
  };
}

export const HTML_CARD_SIZE = { width: CARD_WIDTH, height: CARD_HEIGHT };
