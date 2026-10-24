'use strict';

// A Question frame must LOOK like a Question frame.
//
// Owner, looking at the Inbox and at an in-thread frame: "these still ARE NOT
// STYLED like a QuestionFrame" — "MATCH THE STYLE? Use the same element, and the
// same styles?"
//
// The cause was not a missing rule. The hot-pink left edge that gives the frame
// its identity (`a6e1bf5`, "render Question frames as first-class hot-pink
// frames") was being silently deleted by a later rule that wrote the
// `border-color` SHORTHAND:
//
//   .kikx-question-frame--inbox:has(.kikx-question-card__answer) .kikx-question-card__answer {
//     border-color: #30363d;      /* resets all four sides, accent included */
//   }
//
// `border-color` resets border-left-color too, and at (0,3,0) it outranks the
// shared box rule's (0,1,0). An answerable question is the ONLY state a user
// normally sees, and in that state the accent was grey on BOTH surfaces.
// Measured in Chromium: borderLeftColor rgb(48,54,61) with width still 3px — so
// the stripe kept its geometry and lost its colour, which is why the frame read
// as "not a Question frame" rather than as "missing something".
//
// Why the existing parity spec did not catch it: it asserts the two surfaces are
// EQUAL to each other. Both were greyed by the same rule, so two wrongs compared
// equal and it passed. This spec asserts the accent's ABSOLUTE value instead,
// and only then that the surfaces agree.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('../../src/client/styles/questions.css', import.meta.url), 'utf8');

const ACCENT = 'rgb(255, 79, 163)'; // #ff4fa3
const ACCENT_HEX = '#ff4fa3';

// --- a small, honest cascade resolver -------------------------------------
//
// Only as much CSS as these rules actually use. It expands the `border`,
// `border-left` and `border-color` shorthands the way a browser does, because
// the whole bug lived in the difference between a shorthand and a longhand; a
// resolver that ignored that difference would have agreed with the bug.

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseRules(text) {
  let css = stripComments(text);
  let rules = [];
  let depth = 0;
  let selStart = 0;
  let bodyStart = -1;

  for (let i = 0; i < css.length; i++) {
    let ch = css[i];
    if (ch === '{') {
      if (depth === 0) {
        bodyStart = i + 1;
        rules.push({ selector: css.slice(selStart, i).trim(), body: '', order: rules.length });
      }
      depth++;
    }
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        rules[rules.length - 1].body = css.slice(bodyStart, i);
        selStart = i + 1;
      }
    }
  }

  return rules;
}

// Split on a delimiter that is not inside parentheses.
function splitTop(text, delimiter) {
  let parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    let ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === delimiter && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function declarationsOf(rule) {
  let out = [];
  for (let declaration of splitTop(rule.body, ';')) {
    let colon = declaration.indexOf(':');
    if (colon === -1)
      continue;
    out.push({ name: declaration.slice(0, colon).trim(), value: declaration.slice(colon + 1).trim() });
  }
  return out;
}

const SIDES = ['top', 'right', 'bottom', 'left'];
const PASSTHROUGH = new Set(['border-radius', 'padding', 'gap']);

// Expand one declaration into longhand side values, or [] if it is not a border
// property we care about. This is the part the original bug turned on.
function expand(declaration) {
  let { name, value } = declaration;

  if (name === 'border') {
    let color = borderColorOf(value);
    return SIDES.flatMap((side) => [
      { name: `border-${side}-color`, value: color },
      { name: `border-${side}-width`, value: borderWidthOf(value) },
    ]);
  }

  if (name === 'border-color')
    return SIDES.map((side) => ({ name: `border-${side}-color`, value }));

  if (name === 'border-left')
    return [
      { name: 'border-left-color', value: borderColorOf(value) },
      { name: 'border-left-width', value: borderWidthOf(value) },
    ];

  // Plain longhands this spec checks for equality across the two surfaces.
  if (PASSTHROUGH.has(name))
    return [declaration];

  if (/^border-(top|right|bottom|left)-(color|width)$/.test(name))
    return [declaration];

  return [];
}

function borderColorOf(shorthandValue) {
  let hex = /#[0-9a-fA-F]{3,8}\b/.exec(shorthandValue);
  if (hex)
    return hex[0];
  let rgb = /rgba?\([^)]*\)/.exec(shorthandValue);
  if (rgb)
    return rgb[0];
  // color-mix(...) or a keyword such as `transparent`
  let colourFunction = /(?:color-mix|hsl|hsla|lab|lch|oklab|oklch|color)\([^;]*?\)(?=\s|$)/.exec(shorthandValue);
  if (colourFunction)
    return colourFunction[0].trim();
  let keyword = /(?:transparent|currentColor|inherit|initial|unset|none)\b/i.exec(shorthandValue);
  if (keyword)
    return keyword[0];
  return shorthandValue.trim();
}

function borderWidthOf(shorthandValue) {
  let width = /\b(\d+(?:\.\d+)?(?:px|rem|em)|thin|medium|thick)\b/.exec(shorthandValue);
  return width ? width[1] : '0px';
}

// Split a complex selector into compound parts, flattening `>` so the parent
// relationship is still enforced in order.
function splitCompounds(selector) {
  return selector
    .replace(/\s*>\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function parseCompound(compound) {
  let tag = null;
  let classes = [];
  let attrs = [];
  let has = [];

  let rest = compound;
  let tagMatch = /^([a-zA-Z][\w-]*)/.exec(rest);
  if (tagMatch) {
    tag = tagMatch[1].toLowerCase();
    rest = rest.slice(tagMatch[1].length);
  }

  while (rest.length) {
    let classMatch = /^\.([\w-]+)/.exec(rest);
    if (classMatch) {
      classes.push(classMatch[1]);
      rest = rest.slice(classMatch[0].length);
      continue;
    }

    let attrMatch = /^\[([\w-]+)(?:\s*=\s*["']?([^"'\]]+)["']?)?\]/.exec(rest);
    if (attrMatch) {
      attrs.push({ name: attrMatch[1], value: attrMatch[2] ?? null });
      rest = rest.slice(attrMatch[0].length);
      continue;
    }

    let hasMatch = /^:has\(([^)]*)\)/.exec(rest);
    if (hasMatch) {
      has.push(hasMatch[1].trim());
      rest = rest.slice(hasMatch[0].length);
      continue;
    }

    // `:hover` and `::before` alike: a pseudo-element target is never the
    // element being resolved, so it is skipped rather than thrown on.
    let otherPseudo = /^::?[\w-]+(?:\([^)]*\))?/.exec(rest);
    if (otherPseudo) {
      rest = rest.slice(otherPseudo[0].length);
      continue;
    }

    throw new Error(`unsupported selector syntax at "${rest}" in "${compound}"`);
  }

  return { tag, classes, attrs, has };
}

function compoundMatches(compound, element) {
  if (compound.tag && compound.tag !== element.tag)
    return false;

  for (let className of compound.classes) {
    if (!element.classes.includes(className))
      return false;
  }

  for (let attr of compound.attrs) {
    let actual = element.attrs?.[attr.name];
    if (actual === undefined)
      return false;
    if (attr.value !== null && actual !== attr.value)
      return false;
  }

  for (let inner of compound.has) {
    let parsed = parseCompound(inner);
    let found = (element.descendants || []).some((node) => compoundMatches(parsed, node));
    if (!found)
      return false;
  }

  return true;
}

// `ancestors` is nearest-first.
function selectorMatches(selector, element, ancestors) {
  let compounds = splitCompounds(selector);
  if (!compounds.length)
    return false;

  if (!compoundMatches(parseCompound(compounds[compounds.length - 1]), element))
    return false;

  let ancestorIndex = 0;
  for (let compound of compounds.slice(0, -1).reverse()) {
    let parsed = parseCompound(compound);
    let matched = false;
    while (ancestorIndex < ancestors.length) {
      let candidate = ancestors[ancestorIndex];
      ancestorIndex++;
      if (compoundMatches(parsed, candidate)) {
        matched = true;
        break;
      }
    }
    if (!matched)
      return false;
  }

  return true;
}

function specificity(selector) {
  let classes = 0;
  let tags = 0;
  for (let compound of splitCompounds(selector)) {
    let parsed = parseCompound(compound);
    classes += parsed.classes.length + parsed.attrs.length + parsed.has.length;
    for (let inner of parsed.has)
      classes += parseCompound(inner).classes.length;
    if (parsed.tag)
      tags++;
  }
  return classes * 100 + tags;
}

function resolve(property, element, ancestors) {
  let winner = null;

  for (let rule of parseRules(CSS)) {
    let candidates = [];
    for (let declaration of declarationsOf(rule)) {
      for (let longhand of expand(declaration)) {
        if (longhand.name === property)
          candidates.push(longhand.value);
      }
    }
    if (!candidates.length)
      continue;

    let value = candidates[candidates.length - 1];

    for (let selector of splitTop(rule.selector, ',')) {
      if (!selectorMatches(selector, element, ancestors))
        continue;
      let weight = specificity(selector) * 10000 + rule.order;
      if (!winner || weight >= winner.weight)
        winner = { value, weight, selector: selector.replace(/\s+/g, ' ') };
    }
  }

  return winner;
}

function toRgb(value) {
  if (!value)
    return null;
  let hex = /#([0-9a-fA-F]{6})\b/.exec(value);
  if (hex) {
    let n = parseInt(hex[1], 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  }
  let rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (rgb)
    return `rgb(${rgb[1]}, ${rgb[2]}, ${rgb[3]})`;
  return value.trim();
}

// --- the two surfaces, as the browser builds them -------------------------

function inboxForm(attrs = {}) {
  let element = {
    tag: 'div',
    classes: ['kikx-question-card__answer'],
    attrs,
    descendants: [{ tag: 'textarea', classes: ['kikx-question-card__input'], attrs: {}, descendants: [] }],
  };
  let ancestors = [
    { tag: 'kikx-question-frame', classes: ['kikx-question-frame', 'kikx-question-frame--inbox'], attrs: {}, descendants: [element] },
    {
      tag: 'article',
      classes: ['kikx-question-card'],
      attrs: { 'data-question-status': 'open', 'data-question-settled': 'false', ...attrs },
      descendants: [element],
    },
  ];
  return { element, ancestors };
}

function threadCard(attrs = {}) {
  let textarea = { tag: 'textarea', classes: ['kikx-question-frame__answer'], attrs: {}, descendants: [] };
  let element = { tag: 'div', classes: ['kikx-question-frame__card'], attrs, descendants: [textarea] };
  let ancestors = [
    { tag: 'kikx-question-frame', classes: ['kikx-question-frame'], attrs, descendants: [element, textarea] },
  ];
  return { element, ancestors };
}

// --- guards ---------------------------------------------------------------

test('the shared box rule declares the hot-pink left accent', () => {
  let rule = parseRules(CSS).find((candidate) =>
    /\.kikx-question-frame__card\s*,\s*\.kikx-question-card__answer\s*\{/.test(stripComments(candidate.selector + '{')));
  assert.ok(rule, 'the one-box-two-surfaces rule exists');

  let values = declarationsOf(rule).map((declaration) => `${declaration.name}:${declaration.value}`);
  assert.ok(values.some((value) => /^border-left:3px solid #ff4fa3$/i.test(value)),
    'the accent is declared on the shared rule, so neither surface can invent its own');
});

test('an answerable Inbox form resolves its left edge to the accent, absolutely', () => {
  let { element, ancestors } = inboxForm();
  let width = resolve('border-left-width', element, ancestors);
  let color = resolve('border-left-color', element, ancestors);

  assert.ok(width, 'a border-left-width wins the cascade');
  assert.equal(width.value, '3px', `the stripe keeps its width (from "${width.selector}")`);
  assert.ok(color, 'a border-left-color wins the cascade');
  assert.equal(toRgb(color.value), ACCENT,
    `the Inbox row's accent must be ${ACCENT_HEX}, but "${color.selector}" won with ${color.value}`);
});

test('an answerable in-thread frame resolves its left edge to the accent, absolutely', () => {
  let { element, ancestors } = threadCard();
  let width = resolve('border-left-width', element, ancestors);
  let color = resolve('border-left-color', element, ancestors);

  assert.equal(width?.value, '3px', 'the stripe keeps its width');
  assert.equal(toRgb(color?.value), ACCENT,
    `the thread frame's accent must be ${ACCENT_HEX}, but "${color?.selector}" won with ${color?.value}`);
});

test('the accent survives EVERY state a question can be in', () => {
  // The bug only showed up in the state a live question is always in. Rather
  // than trust one selector, walk the states: the 3px left rule must never be
  // wiped out, in either surface, whatever the status.
  let states = [
    { label: 'answerable', attrs: {} },
    { label: 'busy', attrs: { 'data-answer-state': 'busy' } },
    { label: 'error', attrs: { 'data-answer-state': 'error' } },
    { label: 'sent', attrs: { 'data-answer-state': 'sent' } },
    { label: 'settled', attrs: { 'data-question-settled': 'true' } },
    { label: 'dismissed', attrs: { 'data-question-settled': 'true', 'data-question-status': 'dismissed' } },
  ];

  let report = [];
  for (let state of states) {
    for (let [surface, build] of [['inbox', inboxForm], ['thread', threadCard]]) {
      let { element, ancestors } = build(state.attrs);
      let width = resolve('border-left-width', element, ancestors);
      let color = resolve('border-left-color', element, ancestors);
      report.push(`${state.label}/${surface}: ${width?.value} ${toRgb(color?.value)} (${color?.selector})`);
      assert.equal(width?.value, '3px',
        `${state.label}/${surface} lost the 3px left stripe`);
      assert.ok(color, `${state.label}/${surface} lost its left colour entirely`);
    }
  }

  // The state an open question is always in must be the accent, not a status hue.
  let open = inboxForm();
  assert.equal(toRgb(resolve('border-left-color', open.element, open.ancestors).value), ACCENT);
});

test('the answerable-state rule names the accent instead of resetting all four sides', () => {
  let rule = parseRules(CSS).find((candidate) =>
    candidate.selector.includes(':has(.kikx-question-frame__answer)')
    && candidate.selector.includes('.kikx-question-card__answer'));

  assert.ok(rule, 'the answerable-state rule exists for both surfaces');

  let names = declarationsOf(rule).map((declaration) => declaration.name);
  assert.ok(names.includes('border-left-color'),
    'it must set the accent it would otherwise reset');
  assert.ok(!names.includes('border-color'),
    'the four-side shorthand is what deleted the accent in the first place');
});

test('the two surfaces agree on every box property, not merely on the accent', () => {
  let properties = [
    'border-left-width', 'border-left-color',
    'border-top-color', 'border-top-width', 'border-right-color', 'border-bottom-color',
    'border-radius', 'padding', 'gap',
  ];

  let inbox = inboxForm();
  let thread = threadCard();

  for (let property of properties) {
    let inInbox = resolve(property, inbox.element, inbox.ancestors);
    let inThread = resolve(property, thread.element, thread.ancestors);

    assert.ok(inInbox, `${property} is declared for the Inbox form`);
    assert.ok(inThread, `${property} is declared for the thread card`);
    assert.equal(toRgb(inInbox.value), toRgb(inThread.value),
      `${property} must match on both surfaces: Inbox "${inInbox.selector}" gave ${inInbox.value}, `
      + `thread "${inThread.selector}" gave ${inThread.value}`);
  }
});

test('the accent constant asserted above really is the stylesheet accent', () => {
  assert.ok(CSS.includes(ACCENT_HEX), 'the stylesheet still declares #ff4fa3');
  assert.equal(toRgb(ACCENT_HEX), ACCENT);
});
