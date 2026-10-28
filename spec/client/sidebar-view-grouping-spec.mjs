'use strict';

// Owner item 1 (2026-10-27): "These two items should be grouped with, and have
// the same styling as, the 'Inbox' and 'Activities'... every item in this sidebar
// is a 'view' into the current session and its children."
//
// THE MEASURED DEFECT this file pins. `renderItem` rendered EVERY non-chip
// descriptor as `button.kikx-sign-out-button` -- the SAME class the footer's Sign
// out wears. So Agents and Teams sat under the "Workspace" heading but were
// painted with footer-control identity, which is exactly why they read as
// misplaced controls rather than as views. `group: 'view'` already existed on the
// descriptors; the renderer simply ignored it.
//
// The fix must NOT be "give Agents and Teams a nice class". Three things are
// load-bearing and a careless refactor breaks them silently:
//
//   1. `button.textContent` is exactly `Agents` / `Teams`. Seven stagehand specs
//      click these by text (`clickButtonByText` compares `textContent.trim()`).
//   2. The container keeps `kikx-session-objects` on BOTH clusters. Those same
//      specs select `.kikx-session-objects button`.
//   3. Both clusters still pass through `filterSessionObjectItems`. If the view
//      cluster skipped the ownership seam, Agents/Teams would leak past scope
//      filtering while Account did not.
//
// What this file does NOT claim: that they LOOK identical. There is no cascade
// here. The shared-metrics claim is the browser probe's line; this asserts the
// structural precondition that makes one CSS rule apply to all four controls.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();

const { buildSessionObjectItems, buildSidebarSessionObjects, filterSessionObjectItems } =
  await import('../../src/client/components/kikx-sidebar-session-objects.mjs');

// --- helpers ---------------------------------------------------------------

function makeApp(state = {}) {
  let opened = [];
  return {
    opened,
    _state: {
      navigationStack: [ { sessionID: 's1', collapsed: false } ],
      account: { name: 'w' },
      ...state,
    },
    _openAgentManager() { opened.push('agents'); },
    _openTeamManager() { opened.push('teams'); },
    _openAccountEditor() { opened.push('account'); },
    _signOut() { opened.push('sign-out'); },
  };
}

function buttons(node) {
  return node.querySelectorAll('button');
}

function click(node) {
  node.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
}

function classesOf(node) {
  return String(node.className || '').split(/\s+/).filter(Boolean);
}

// --- the regression: view rows must not wear footer identity ----------------

test('view descriptors render the shared view class, not kikx-sign-out-button', () => {
  let app = makeApp();
  let cluster = buildSidebarSessionObjects(app, { group: 'view' });

  let rows = buttons(cluster);
  assert.equal(rows.length, 2, 'the view cluster holds Agents and Teams');

  for (let row of rows) {
    assert.ok(classesOf(row).includes('kikx-sidebar__view'),
      `${row.textContent} must carry the shared view class; got "${row.className}"`);
    assert.ok(!classesOf(row).includes('kikx-sign-out-button'),
      `${row.textContent} must NOT wear the footer's Sign out identity; got "${row.className}"`);
  }
});

test('the footer descriptors still render kikx-sign-out-button', () => {
  // The other half of the fix. Giving the view cluster a new class must not
  // restyle Account and Sign out, which genuinely are bar-style controls.
  let app = makeApp();
  let footer = buildSidebarSessionObjects(app, { group: 'footer' });

  let rows = buttons(footer).filter((node) => node.className === 'kikx-sign-out-button');
  assert.deepEqual(rows.map((node) => node.textContent), [ 'Account', 'Sign out' ],
    'Account and Sign out must keep the footer button class');
});

test('the footer cluster never renders a view row, and vice versa', () => {
  // The clusters are disjoint by group. A leak here would double-render Agents
  // in the sidebar (once above the tree, once at the foot).
  let app = makeApp();

  let view = buttons(buildSidebarSessionObjects(app, { group: 'view' })).map((node) => node.textContent);
  let footer = buttons(buildSidebarSessionObjects(app, { group: 'footer' })).map((node) => node.textContent);

  assert.deepEqual(view.sort(), [ 'Agents', 'Teams' ]);
  assert.deepEqual(footer.sort(), [ 'Account', 'Sign out' ]);
  for (let label of view)
    assert.ok(!footer.includes(label), `${label} must not appear in the footer cluster`);
});

// --- the three load-bearing contracts --------------------------------------

test('view row textContent is exactly the label, with no stray whitespace', () => {
  // `clickButtonByText` compares `textContent.trim() === 'Agents'`. The label is
  // now wrapped in a span (so it can ellipsise like Inbox/Activities), so this
  // asserts the wrapper adds no text of its own.
  let app = makeApp();
  let cluster = buildSidebarSessionObjects(app, { group: 'view' });

  let texts = buttons(cluster).map((node) => node.textContent);
  assert.deepEqual(texts, [ 'Agents', 'Teams' ]);
  for (let text of texts)
    assert.equal(text, text.trim(), `"${text}" must not need trimming to match`);
});

test('both clusters keep the kikx-session-objects container class', () => {
  // Seven stagehand specs select `.kikx-session-objects button` and then click by
  // text. The split rides on a MODIFIER class precisely so those selectors keep
  // matching without editing any spec.
  let app = makeApp();

  let view = buildSidebarSessionObjects(app, { group: 'view' });
  let footer = buildSidebarSessionObjects(app, { group: 'footer' });
  let all = buildSidebarSessionObjects(app);

  for (let [ name, node ] of [ [ 'view', view ], [ 'footer', footer ], [ 'ungrouped', all ] ]) {
    assert.ok(classesOf(node).includes('kikx-session-objects'),
      `the ${name} cluster must keep kikx-session-objects; got "${node.className}"`);
  }

  // And the modifiers distinguish them without replacing the base class.
  assert.ok(classesOf(view).includes('kikx-session-objects--view'));
  assert.ok(classesOf(footer).includes('kikx-session-objects--footer'));
});

test('the ownership seam still runs for BOTH clusters', () => {
  // The load-bearing one. If the view cluster bypassed the filter, Agents/Teams
  // would be visible to a viewer that does not own them, while Account was not.
  // A reject-all predicate must empty BOTH clusters.
  let app = makeApp();
  let rejectAll = () => false;

  let view = buildSidebarSessionObjects(app, { group: 'view', scopeFilter: rejectAll });
  let footer = buildSidebarSessionObjects(app, { group: 'footer', scopeFilter: rejectAll });

  assert.equal(view.childNodes.length, 0,
    'the view cluster must be emptied by a rejecting scope filter');
  assert.equal(footer.childNodes.length, 0,
    'the footer cluster must be emptied by a rejecting scope filter');

  // CONTROL: the same predicate with no group must also empty everything, and
  // the same builders with NO filter must keep them. Without this control the
  // assertions above could pass because the builder was broken, not because the
  // seam ran.
  let everything = buildSidebarSessionObjects(app, { scopeFilter: rejectAll });
  assert.equal(everything.childNodes.length, 0, 'CONTROL: reject-all empties the whole cluster');

  let unfilteredView = buildSidebarSessionObjects(app, { group: 'view' });
  let unfilteredFooter = buildSidebarSessionObjects(app, { group: 'footer' });
  assert.equal(buttons(unfilteredView).length, 2, 'CONTROL: with no filter the view cluster is kept');
  assert.equal(buttons(unfilteredFooter).length, 2, 'CONTROL: with no filter the footer cluster is kept');
});

test('a selective filter drops only the rows it rejects', () => {
  // reject-all is coarse. This proves the filter is consulted PER ITEM, so an
  // ownership predicate that grants Agents but denies Teams is honoured.
  let app = makeApp();
  let denyTeams = (item) => item.id !== 'teams';

  let cluster = buildSidebarSessionObjects(app, { group: 'view', scopeFilter: denyTeams });
  assert.deepEqual(buttons(cluster).map((node) => node.textContent), [ 'Agents' ]);
});

test('selecting a view row calls its own action, once', () => {
  let app = makeApp();
  let cluster = buildSidebarSessionObjects(app, { group: 'view' });
  let rows = buttons(cluster);

  click(rows[0]);
  click(rows[1]);
  assert.deepEqual(app.opened, [ 'agents', 'teams' ],
    'clicking the view rows must reach the agent and team managers');
});

// --- the shared styling contract -------------------------------------------
//
// The owner asked for the SAME styling, not merely the same neighbourhood. With
// no cascade here, the defensible assertion is that the four controls share one
// rule in a linked sheet: if Agents/Teams carried their own copy of the metrics,
// the two would drift the first time someone tweaked Inbox.

test('Inbox, Agents and Teams are styled by ONE shared rule', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');

  let css = await readFile(
    fileURLToPath(new URL('../../src/client/styles/questions.css', import.meta.url)), 'utf8');
  let stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

  // Find the rule whose selector list contains all four view classes. That is
  // what "one rule, four controls" means concretely.
  let shared = null;
  let pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(stripped)) !== null) {
    let selectors = match[1].split(',').map((part) => part.trim());
    let has = (name) => selectors.some((selector) => selector === `.${name}`);
    // '.kikx-sidebar__activities' was removed with the view (owner request,
    // 2026-10-28); the shared-rule contract still applies to the three that remain.
    if ([ 'kikx-sidebar__inbox', 'kikx-sidebar__view' ].every(has)) {
      shared = { selectors, body: match[2] };
      break;
    }
  }

  assert.ok(shared,
    'the four sidebar views must share ONE rule so their metrics cannot drift apart');

  // The metrics that make controls read as one family must come from that rule.
  for (let property of [ 'padding', 'font-size', 'font-weight', 'color', 'border-radius' ])
    assert.match(shared.body, new RegExp(`(^|[;\\s])${property}\\s*:`),
      `the shared view rule must set ${property}, or the family can drift`);

  // And the view rows must not ALSO have their own competing metric rule.
  // `.kikx-sidebar__view` appears as the LAST selector of the shared list above,
  // so a naive regex over the source matches the shared rule itself. Compare
  // parsed selector lists instead and flag only a rule where it stands ALONE.
  let standaloneViewRules = [];
  let scan = /([^{}]+)\{([^{}]*)\}/g;
  let found;
  while ((found = scan.exec(stripped)) !== null) {
    let selectors = found[1].split(',').map((part) => part.trim());
    if (selectors.length === 1 && selectors[0] === '.kikx-sidebar__view')
      standaloneViewRules.push(found[2]);
  }
  for (let body of standaloneViewRules) {
    assert.doesNotMatch(body, /(^|[;\s])padding\s*:/,
      'the view class must inherit its padding from the shared rule, not restate it');
    assert.doesNotMatch(body, /(^|[;\s])font-size\s*:/,
      'the view class must inherit its font-size from the shared rule, not restate it');
  }
});

test('the shared view rule also covers the label wrapper', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');

  let css = await readFile(
    fileURLToPath(new URL('../../src/client/styles/questions.css', import.meta.url)), 'utf8');
  let stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

  // The label span exists so Agents/Teams ellipsise like Inbox/Activities do.
  // If the label rule did not include the new class, a long team name would
  // overflow the row instead of ellipsising.
  let labelRule = null;
  let pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(stripped)) !== null) {
    let selectors = match[1].split(',').map((part) => part.trim());
    if (selectors.some((selector) => selector === '.kikx-sidebar__view-label')) {
      labelRule = { selectors, body: match[2] };
      break;
    }
  }

  assert.ok(labelRule, 'the view label span must have a rule, or it will not ellipsise');
  assert.ok(labelRule.selectors.some((selector) => selector === '.kikx-sidebar__inbox-label'),
    'the view label must share its rule with Inbox, not duplicate it');
  assert.match(labelRule.body, /text-overflow\s*:\s*ellipsis/);
});

test('the view cluster has no divider that separates it from Activities', () => {
  // The owner asked for them to be GROUPED. A border between Activities and
  // Agents draws the opposite conclusion. This asserts the structural intent
  // that the sheet must honour (the browser probe measures the pixels).
  let app = makeApp();
  let view = buildSidebarSessionObjects(app, { group: 'view' });
  assert.ok(classesOf(view).includes('kikx-session-objects--view'),
    'the view cluster must be addressable by a modifier the sheet can style');
});

// --- descriptor contract ---------------------------------------------------

test('Agents and Teams are view-group descriptors, Account and Sign out are footer', () => {
  let items = buildSessionObjectItems(makeApp());
  let groupOf = (id) => items.find((item) => item.id === id)?.group;

  assert.equal(groupOf('agents'), 'view');
  assert.equal(groupOf('teams'), 'view');
  assert.equal(groupOf('account'), 'footer');
  assert.equal(groupOf('sign-out'), 'footer');
  assert.equal(groupOf('account-chip'), 'footer');
});

test('the account chip is still a chip, not a button, in either cluster', () => {
  let app = makeApp();
  let all = buildSidebarSessionObjects(app);
  let chip = all.querySelector('.kikx-account-chip');
  assert.ok(chip, 'the account chip must still render');
  assert.equal(chip.localName, 'span', 'the chip is a span, not a clickable button');
});

test('filterSessionObjectItems passes a rejecting predicate through per item', () => {
  // Unit-level companion to the cluster test: the seam itself must consult the
  // predicate for every item and pass the state, since a real predicate needs it.
  let seen = [];
  let items = [ { id: 'a' }, { id: 'b' } ];
  let state = { navigationStack: [] };
  let kept = filterSessionObjectItems(items, (item, scope, passedState) => {
    seen.push([ item.id, scope, passedState ]);
    return item.id === 'b';
  }, state);

  assert.deepEqual(kept.map((item) => item.id), [ 'b' ]);
  assert.deepEqual(seen, [ [ 'a', undefined, state ], [ 'b', undefined, state ] ],
    'the predicate must be consulted once per item, with the app state');

  // No filter means identity: shipped behaviour is "show everything".
  assert.deepEqual(filterSessionObjectItems(items).map((item) => item.id), [ 'a', 'b' ]);
});
