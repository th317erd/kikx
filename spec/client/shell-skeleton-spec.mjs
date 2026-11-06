'use strict';

// =============================================================================
// Shell skeleton transplant — DOM identity across paints (plan §9.3.13)
// =============================================================================
// The identity gate says entering System Settings (or any view swap) must not
// replace the shell ROOT or the SIDEBAR: same nodes before and after. The old
// commit (`$(app).empty(); app.appendChild(tree)`) tore everything down on
// every paint, which is exactly what the gate failed on.
//
// The transplant keeps a PRESERVED CHAIN — shell root, .kikx-main,
// #kikx-sidebar-menu, its .kikx-sessions__header — and moves each paint's
// FRESH children into it. Leaves are always rebuilt: that is deliberate, not
// a compromise. Static DSL `onClick` closures capture builder-time values
// (crumb ids, row descriptors), and only a fresh leaf guarantees those
// closures match current data. The preserved nodes' own handlers capture
// only `app` (stable), and their state bindings stay subscribed — the bound
// `kikx-shell--menu-open` class survives with the root.
//
// Discarded roots are exactly the direct children being replaced at each
// preserved level; their `__bindings` must be torn down (skill rule) while the
// preserved chain's bindings are never touched.

import assert from 'node:assert/strict';
import test from 'node:test';

import { captureShellChain, captureTreeChain, transplantShellSkeleton } from '../../src/client/components/shell-skeleton.mjs';

const { createElement, text } = (() => {
  // Minimal plain-object DOM: the transplant only needs childNodes, nodeType,
  // className, id, replaceChildren, replaceWith, remove — no browser, no
  // mini-dom, so this spec isolates the transplant algorithm itself.
  function el(tag, className = '', id = '', children = []) {
    const node = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      localName: tag,
      className,
      id,
      childNodes: [],
      parentNode: null,
      replaceChildren(...nodes) {
        for (const child of [ ...this.childNodes ]) child.parentNode = null;
        this.childNodes = [];
        for (const node of nodes) {
          node.parentNode = this;
          this.childNodes.push(node);
        }
      },
      replaceWith(other) {
        const parent = this.parentNode;
        if (!parent) return;
        const index = parent.childNodes.indexOf(this);
        parent.childNodes[index] = other;
        other.parentNode = parent;
        this.parentNode = null;
      },
      remove() {
        const parent = this.parentNode;
        if (!parent) return;
        const index = parent.childNodes.indexOf(this);
        parent.childNodes.splice(index, 1);
        this.parentNode = null;
      },
    };
    node.replaceChildren(...children);
    return node;
  }
  return { createElement: el, text: (value) => ({ nodeType: 3, textContent: value }) };
})();

// Build a shell-shaped tree: shell > (topbar, main > (sidebar > (header,
// clusters...), workarea), statusbar?).
function buildTree({ shellClass = 'kikx-shell', withStatus = true, headerText = 'Workspace', mark = {} } = {}) {
  const header = createElement('div', 'kikx-sessions__header', '', [ createElement('h2', '', '', [ text(headerText) ]) ]);
  const clusters = createElement('div', 'kikx-session-objects kikx-session-objects--view');
  const sidebar = createElement('section', '', 'kikx-sidebar-menu', [ header, clusters ]);
  const workarea = createElement('div', mark.workareaClass || 'kikx-window');
  const main = createElement('main', 'kikx-main', '', [ sidebar, workarea ]);
  const topbar = createElement('header', 'kikx-topbar kikx-window__header');
  const children = [ topbar, main ];
  if (withStatus) children.push(createElement('div', 'kikx-statusbar'));
  const shell = createElement('div', shellClass, '', children);
  return { shell, topbar, main, sidebar, header, clusters, workarea, workarea2: null };
}

function makeApp(tree) {
  const app = {
    childNodes: [],
    children: [],
    appendChild(node) {
      node.parentNode = this;
      this.childNodes.push(node);
      this.children.push(node);
      return node;
    },
  };
  const root = tree.shell;
  root.parentNode = app;
  app.childNodes.push(root);
  app.children.push(root);
  return app;
}

test('captureShellChain finds the preserved chain in a live app, nulls when absent', () => {
  const built = buildTree();
  const app = makeApp(built);

  const previous = captureShellChain(app);
  assert.ok(previous.shell, 'shell root found');
  assert.ok(previous.main, 'main found');
  assert.ok(previous.sidebar, 'sidebar found');
  assert.ok(previous.header, 'workspace header found');
  assert.equal(previous.sidebar.id, 'kikx-sidebar-menu');

  const emptyApp = { childNodes: [], children: [] };
  const none = captureShellChain(emptyApp);
  assert.deepEqual(
    [ none.shell, none.main, none.sidebar, none.header ],
    [ null, null, null, null ],
    'an empty app captures nothing (first render path)',
  );
});

test('captureTreeChain finds the same shape in a freshly built tree', () => {
  const built = buildTree();
  const next = captureTreeChain(built.shell);
  assert.ok(next.shell && next.main && next.sidebar && next.header);
  assert.equal(next.shell, built.shell);
});

test('transplant: preserved nodes survive, leaves are replaced, ordering holds', () => {
  const previousBuilt = buildTree({ mark: { workareaClass: 'kikx-old-window' } });
  const app = makeApp(previousBuilt);
  const previous = captureShellChain(app);

  const fresh = buildTree({ mark: { workareaClass: 'kikx-new-window' } });
  const next = captureTreeChain(fresh.shell);

  const discarded = [];
  const transplanted = transplantShellSkeleton({ app, tree: fresh.shell, previous, next, onDiscard: (node) => discarded.push(node) });

  assert.equal(transplanted, true, 'a matching chain transplants');

  // The gate, structurally: the SAME nodes are still in the document.
  assert.equal(captureShellChain(app).shell, previous.shell, 'shell root identity kept');
  assert.equal(captureShellChain(app).main, previous.main, 'main identity kept');
  assert.equal(captureShellChain(app).sidebar, previous.sidebar, 'sidebar identity kept');
  assert.equal(captureShellChain(app).header, previous.header, 'workspace header identity kept');

  // Fresh leaves took their slots, in builder order (topbar before main).
  const shellChildren = previous.shell.childNodes;
  assert.equal(shellChildren[0], fresh.topbar, 'topbar is the fresh leaf');
  assert.equal(shellChildren[1], previous.main, 'then the preserved main');
  const mainChildren = previous.main.childNodes;
  assert.equal(mainChildren[0], previous.sidebar, 'sidebar preserved inside main');
  assert.equal(mainChildren[1], fresh.workarea, 'work area is the fresh leaf');
  assert.equal(previous.sidebar.childNodes[1], fresh.clusters, 'clusters are fresh inside the preserved sidebar');

  // Discard report: old leaves only — never the preserved chain.
  const discardedSet = new Set(discarded);
  assert.ok(discardedSet.has(previousBuilt.topbar), 'old topbar is discarded');
  assert.ok(discardedSet.has(previousBuilt.workarea), 'old work area is discarded');
  assert.ok(discardedSet.has(previousBuilt.clusters), 'old clusters are discarded');
  assert.ok(!discardedSet.has(previous.shell) && !discardedSet.has(previous.main)
    && !discardedSet.has(previous.sidebar) && !discardedSet.has(previous.header),
  'the preserved chain must never be reported for teardown');
});

test('transplant: a header whose text changed falls back to the fresh header', () => {
  // The Workspace heading is static today; if it ever gains dynamic text,
  // reusing the old node would freeze it. The transplant must notice and keep
  // the fresh one (identity then applies to the levels that still match).
  const previousBuilt = buildTree({ headerText: 'Workspace' });
  const app = makeApp(previousBuilt);
  const previous = captureShellChain(app);

  const fresh = buildTree({ headerText: 'Workspace (renamed)' });
  const next = captureTreeChain(fresh.shell);

  const discarded = [];
  transplantShellSkeleton({ app, tree: fresh.shell, previous, next, onDiscard: (node) => discarded.push(node) });

  assert.equal(previous.sidebar.childNodes[0], fresh.header, 'changed header content uses the fresh node');
  assert.ok(discarded.includes(previous.header), 'the stale header is discarded');
  assert.equal(captureShellChain(app).sidebar, previous.sidebar, 'sidebar identity still holds');
});

test('transplant refuses a structural mismatch (returns false, touches nothing)', () => {
  const previousBuilt = buildTree();
  const app = makeApp(previousBuilt);
  const previous = captureShellChain(app);

  // A tree whose root is not a shell (e.g. the auth screen): no chain to graft.
  const notShell = createElement('div', 'kikx-auth');
  const next = { shell: null, main: null, sidebar: null, header: null };

  const before = app.childNodes.slice();
  const transplanted = transplantShellSkeleton({ app, tree: notShell, previous, next, onDiscard: () => {} });
  assert.equal(transplanted, false, 'mismatched structure must not graft');
  assert.deepEqual(app.childNodes, before, 'the live DOM is untouched on refusal');
});
