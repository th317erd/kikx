'use strict';

// Activities view rendering (plan §6.1, §6.4; phase P4).
//
// `kikx-activities-view.mjs` imports the AEOR element DSL and the client state
// module, whose /vendor/... imports are browser-only. Redirect those to the
// local stand-ins first, exactly as the sibling DOM specs do
// (spec/client/inbox-list-spec.mjs:1-20).

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const { buildActivitiesView, buildActivitiesEmptyState, formatActivityAge } =
  await import('../../src/client/components/kikx-activities-view.mjs');

// --- helpers ---------------------------------------------------------------

function walk(node, predicate, found = []) {
  if (!node || typeof node !== 'object')
    return found;

  if (predicate(node))
    found.push(node);

  for (let child of node.childNodes || [])
    walk(child, predicate, found);

  return found;
}

function byClass(root, className) {
  return walk(root, (node) => String(node.className || '').split(/\s+/).includes(className));
}

function textOf(node) {
  return String(node?.textContent ?? '').trim();
}

// A minimal app shaped like the real one: the view reads through
// `getSessions`/`getQuestionsState`/`getCurrentSessionID`, all of which read
// `_state`. `derived` is passed through options to keep these tests independent
// of the stats module's own spec.
function appWith(state = {}) {
  return {
    _state: {
      sessionIDs: [],
      sessionDetailsByID: {},
      navigationStack: [ { sessionID: null, collapsed: true } ],
      questionsState: { questions: [], counts: { open: 0 }, loaded: true },
      ...state,
    },
  };
}

function projectStats(overrides = {}) {
  return {
    sessionID: 'proj_1',
    title: 'Kikx maintenance',
    sessionCount: 3,
    openQuestions: 2,
    messageCount: 41,
    lastActivity: 1_000,
    agentCount: 2,
    agentIDs: [ 'a1', 'a2' ],
    ...overrides,
  };
}

// --- formatActivityAge -----------------------------------------------------

test('formatActivityAge describes a missing or invalid stamp as no activity', () => {
  assert.equal(formatActivityAge(0), 'no activity');
  assert.equal(formatActivityAge(undefined), 'no activity');
  assert.equal(formatActivityAge(null), 'no activity');
  assert.equal(formatActivityAge(Number.NaN), 'no activity');
});

test('formatActivityAge tolerates clock skew instead of printing a negative age', () => {
  // A server stamp slightly ahead of this tab must not read "-1m ago".
  assert.equal(formatActivityAge(Date.now() + 5_000), 'just now');
});

test('formatActivityAge scales through minutes, hours and days', () => {
  let now = 10_000_000_000;
  assert.equal(formatActivityAge(now - 5_000, now), 'just now');
  assert.equal(formatActivityAge(now - 60_000, now), '1m ago');
  assert.equal(formatActivityAge(now - 5 * 60_000, now), '5m ago');
  assert.equal(formatActivityAge(now - 3 * 3_600_000, now), '3h ago');
  assert.equal(formatActivityAge(now - 2 * 86_400_000, now), '2d ago');
});

// --- workspace scope -------------------------------------------------------

test('buildActivitiesView summarises every project at the root', () => {
  let node = buildActivitiesView(appWith(), {
    now: 10_000,
    derived: {
      scope: 'workspace',
      current: null,
      projects: [
        projectStats({ sessionID: 'proj_1', title: 'Alpha' }),
        projectStats({ sessionID: 'proj_2', title: 'Beta', openQuestions: 0 }),
      ],
      children: [],
    },
  });

  let cards = byClass(node, 'kikx-activities__card');
  assert.equal(cards.length, 2, 'one card per project');
  assert.match(textOf(node), /Alpha/);
  assert.match(textOf(node), /Beta/);
});

test('a project with open questions is flagged as needing attention', () => {
  let node = buildActivitiesView(appWith(), {
    now: 10_000,
    derived: {
      scope: 'workspace',
      projects: [
        projectStats({ sessionID: 'p_needs', title: 'Needs', openQuestions: 3 }),
        projectStats({ sessionID: 'p_clear', title: 'Clear', openQuestions: 0 }),
      ],
      children: [],
    },
  });

  let flagged = byClass(node, 'kikx-activities__card--attention');
  assert.equal(flagged.length, 1, 'only the project with open questions is flagged');
  assert.match(textOf(flagged[0]), /Needs/);
});

test('the stat row reports sessions, open questions, messages and agents', () => {
  let node = buildActivitiesView(appWith(), {
    now: 10_000,
    derived: {
      scope: 'workspace',
      projects: [ projectStats({ sessionCount: 4, openQuestions: 7, messageCount: 123, agentCount: 5 }) ],
      children: [],
    },
  });

  let values = byClass(node, 'kikx-activities__stat-value').map(textOf);
  assert.deepEqual(values, [ '4', '7', '123', '5' ]);

  let labels = byClass(node, 'kikx-activities__stat-label').map(textOf);
  assert.deepEqual(labels, [ 'sessions', 'open questions', 'messages', 'agents' ]);
});

test('the workspace scope shows the empty state when there are no projects', () => {
  let node = buildActivitiesView(appWith(), {
    derived: { scope: 'workspace', current: null, projects: [], children: [] },
  });

  assert.equal(byClass(node, 'kikx-activities__card').length, 0);
  assert.ok(byClass(node, 'kikx-activities__empty').length >= 1);
  assert.match(textOf(node), /No projects yet/);
});

test('buildActivitiesEmptyState states the next step rather than only the problem', () => {
  // NB: build() is required — an unbuilt AEOR builder proxy exposes attribute
  // setters as functions, so reading textContent off it returns a function
  // source string rather than the text. Every other assertion here reads a
  // built tree; this one must too.
  let node = buildActivitiesEmptyState();
  let built = node.build(document);
  assert.match(textOf(built), /No projects yet/);
  assert.match(textOf(built), /Create a session/);
});

// --- session scope ---------------------------------------------------------

test('inside a session the view shows that project plus its sub-sessions', () => {
  let node = buildActivitiesView(appWith(), {
    now: 10_000,
    derived: {
      scope: 'session',
      currentSessionID: 'proj_1',
      current: projectStats({ title: 'Parent project' }),
      projects: [],
      children: [
        projectStats({ sessionID: 'child_1', title: 'Child one' }),
        projectStats({ sessionID: 'child_2', title: 'Child two' }),
      ],
    },
  });

  assert.match(textOf(node), /Parent project/);
  assert.match(textOf(node), /Sub-sessions/);

  let children = byClass(node, 'kikx-activities__child');
  assert.equal(children.length, 2, 'one row per sub-session');
  assert.match(textOf(children[0]), /Child one/);
});

test('a project with no sub-sessions says so instead of rendering an empty list', () => {
  let node = buildActivitiesView(appWith(), {
    now: 10_000,
    derived: {
      scope: 'session',
      currentSessionID: 'proj_1',
      current: projectStats({ title: 'Lonely project' }),
      projects: [],
      children: [],
    },
  });

  assert.equal(byClass(node, 'kikx-activities__child').length, 0);
  assert.match(textOf(node), /No sub-sessions yet/);
});

// --- robustness (S1 containment) ------------------------------------------

test('buildActivitiesView never throws on an empty app', () => {
  // S1: a render failure must not wedge the shell. A missing state slice is a
  // normal pre-fetch condition, not an error.
  assert.doesNotThrow(() => buildActivitiesView({}));
  assert.doesNotThrow(() => buildActivitiesView({ _state: {} }));
});

test('buildActivitiesView falls back to a titled section when the render throws', () => {
  // A throwing stats module must degrade to a labelled panel, never a blank app.
  let node = buildActivitiesView(appWith(), {
    derived: {
      get scope() {
        throw new Error('boom');
      },
    },
  });

  assert.ok(node, 'a node is still returned');
  assert.match(textOf(node), /Activities/);
});

test('render is pure: the same derived input produces the same markup twice', () => {
  let options = {
    now: 10_000,
    derived: { scope: 'workspace', projects: [ projectStats() ], children: [] },
  };

  assert.equal(textOf(buildActivitiesView(appWith(), options)), textOf(buildActivitiesView(appWith(), options)));
});
