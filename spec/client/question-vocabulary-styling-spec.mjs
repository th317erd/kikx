'use strict';

// The two visual regressions the owner reported against the unified Inbox row,
// written down as tests so they cannot come back silently.
//
// What was actually wrong, measured rather than guessed:
//
//   1. "The close button is now shifting over to the left."
//      The old card renderer emitted `className = "…__dismiss-close
//      …__dismiss-close--settle"` — base AND modifier. When the two surfaces were
//      unified, `INBOX_VOCAB.settle` was written as the modifier ALONE. A BEM
//      modifier is meant to accompany its block, not replace it, and every rule
//      that sizes, colours or places this control is keyed on the base name —
//      including `.kikx-question-card__header .kikx-question-card__dismiss-close
//      { margin-left: auto }`. Dropping the base class left the control to the
//      flex row's own alignment, which put the X back against the meta text.
//
//   2. "These still ARE NOT STYLED like a QuestionFrame."
//      The unified row renders the frame's markup under the Inbox's vocabulary.
//      Two of those names — `__priority` and `__missing` — had no rule anywhere
//      in questions.css, so a high-priority row printed the bare word "high" as
//      body copy. And the row's outer box still carried the old neutral
//      `#171c21 / #2a3138` card colours, while the pink identity the owner was
//      looking at in the thread lives on `.kikx-question-frame__card`.
//
// Neither defect could fail the gate that preceded them, and the reason is the
// point of this file: nothing coupled a vocabulary name to a stylesheet rule. A
// renderer can emit a name no stylesheet has ever heard of and every existing
// test still passes, because the tests assert the NAME and the stylesheet is
// never consulted.
//
// Colour is read from the document, not from a computed style, because mini-dom
// has no cascade. The browser lane carries the computed-pixel half.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  FRAME_ROOT_CLASS,
  FRAME_VOCAB,
  INBOX_VOCAB,
  INBOX_ROOT_CLASS,
} from '../../src/client/components/kikx-question-surface.mjs';

const CSS = readFileSync(new URL('../../src/client/styles/questions.css', import.meta.url), 'utf8');

// Names that live in FRAME_VOCAB but are only ever reachable when the frame is
// told `inboxChrome: true`. The frame object is shared by both surfaces, so the
// batch position, the context references and the settle fuse sit in it even
// though a lone question in a thread has nothing to position or settle against.
// Listed explicitly: an exemption that is written down can be reviewed, one
// that is merely absent from the check cannot.
const FRAME_INBOX_ONLY = new Set([
  FRAME_VOCAB.position,
  FRAME_VOCAB.refs,
  FRAME_VOCAB.ref,
  FRAME_VOCAB.settle,
]);

// Every class name in a vocabulary value, flattened. `receipts` nests an object,
// so a name is not always a string.
function classNames(value, out = []) {
  if (typeof value === 'string') {
    for (const name of value.split(/\s+/)) if (name) out.push(name);
  } else if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) classNames(inner, out);
  }
  return out;
}

function hasRule(name) {
  return new RegExp(`\\.${name.replace(/[-]/g, '\\-')}(?![\\w-])`).test(CSS);
}

// The body of the rule whose selector, as a whole line, is exactly `selector`.
//
// Line matching, not substring matching. A bare `indexOf('.x__card {')` also
// matches inside `[data-answer-state='sent'] .x__card {`, a later rule that only
// sets a border colour, so reading that block reports zero `border-left` against
// a stylesheet that plainly declares one. Splitting on lines keeps the match
// anchored without depending on how a newline is escaped into a search string.
function blockFor(selector) {
  const lines = CSS.split(String.fromCharCode(10));

  // A rule's selector can be a group spread over several lines (`.a,\n.b {`).
  // Comparing one line at a time reports "no such rule" for every grouped rule
  // in the file, so the continuation lines above the brace are collected and
  // the selector is compared as a whole.
  const wanted = selector.split(',').map((part) => part.trim()).filter(Boolean).join(', ');
  let at = -1;
  for (let head = 0; head < lines.length; head += 1) {
    if (!lines[head].trim().endsWith('{')) continue;

    let first = head;
    while (first > 0 && lines[first - 1].trim().endsWith(',') && lines[first - 1].includes('.'))
      first -= 1;

    const parts = [];
    for (let i = first; i <= head; i += 1) {
      let text = lines[i].trim();
      if (i === head) text = text.slice(0, text.lastIndexOf('{'));
      text = text.replace(/,$/, '').trim();
      if (text) parts.push(text);
    }

    if (parts.join(', ') === wanted) {
      at = head;
      break;
    }
  }
  if (at < 0) return null;

  const out = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '}') break;
    out.push(lines[i]);
  }
  return out.join(String.fromCharCode(10));
}

// `selector` is a real CSS selector, dot included. The exported ROOT constants are
// bare class names (`kikx-question-card`), not selectors, so every call site adds
// the dot. Three assertions failed against a correct stylesheet before this was
// noticed, because `kikx-question-card {` matches nothing at all.
function declarations(selector, property) {
  const block = blockFor(selector);
  if (!block) return [];
  return block
    .split(';')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${property}:`))
    .map((line) => line.slice(property.length + 1).trim());
}

test('every Inbox vocabulary name has a rule in the stylesheet', () => {
  const unstyled = [];
  for (const [key, value] of Object.entries(INBOX_VOCAB)) {
    for (const name of classNames(value))
      if (!hasRule(name)) unstyled.push(`${key}: .${name}`);
  }

  assert.deepEqual(
    unstyled,
    [],
    `These Inbox class names are rendered but no stylesheet rule targets them, so
they inherit body defaults and the row stops looking like a Question frame:
  ${unstyled.join('\n  ')}`,
  );
});

test('the only unstyled frame names are the ones an Inbox row alone can reach', () => {
  const unstyled = new Set();
  for (const value of Object.values(FRAME_VOCAB))
    for (const name of classNames(value))
      if (!hasRule(name)) unstyled.add(name);

  const unexpected = [...unstyled].filter((name) => !FRAME_INBOX_ONLY.has(name));

  assert.deepEqual(
    unexpected,
    [],
    `A frame name is rendered on the thread surface with no rule behind it. If it
is genuinely Inbox-only, add it to FRAME_INBOX_ONLY with a reason:
  ${unexpected.join('\n  ')}`,
  );
});

test('the settle close carries its base class, not the modifier alone', () => {
  const emitted = INBOX_VOCAB.settle.split(/\s+/).filter(Boolean);
  const base = `${INBOX_ROOT_CLASS}__dismiss-close`;

  // The reported bug in one assertion. `margin-left: auto` and the whole
  // size/colour family hang off the base name.
  assert.ok(
    emitted.includes(base),
    `INBOX_VOCAB.settle emitted "${INBOX_VOCAB.settle}" without the base class .${base}.`,
  );
  assert.ok(
    emitted.includes(`${base}--settle`),
    'the settle modifier is what swaps the ring from "hold to dismiss" to time remaining',
  );
});

test('the rule that pins the close to the end of the row targets a class the row emits', () => {
  const pinning = declarations(`.${INBOX_ROOT_CLASS}__header .${INBOX_ROOT_CLASS}__dismiss-close`, 'margin-left');
  assert.deepEqual(pinning, ['auto'], 'the close is pushed to the far end of the header row by this rule');

  // And the control must actually carry that class for the rule to land.
  assert.ok(INBOX_VOCAB.settle.split(/\s+/).includes(`${INBOX_ROOT_CLASS}__dismiss-close`));
});

// The box is declared once, for both surfaces, as a grouped selector. It has to
// be read as a group: `.kikx-question-card__answer` sits on the second line of
// the selector, so a single-line lookup finds nothing at all.
const SHARED_BOX = `.${FRAME_ROOT_CLASS}__card, .${INBOX_ROOT_CLASS}__answer`;

test('an Inbox row paints the same accent as an in-thread Question frame', () => {
  // One rule, two selectors. Reading one selector per surface and comparing the
  // values would still pass after the two rules drifted apart, so this asserts
  // the accent is declared ONCE and shared.
  const shared = declarations(SHARED_BOX, 'border-left');
  assert.equal(
    shared.length,
    1,
    `the shared box rule must declare exactly one left accent, found ${shared.length}`,
  );
  assert.equal(shared[0], '3px solid #ff4fa3');

  // The wrapper itself must carry no box. A second box around the form is what
  // made a row read as a different component from the question it renders, and
  // the two boxes disagreed about padding and gap (a measured 6px height fork).
  for (const property of ['border-left', 'padding', 'background'])
    assert.deepEqual(
      declarations(`.${INBOX_ROOT_CLASS}`, property),
      [],
      `.${INBOX_ROOT_CLASS} is a positioning wrapper; .${INBOX_ROOT_CLASS}__answer draws the box. A '${property}' here is a second box.`,
    );
});

test('the row box does not keep the neutral card colours the frame replaced', () => {
  const background = declarations(SHARED_BOX, 'background');
  assert.equal(background.length, 1);
  assert.ok(
    !/^#171c21$/i.test(background[0]),
    'the row box still uses the old flat #171c21 card fill instead of the frame tint',
  );
});

test('the answerable-state border override covers both surfaces', () => {
  // This rule sets `border-color`, a shorthand over all four edges, so it
  // repaints a left accent grey while the question is still answerable. It wins
  // on specificity against the shared box rule — (0,3,0) against (0,1,0) — even
  // though it appears earlier in the file.
  //
  // It used to speak only the thread's vocabulary. The frame's textarea is
  // `kikx-question-frame__answer`; in the Inbox row `kikx-question-card__answer`
  // is the FORM — a different element, under a different parent. So the frame
  // greyed its edge while the row kept its accent, and the two surfaces
  // disagreed on all four border colours in the one state a user actually sees.
  // Chrome measured exactly that split at 420/300/240px, which is precisely what
  // a name-based assertion could never have caught.
  //
  // Both branches are required. Drop the frame branch and the thread greys out
  // alone; drop the Inbox branch and the row keeps an accent the frame does not
  // have. The Inbox branch keys on `.kikx-question-frame--inbox`, NOT on the
  // row's <article>: the frame sits between the article and the form, so
  // `:has(> …)` off the article matches nothing at all — measured, not assumed.
  assert.deepEqual(
    declarations(
      [
        `.${FRAME_ROOT_CLASS}:has(.${FRAME_ROOT_CLASS}__answer) .${FRAME_ROOT_CLASS}__card`,
        `.${FRAME_ROOT_CLASS}--inbox:has(.${INBOX_ROOT_CLASS}__answer) .${INBOX_ROOT_CLASS}__answer`,
      ].join(', '),
      'border-color',
    ),
    ['#30363d'],
    'this override must cover both surfaces; decide why before changing it',
  );

  // And both branches must name an element that really exists: the frame's
  // textarea is `__answer`, the Inbox row's form is `__answer`.
  assert.equal(INBOX_VOCAB.form, `${INBOX_ROOT_CLASS}__answer`);
  assert.equal(FRAME_VOCAB.input, `${FRAME_ROOT_CLASS}__answer`);

  assert.deepEqual(
    declarations(`.${INBOX_ROOT_CLASS}__answer`, 'border-color'),
    [],
    'the Inbox form must not declare its own border colour; the grey arrives through the grouped :has rule, and a per-surface declaration would be a second fork of the accent',
  );
});
