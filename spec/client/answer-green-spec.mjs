'use strict';

// The owner's screenshot, answered as a test: "I want to see my answer in green."
//
// What was actually wrong, measured rather than guessed. The receipt's BORDER and
// its LABEL were already green on both surfaces (#2ea043 / #7ea888). The answer
// TEXT — the words the person typed — was `#e7f0e9`, a near-white. So the row
// looked answered, and the sentence the owner wanted to read in green was
// rendered in the same colour as ordinary body copy. Two rules to change, one per
// surface, and neither had a test that could see a colour at all.
//
// This spec is deliberately TWO KINDS of assertion, because either one alone is
// satisfiable by an accident:
//
//   1. The renderer still emits the class name the stylesheet targets. A green
//      rule for a class nobody renders is the same as no rule. This couples
//      `RECEIPT_CLASSES` to `questions.css` in the one direction that matters.
//   2. That class resolves to a green value, and the default-answer variant does
//      NOT: an agent-supplied default is not the user's words, and the whole
//      point of the amber edge is that the two read differently at a glance.
//
// Colour is asserted from the stylesheet, not from a computed style, because
// mini-dom has no cascade. The browser lane carries the computed-pixel half.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { RECEIPT_CLASSES } from '../../src/client/components/kikx-answer-receipt.mjs';

const CSS = readFileSync(new URL('../../src/client/styles/questions.css', import.meta.url), 'utf8');

// Every `color:` declared inside the first rule block whose selector is `selector`.
// Parsed rather than regex-scanned over the whole file so a green value in some
// unrelated rule cannot make this pass.
function declarationsFor(selector) {
  let start = CSS.indexOf(`${selector} {`);
  if (start < 0)
    return null;

  let open = CSS.indexOf('{', start);
  let close = CSS.indexOf('}', open);
  if (open < 0 || close < 0)
    return null;

  return CSS.slice(open + 1, close);
}

function colorOf(selector) {
  let body = declarationsFor(selector);
  if (body === null)
    return null;

  let match = body.match(/color:\s*([^;]+);/);
  return match ? match[1].trim() : null;
}

// Green means: the green channel is the largest of the three, by a margin, and
// the colour is not near-white. `#e7f0e9` — the value that shipped — fails on
// both counts, which is exactly the regression being guarded.
function assertGreen(hex, label) {
  let match = /^#([0-9a-f]{6})$/i.exec(hex || '');
  assert.ok(match, `${label}: expected a 6-digit hex colour, got ${JSON.stringify(hex)}`);

  let n = Number.parseInt(match[1], 16);
  let r = (n >> 16) & 0xff;
  let g = (n >> 8) & 0xff;
  let b = n & 0xff;

  assert.ok(g > r + 40, `${label}: green channel ${g} must exceed red ${r} by a clear margin (got ${hex})`);
  assert.ok(g > b + 40, `${label}: green channel ${g} must exceed blue ${b} by a clear margin (got ${hex})`);
  assert.ok(g > 0x60, `${label}: green channel ${g} is too dark to read as green text (got ${hex})`);
}

const SURFACES = [
  { name: 'session Question frame', textClass: RECEIPT_CLASSES.frame.text },
  { name: 'Inbox row', textClass: RECEIPT_CLASSES.card.text },
];

for (let { name, textClass } of SURFACES) {
  test(`${name}: the user's answer text is green`, () => {
    // 1. The class is one the renderer actually emits.
    assert.match(textClass, /^kikx-question-(frame|card)__/,
      `${name}: the receipt module must emit a real surface class, got ${textClass}`);

    // 2. And the stylesheet colours that exact class green.
    let colour = colorOf(`.${textClass}`);
    assert.notEqual(colour, null,
      `${name}: no rule for .${textClass} — the answer text is unstyled and inherits body colour`);

    assertGreen(colour, `${name} answer text`);
  });
}

test('the two surfaces cannot drift: both answer-text rules are the same green', () => {
  let frame = colorOf(`.${RECEIPT_CLASSES.frame.text}`);
  let card = colorOf(`.${RECEIPT_CLASSES.card.text}`);

  assert.equal(card, frame,
    `the Inbox and the thread must show the same answer colour; frame=${frame} card=${card}`);
});

test('an agent default is NOT green: the user\'s words and the agent\'s words differ at a glance', () => {
  // The default variant is identified by the attribute, not by a second class, so
  // this reads the rule that carries it.
  for (let [ selector, expected ] of [
    [ `.${RECEIPT_CLASSES.frame.block}[data-answer-source='default']`, 'frame' ],
    [ `.${RECEIPT_CLASSES.card.block}[data-answer-source='default']`, 'card' ],
  ]) {
    assert.ok(CSS.includes(selector), `${expected}: the default-answer variant rule must exist`);
  }

  // The default's LABEL is amber. If someone "fixed" the green by making every
  // receipt label green, this catches it.
  let defaultLabel = declarationsFor(`.${RECEIPT_CLASSES.frame.block}[data-answer-source='default'] .${RECEIPT_CLASSES.frame.label}`);
  assert.notEqual(defaultLabel, null, 'the default-answer label rule must exist');
  assert.match(defaultLabel, /#d29922/, 'a default answer keeps the amber label — it is not the user speaking');
});

test('the answer text is not near-white, which is what the owner was looking at', () => {
  for (let { name, textClass } of SURFACES) {
    let colour = colorOf(`.${textClass}`);
    assert.doesNotMatch(colour, /#e7f0e9/i,
      `${name}: #e7f0e9 is the near-white body colour this fix replaced`);
  }
});
