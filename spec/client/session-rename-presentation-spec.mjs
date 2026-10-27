'use strict';

// Owner item 2a and the visibility half of 2b (2026-10-27): what the RENAME
// CONTROL looks like, as opposed to what it does.
//
// Split from spec/client/session-rename-escape-spec.mjs by responsibility: that
// file drives the DOM and the guards, this one reads the stylesheets and
// evaluates the cascade. Both were in one 772-line file, past AGENTS.md's 500-line
// soft limit; the split is along the seam the two halves already had.
//
// The two claims pinned here:
//
//   2a "the edit pencil icon itself is WAY WAY too large"
//      app.css:509-514 gives `.kikx-icon-button` `font-size: calc(22px * 1.25)`
//      = 27.5px, and app.css:7-12 gives `.kikx-icon` `width: 1em`. The pencil svg
//      carries `kikx-icon`, so it rendered at 27.5px inside a 34px button. The
//      fix is a SCOPED small glyph size in the newer sheet, which must beat the
//      app.css rule on specificity rather than on load order.
//
//   2b the Cancel control must be VISIBLE at rest, not hover-gated
//      The editor's buttons live inside `.kikx-breadcrumb`, where a rule hides
//      every `.kikx-icon-button` until the trail is hovered or focused. The first
//      attempt at the override lost to that rule and the browser probe caught the
//      Cancel control computing `visibility: hidden` -- a way out nobody can see.
//
// NO CASCADE EXISTS under Node, so neither claim can be asserted by mounting a
// node and reading computed style. Instead this models the cascade for the
// REAL class list over the REAL sheet text. That is why each assertion carries a
// control: a model that matched everything would pass against the pre-fix sheet,
// which is exactly the false green worth guarding against.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();

const { buildTopbarCrumb } = await import('../../src/client/components/kikx-topbar.mjs');


// --- helpers ---------------------------------------------------------------

function makeApp(state = {}) {
  return {
    calls: { render: 0, commit: [], cancel: 0 },
    _state: {
      editingSessionNameID: '',
      editingSessionNameValue: '',
      navigationStack: [ { sessionID: 's1', collapsed: false } ],
      authToken: 'token',
      sessions: [ { id: 's1', title: 'Original name' } ],
      ...state,
    },
    _render() { this.calls.render += 1; },
    _commitSessionName() {},
    _cancelSessionNameEdit() {},
    _beginSessionNameEdit() {},
    _navigateToDepth() {},
    _onSessionNameKeydown() {},
  };
}

function crumbFor(sessionID = 's1', label = 'Original name') {
  return { sessionID, label, active: true, depth: 2 };
}

function mount(builder) {
  let node = builder.build(document);
  let host = document.createElement('div');
  host.appendChild(node);
  document.body.appendChild(host);
  return node;
}

// --- 2a: the pencil is an icon, not an illustration ------------------------
//
// No CSS cascade exists here, so this pins the CONTRACT the sheet must satisfy:
// the pencil carries the icon classes, and the linked sheet scopes a small glyph
// size to the crumb with enough specificity to beat app.css's `.kikx-icon-button`
// (which sets font-size 27.5px and is what made the pencil huge).

const CSS_ROOT = fileURLToPath(new URL('../../src/client/styles/', import.meta.url));

// Counts specificity as (id, class/attr/pseudo-class, element) the way the
// cascade does. Only the shapes these sheets use are handled; anything else
// throws rather than silently scoring zero and making a test vacuous.
function specificity(selector) {
  let ids = (selector.match(/#[\w-]+/g) || []).length;
  let classes = (selector.match(/\.[\w-]+/g) || []).length;
  let attributes = (selector.match(/\[[^\]]+\]/g) || []).length;
  let pseudoClasses = (selector.match(/:(?!:)[\w-]+/g) || []).length;
  let stripped = selector
    .replace(/#[\w-]+/g, ' ')
    .replace(/\.[\w-]+/g, ' ')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/:(?!:)[\w-]+/g, ' ');
  let elements = stripped.split(/[\s>+~]+/).filter((part) => /^[a-zA-Z]/.test(part)).length;
  return [ ids, classes + attributes + pseudoClasses, elements ];
}

function outranks(candidate, baseline) {
  for (let index = 0; index < 3; index += 1) {
    if (candidate[index] !== baseline[index])
      return candidate[index] > baseline[index];
  }
  return false;
}

// Minimal block reader: returns { selector, body } for every rule whose selector
// line mentions `needle`. Comments are stripped first so a `kikx-icon-button`
// mentioned in prose cannot be mistaken for a rule.
async function rulesMentioning(sheet, needle) {
  let source = await readFile(new URL(sheet, `file://${CSS_ROOT}`), 'utf8');
  let css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  let found = [];
  let pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(css)) !== null) {
    let selectors = match[1].trim();
    if (!selectors.includes(needle) || selectors.startsWith('@'))
      continue;
    found.push({ selectors: selectors.split(',').map((part) => part.trim()), body: match[2].trim() });
  }
  return found;
}

test('the crumb label is a discoverable, keyboard-reachable rename target', async () => {
  // SUPERSEDED (owner change of mind, 2026-10-27): "I changed my mind about the
  // pencil icon... let's please instead have a double-click or long-press enter
  // edit mode." The pencil is gone, so the glyph-size claim this test used to
  // make no longer has a subject. What replaces it is the contract that REPLACED
  // the pencil's two jobs, both of which the button got for free and a gesture
  // does not:
  //
  //   * discoverability -- the crumb must carry a title tooltip saying it can be
  //     renamed, because nothing on screen advertises a gesture;
  //   * keyboard reach -- the crumb must be a tab stop, or deleting the button
  //     silently deletes keyboard access with it.
  let app = makeApp({ editingSessionNameID: '', navigationStack: [ { sessionID: 's1' } ] });
  let crumb = mount(buildTopbarCrumb(app, crumbFor()));

  assert.equal(crumb.querySelector('.kikx-icon-button'), null,
    'the rename pencil must not be rendered anywhere in the session crumb');
  assert.equal(crumb.querySelector('svg'), null,
    'and no rename glyph should remain as a non-button svg either');

  let label = crumb.querySelector('.kikx-breadcrumb__crumb--active')
    || crumb.querySelector('.kikx-breadcrumb__crumb')
    || crumb;
  assert.equal(label.getAttribute('tabindex'), '0',
    'the crumb must be a tab stop so F2 can reach it');
  assert.match(label.getAttribute('title') || '', /rename/i,
    'the crumb must advertise that it can be renamed; a gesture is otherwise invisible');
});

test('the Cancel control computes visibility: visible at rest AND while hovered/focused', async () => {
  // The defect the browser caught in the first attempt at the fix: the editor's
  // buttons live INSIDE `.kikx-breadcrumb`, where a rule makes every
  // `.kikx-icon-button` `visibility: hidden` until the trail is hovered or
  // focused. An override that did not beat that rule left the Cancel control
  // invisible -- a way out nobody can see.
  //
  // MEASURED, and it CORRECTS the source comment beside the rule: the hide rule
  // is `.kikx-breadcrumb .kikx-icon-button` = (0,2,0), not (0,4,0); the override
  // is (0,3,0), not (0,5,0); and the override comes BEFORE the hover/focus
  // reveal in the sheet rather than after it. The override therefore wins on one
  // extra class against the hide rule, and merely TIES the reveal rule -- which
  // is harmless only because the reveal sets the same `visible` value.
  //
  // So this does not assert the specificity arithmetic the comment claims (that
  // arithmetic is false). It evaluates the cascade the way the browser does for
  // the Cancel button's real class list, at rest and under both reveal pseudo-
  // states, and asserts that the WINNING `visibility` is `visible`. That is the
  // property the owner's complaint needs, and it stays true regardless of how a
  // future edit reshuffles selectors or source order.
  let sheet = await readFile(new URL('topbar-unified.css', `file://${CSS_ROOT}`), 'utf8');

  // The owner reported this from a desktop browser at 1280px, so the model
  // evaluates a HOVER-CAPABLE viewport. That matters: the sheet also carries an
  // `@media (hover: none)` block that shows the pencil and the editor actions
  // unconditionally on touch. A model that ignored media queries would credit
  // that block on desktop and pass the control below for the wrong reason --
  // which is exactly what happened on the first run of this test.
  let stripNoHoverBlocks = (css) => {
    let out = '';
    let index = 0;
    while (index < css.length) {
      let start = css.indexOf('@media (hover: none)', index);
      if (start < 0) {
        out += css.slice(index);
        break;
      }
      out += css.slice(index, start);
      // Walk to the block's matching close brace so nested rules go with it.
      let open = css.indexOf('{', start);
      let depth = 0;
      let cursor = open;
      for (; cursor < css.length; cursor += 1) {
        if (css[cursor] === '{')
          depth += 1;
        else if (css[cursor] === '}') {
          depth -= 1;
          if (depth === 0)
            break;
        }
      }
      index = cursor + 1;
    }
    return out;
  };

  // The three state combinations the control can be in. `ancestors` models the
  // element's ancestor chain (nearest first), since the mini DOM's matcher only
  // handles descendant combinators and we are not mounting a real tree here.
  let states = [
    { name: 'at rest', pseudo: null },
    { name: 'hovered', pseudo: ':hover' },
    { name: 'focused', pseudo: ':focus-within' },
  ];

  // The Cancel button, in a real edit: it carries both classes, and its chain is
  // breadcrumb__editor -> nav.kikx-breadcrumb.
  let element = { classes: [ 'kikx-breadcrumb__editor-action', 'kikx-icon-button' ], tag: 'button' };
  let ancestors = [ { classes: [ 'kikx-breadcrumb__editor' ], tag: 'div' }, { classes: [ 'kikx-breadcrumb' ], tag: 'nav' } ];

  let winnerForIn = (source, pseudo) => {
    let css = stripNoHoverBlocks(source.replace(/\/\*[\s\S]*?\*\//g, ''));
    let candidates = [];
    let pattern = /([^{}]+)\{([^{}]*)\}/g;
    let match;
    let order = 0;
    while ((match = pattern.exec(css)) !== null) {
      order += 1;
      let body = match[2].trim();
      if (!/(^|[;\s])visibility\s*:/.test(body))
        continue;

      for (let selector of match[1].split(',').map((part) => part.trim())) {
        let compounds = selector.split(/\s+/).filter(Boolean);
        if (compounds.length === 0)
          continue;

        // Match the subject (rightmost compound) against the button.
        let subject = compounds[compounds.length - 1];
        let subjectPseudo = subject.includes(':hover') ? ':hover'
          : subject.includes(':focus-within') ? ':focus-within'
          : null;
        // A state rule in the middle of the chain applies to an ancestor.
        let chainPseudo = compounds.length > 1 && compounds[0].includes(':hover') ? ':hover'
          : compounds.length > 1 && compounds[0].includes(':focus-within') ? ':focus-within'
          : null;

        // The pseudo state we are modelling must be the one the rule depends on;
        // a state rule for a DIFFERENT state does not apply.
        let requiredPseudo = subjectPseudo || chainPseudo;
        if (requiredPseudo && requiredPseudo !== pseudo)
          continue;
        // A rule that depends on no state always applies.
        let subjectClasses = (subject.match(/\.[\w-]+/g) || []).map((part) => part.slice(1));
        let subjectTag = /^([a-zA-Z][\w-]*)/.exec(subject)?.[1];
        if (subjectTag && subjectTag !== element.tag)
          continue;
        if (!subjectClasses.every((name) => element.classes.includes(name)))
          continue;

        // Walk the remaining compounds up the ancestor chain, nearest last.
        let remaining = compounds.slice(0, -1);
        let cursor = 0;
        for (let index = remaining.length - 1; index >= 0; index -= 1) {
          let compound = remaining[index];
          let wanted = (compound.match(/\.[\w-]+/g) || []).map((part) => part.slice(1));
          let found = false;
          while (cursor < ancestors.length) {
            let candidate = ancestors[cursor];
            cursor += 1;
            if (wanted.every((name) => candidate.classes.includes(name))) {
              found = true;
              break;
            }
          }
          if (!found) {
            subjectClasses = null;
            break;
          }
        }
        if (subjectClasses === null)
          continue;

        let value = /(^|[;\s])visibility\s*:\s*([^;]+)/.exec(body)[2].trim();
        candidates.push({ selector, order, value, spec: specificity(selector) });
      }
    }

    // Cascade order: specificity first, then source order.
    candidates.sort((left, right) => {
      for (let index = 0; index < 3; index += 1) {
        if (left.spec[index] !== right.spec[index])
          return left.spec[index] - right.spec[index];
      }
      return left.order - right.order;
    });
    return candidates.at(-1) || null;
  };

  for (let state of states) {
    let winner = winnerForIn(sheet, state.pseudo);
    assert.ok(winner, `some rule must set visibility for the Cancel control ${state.name}`);
    assert.equal(winner.value, 'visible',
      `the Cancel control must be visible ${state.name}; "${winner.selector}" won with "${winner.value}"`);
  }

  // CONTROL for the model itself.
  //
  // The original control re-ran this evaluation against the sheet with the
  // override deleted and expected `hidden` to win. That premise died with the
  // pencil (owner change of mind, 2026-10-27): the
  // `.kikx-breadcrumb .kikx-icon-button { visibility: hidden }` rule it relied on
  // was removed along with the button, so with the override gone there is now NO
  // visibility rule at all and the old control failed looking for one.
  //
  // So the control is synthesised instead, which is the stronger form anyway: it
  // injects a hide rule of EXACTLY the shape that shipped the original bug and
  // requires the model to report `hidden`. If the model could not see a losing
  // rule it would keep returning `visible` and this fails. The assertions above
  // therefore mean something.
  let stripped = sheet.replace(/\/\*[\s\S]*?\*\//g, '');

  // CONTROL A -- a rule that TIES the override and lands after it must win on
  // source order, which is precisely how the original invisible-Cancel bug
  // happened (equal specificity, later rule, `hidden`).
  //
  // The injected selector is written as the SAME selector as the override rather
  // than a hand-counted "equivalent" one. That is deliberate: my first two
  // attempts at this control guessed at the arithmetic, got it wrong both times
  // -- once asserting a (0,2,0) rule could beat the (0,3,0) override, once the
  // reverse -- and each wrong guess surfaced as a failing control rather than as
  // a false green. Copying the selector makes the tie a fact of the text instead
  // of a claim about my counting.
  let tyingHide = `${stripped}\n.kikx-breadcrumb .kikx-breadcrumb__editor .kikx-breadcrumb__editor-action { visibility: hidden; }\n`;
  let defeated = winnerForIn(tyingHide, null);
  assert.ok(defeated, 'CONTROL A: the model must find the injected hide rule');
  assert.equal(defeated.value, 'hidden',
    'CONTROL A: a hide rule that ties the override and comes later must win on source '
    + 'order -- this is the exact shape of the original defect');

  // CONTROL B -- the complementary claim, so neither control can pass by
  // accident. The real override is (0,3,0); against a genuinely weaker (0,2,0)
  // rule it must WIN. A model that returned whatever it found last, or that
  // ignored specificity, cannot satisfy both this and CONTROL A.
  let outranked = `${stripped}\n.kikx-breadcrumb .kikx-icon-button { visibility: hidden; }\n`;
  let outrankedWinner = winnerForIn(outranked, null);
  assert.ok(outrankedWinner, 'CONTROL B: the model must find that rule too');
  assert.equal(outrankedWinner.value, 'visible',
    'CONTROL B: the (0,3,0) editor override must beat a (0,2,0) hide rule wherever it '
    + 'appears in the sheet, which is what makes the Cancel control visible at rest');

});

test('the rename field name constant is what the lookup and all builders share', async () => {
  // A string literal repeated in a builder is how the two names drifted apart in
  // the first place. Assert none of the three homes hardcodes its own name.
  for (let file of [ 'kikx-topbar.mjs', 'kikx-shell-builders.mjs' ]) {
    let source = await readFile(
      fileURLToPath(new URL(`../../src/client/components/${file}`, import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /\.name\(\s*['"]session-name['"]\s*\)/,
      `${file} must use SESSION_NAME_INPUT_NAME, not a repeated literal`);
  }
});
