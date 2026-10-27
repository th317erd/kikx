'use strict';

// The shared session tree for the ownership specs.
//
//   root            <- the "project" in the owner's example
//   |- a
//   |  |- a1        <- the viewer in most tests
//   |  |  `- a1x
//   |  `- a2        <- a1's sibling
//   `- b
//      `- b1
//   other            <- unrelated tree
//
// Defined once and imported by every ownership spec, so the relation tests and
// the filter tests cannot describe two different worlds. Named `-fixture.mjs`
// rather than `-spec.mjs` because the suite discovers tests by the glob
// `spec/**/*-spec.mjs`, and this file holds no tests.

//   root                      <- the "project" in the owner's example
//   ├── a
//   │   ├── a1                <- the viewer in most tests
//   │   │   └── a1x
//   │   └── a2                <- a1's sibling
//   └── b
//       └── b1
//   other                     <- unrelated tree
export function tree() {
  return [
    { id: 'root', parentSessionID: null },
    { id: 'a', parentSessionID: 'root' },
    { id: 'a1', parentSessionID: 'a' },
    { id: 'a1x', parentSessionID: 'a1' },
    { id: 'a2', parentSessionID: 'a' },
    { id: 'b', parentSessionID: 'root' },
    { id: 'b1', parentSessionID: 'b' },
    { id: 'other', parentSessionID: null },
  ];
}

export const ids = (value) => value.slice().sort();
