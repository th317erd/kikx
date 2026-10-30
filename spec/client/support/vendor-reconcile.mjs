'use strict';

// Node-side stand-in for the framework reconcile helpers. The real helpers are
// covered by the AEOR browser harness; Kikx unit specs only need module shape.
export function createKeyedList() {
  return { update() {}, dispose() {}, get() { return null; }, size: 0, nodes: [] };
}

export function patchProperties() { return []; }
export function patchAttributes() { return []; }
export function bindProperty() { return () => {}; }
