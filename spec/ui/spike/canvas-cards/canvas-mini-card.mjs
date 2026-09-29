'use strict';

const CARD_WIDTH = 260;
const CARD_HEIGHT = 180;
const CARD_PADDING = 12;
const HEADER_HEIGHT = 26;
const BUBBLE_GAP = 6;
const BUBBLE_RADIUS = 8;
const LINE_HEIGHT = 15;
const FONT_SIZE = 11;
const FONT_FAMILY = 'system-ui, sans-serif';

const THEME = {
  background: '#0f1116',
  cardBackground: '#171a21',
  cardBorder: '#232833',
  headerText: '#e6e9ef',
  userBubble: '#2b5cff',
  userText: '#ffffff',
  agentBubble: '#252a34',
  agentText: '#d7dbe4',
  toolBubble: '#1d2733',
  toolText: '#8fd0ff',
  streamingDot: '#66e0a3',
};

export function createCanvasMiniCard(card) {
  let canvas = document.createElement('canvas');
  let dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  canvas.width = CARD_WIDTH * dpr;
  canvas.height = CARD_HEIGHT * dpr;
  canvas.className = 'spike-card spike-card--canvas';
  canvas.style.width = `${CARD_WIDTH}px`;
  canvas.style.height = `${CARD_HEIGHT}px`;
  let ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  let layoutCache = null;
  let layoutKey = '';

  function computeLayout() {
    let key = `${card.bubbles.length}:${card.bubbles.map((b) => b.text.length).join(',')}`;
    if (key === layoutKey && layoutCache)
      return layoutCache;

    let y = CARD_PADDING + HEADER_HEIGHT;
    let bubbles = [];
    let maxWidth = CARD_WIDTH - CARD_PADDING * 2;

    for (let bubble of card.bubbles) {
      let lines = wrapText(ctx, bubble.text, maxWidth - 16, `${FONT_SIZE}px ${FONT_FAMILY}`);
      let height = lines.length * LINE_HEIGHT + 10;
      bubbles.push({ role: bubble.role, lines, y, height, streaming: bubble.streaming === true });
      y += height + BUBBLE_GAP;
    }

    layoutCache = { bubbles, contentHeight: y };
    layoutKey = key;
    return layoutCache;
  }

  function draw() {
    let layout = computeLayout();

    ctx.clearRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
    roundRect(ctx, 0.5, 0.5, CARD_WIDTH - 1, CARD_HEIGHT - 1, 10);
    ctx.fillStyle = THEME.cardBackground;
    ctx.fill();
    ctx.strokeStyle = THEME.cardBorder;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = THEME.headerText;
    ctx.font = `600 ${FONT_SIZE + 1}px ${FONT_FAMILY}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(truncate(ctx, card.title, CARD_WIDTH - CARD_PADDING * 2 - 60), CARD_PADDING, CARD_PADDING + HEADER_HEIGHT / 2);
    ctx.fillStyle = '#7f8798';
    ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
    ctx.fillText(card.agentName, CARD_WIDTH - CARD_PADDING - ctx.measureText(card.agentName).width, CARD_PADDING + HEADER_HEIGHT / 2);

    ctx.textBaseline = 'top';
    for (let bubble of layout.bubbles) {
      if (bubble.y > CARD_HEIGHT)
        break;

      let width = bubble.role === 'user' ? CARD_WIDTH * 0.72 : CARD_WIDTH * 0.82;
      let x = bubble.role === 'user'
        ? CARD_WIDTH - CARD_PADDING - width
        : CARD_PADDING;
      let fill = bubble.role === 'user' ? THEME.userBubble
        : bubble.role === 'tool' ? THEME.toolBubble
        : THEME.agentBubble;
      let textColor = bubble.role === 'user' ? THEME.userText
        : bubble.role === 'tool' ? THEME.toolText
        : THEME.agentText;

      roundRect(ctx, x, bubble.y, width, bubble.height, BUBBLE_RADIUS);
      ctx.fillStyle = fill;
      ctx.fill();

      ctx.fillStyle = textColor;
      ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
      let textX = x + 8;
      let textY = bubble.y + 5;
      for (let line of bubble.lines) {
        if (textY > CARD_HEIGHT)
          break;
        ctx.fillText(line, textX, textY);
        textY += LINE_HEIGHT;
      }

      if (bubble.streaming) {
        ctx.fillStyle = THEME.streamingDot;
        ctx.beginPath();
        ctx.arc(x + width - 10, bubble.y + bubble.height - 8, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  return {
    element: canvas,
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    draw,
  };
}

export function wrapText(ctx, text, maxWidth, font) {
  ctx.font = font;
  let words = String(text ?? '').split(/\s+/).filter(Boolean);
  let lines = [];
  let current = '';

  for (let word of words) {
    let next = current ? `${current} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth) {
      current = next;
      continue;
    }

    if (current)
      lines.push(current);
    current = word;
  }

  if (current)
    lines.push(current);
  if (lines.length === 0)
    lines.push('');

  return lines;
}

function truncate(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth)
    return text;

  let value = text;
  while (value.length > 1 && ctx.measureText(`${value}…`).width > maxWidth)
    value = value.slice(0, -1);

  return `${value}…`;
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

export const CANVAS_CARD_SIZE = { width: CARD_WIDTH, height: CARD_HEIGHT };
