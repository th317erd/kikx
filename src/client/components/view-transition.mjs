'use strict';

// Shared-element name bridging the mini card's chat view (grid) and the full
// chat view (thread) during a maximize/minimize transition.
export const HERO_VIEW_TRANSITION_NAME = 'kikx-chat-hero';

export function prefersReducedMotion(win = globalThis) {
  return typeof win?.matchMedia === 'function'
    && win.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Whether the environment can run a seamless shared-element transition.
export function supportsViewTransitions(doc = globalThis.document, win = globalThis) {
  return typeof doc?.startViewTransition === 'function'
    && !prefersReducedMotion(win);
}

// Attach/detach the hero name. Only one element should carry it per snapshot,
// so callers must clear the source before/while naming the target.
export function setViewTransitionName(element, name) {
  if (!element || !element.style)
    return;

  element.style.viewTransitionName = name || '';
}

// Run a state change inside a view transition when supported, otherwise apply
// it immediately. `apply` may be async; the browser awaits it before taking the
// "after" snapshot.
export function runViewTransition(apply, doc = globalThis.document, win = globalThis) {
  if (!supportsViewTransitions(doc, win))
    return Promise.resolve(apply());

  let transition = doc.startViewTransition(apply);
  return transition?.finished ?? Promise.resolve();
}
