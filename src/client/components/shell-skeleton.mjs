'use strict';

// =============================================================================
// Shell skeleton transplant (plan §9.3.13 — the DOM identity gate)
// =============================================================================
// Why this module exists: the identity spec asserts that entering System
// Settings keeps the shell root, the sidebar and the Workspace header as the
// SAME nodes. `renderAppShell` used to empty() the app and append a fresh
// tree every paint, so the assertion failed exactly as designed.
//
// The contract, in one paragraph: a paint builds a COMPLETE new tree (fresh
// leaves — that is what keeps every static onClick closure current), then
// this module grafts the four-node preserved chain (shell > main > sidebar >
// header) out of the live DOM into the new tree, moves the fresh children
// into those preserved containers, and reports the replaced old leaves so the
// caller can run binding teardown on them. Anything that does not line up —
// no previous shell, a non-shell root (auth screen), a missing level — makes
// it return false and touch nothing; the caller then falls back to the
// historical empty-and-append path.
//
// Deliberate limits: it preserves IDENTITY, not content. The Workspace header
// is static text today; the moment its text changes between paints the
// transplant swaps in the fresh node instead of freezing the old one (asserted
// in spec/client/shell-skeleton-spec.mjs).

function elementChildren(node) {
  return Array.from((node && node.childNodes) || []).filter((child) => child && child.nodeType === 1);
}

function classNames(node) {
  if (!node) return [];
  const raw = typeof node.className === 'string' ? node.className : (node.getAttribute ? node.getAttribute('class') : '') || '';
  return raw.split(/\s+/).filter(Boolean);
}

function hasClass(node, name) {
  return classNames(node).includes(name);
}

function nodeID(node) {
  if (!node) return '';
  if (typeof node.id === 'string' && node.id !== '') return node.id;
  return (node.getAttribute && node.getAttribute('id')) || '';
}

function firstChildWhere(parent, predicate) {
  if (!parent) return null;
  for (const child of elementChildren(parent)) {
    if (predicate(child)) return child;
  }
  return null;
}

function findChain(scope, shellPredicate) {
  const shell = firstChildWhere(scope, shellPredicate);
  const main = firstChildWhere(shell, (node) => hasClass(node, 'kikx-main'));
  const sidebar = firstChildWhere(main, (node) => nodeID(node) === 'kikx-sidebar-menu');
  const header = firstChildWhere(sidebar, (node) => hasClass(node, 'kikx-sessions__header'));
  return { shell, main, sidebar, header };
}

// The live chain: looked up among the app element's own children so a
// standalone sibling (the pre-build error surface) can never be mistaken for
// the shell.
export function captureShellChain(app) {
  return findChain(app, (node) => hasClass(node, 'kikx-shell'));
}

// The freshly built tree's chain: the root itself is the shell.
export function captureTreeChain(tree) {
  if (!tree || !hasClass(tree, 'kikx-shell'))
    return { shell: null, main: null, sidebar: null, header: null };
  const main = firstChildWhere(tree, (node) => hasClass(node, 'kikx-main'));
  const sidebar = firstChildWhere(main, (node) => nodeID(node) === 'kikx-sidebar-menu');
  const header = firstChildWhere(sidebar, (node) => hasClass(node, 'kikx-sessions__header'));
  return { shell: tree, main, sidebar, header };
}

function textOf(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.textContent || '';
  let out = '';
  for (const child of node.childNodes || []) out += textOf(child);
  return out;
}

// Graft `previous` (live) into `tree` (fresh) and move fresh children in.
// Returns false — having touched nothing — unless both chains are complete.
// `onDiscard(node)` fires for every replaced old leaf ROOT and for fresh
// nodes that lost their slot, so the caller can run cleanupBindings on them.
export function transplantShellSkeleton({ app, tree, previous, next, onDiscard = () => {} }) {
  if (!app || !tree || !previous || !next) return false;
  const { shell: prevShell, main: prevMain, sidebar: prevSidebar, header: prevHeader } = previous;
  const { shell: nextShell, main: nextMain, sidebar: nextSidebar, header: nextHeader } = next;
  if (!prevShell || !prevMain || !prevSidebar || !prevHeader) return false;
  if (!nextShell || !nextMain || !nextSidebar || !nextHeader) return false;
  // The preserved nodes must still be where we found them.
  if (prevShell.parentNode !== app) return false;

  // Old leaves = the direct children being replaced at each preserved level.
  const discardedRoots = [
    ...elementChildren(prevShell).filter((node) => node !== prevMain),
    ...elementChildren(prevMain).filter((node) => node !== prevSidebar),
    ...elementChildren(prevSidebar).filter((node) => node !== prevHeader),
  ];

  // Detach the preserved chain FIRST and graft entirely OFF-DOCUMENT. Fresh
  // nodes must connect to the document exactly ONCE — the final mount. The
  // historical empty-and-append gave every node a single connect; grafting
  // through still-connected ancestors made each fresh node connect and
  // disconnect several times mid-transplant, which re-ran custom-element
  // lifecycles (scrollview and popup re-init), double-fired observers, made
  // renders ~3x slower and broke in-flight interactions. The preserved chain
  // holds only plain elements, so its disconnect is harmless; the discarded
  // leaves disconnect here too — exactly what the old empty() did.
  prevShell.remove();

  // Header first (it sits deepest): identical text keeps the old node, so the
  // gate's third selector holds; changed text keeps the FRESH one instead of
  // freezing stale content.
  const headerKept = textOf(prevHeader) === textOf(nextHeader);
  if (headerKept) {
    onDiscard(nextHeader);
    nextHeader.replaceWith(prevHeader);
  }

  prevSidebar.replaceChildren(...elementChildren(nextSidebar));
  nextSidebar.replaceWith(prevSidebar);

  prevMain.replaceChildren(...elementChildren(nextMain));
  nextMain.replaceWith(prevMain);

  prevShell.replaceChildren(...elementChildren(nextShell));

  // Single mount: the assembled tree (preserved chain + fresh leaves)
  // connects once, matching the old flow's one appendChild.
  app.appendChild(prevShell);

  for (const root of discardedRoots) onDiscard(root);
  if (!headerKept) onDiscard(prevHeader);
  // The graft shells themselves are spent scaffolding.
  onDiscard(nextShell);
  onDiscard(nextMain);
  onDiscard(nextSidebar);
  if (headerKept) onDiscard(nextHeader);

  return true;
}
