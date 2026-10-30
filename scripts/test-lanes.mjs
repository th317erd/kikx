'use strict';

// Lane definitions for the test runner, kept in a side-effect-free module so
// specs can import the table and assert that the gate really covers every lane.
//
// The reason this table exists at all: the lane globs are disjoint
// (`*-spec.mjs` vs `*-playwright.mjs` vs `*-stagehand.mjs` vs `*-puppeteer.mjs`).
// A gate that names only the first glob reports green while every browser spec
// goes unrun. That is not hypothetical — it happened, repeatedly.

export const LANES = [
  {
    name: 'unit',
    globs: [ 'spec/**/*-spec.mjs' ],
    testTimeout: '30000',
    timeoutMs: 300000,
    // No external service required.
    hermetic: true,
  },
  {
    name: 'ui:playwright',
    globs: [ 'spec/ui/playwright/*-playwright.mjs' ],
    testTimeout: '60000',
    timeoutMs: 300000,
    // Hermetic: every spec starts its own fixture server and skips itself when
    // Chrome is absent. Deliberately NOT routed through
    // scripts/with-aeordb-token.mjs — that wrapper exits 2 when AeorDB is not
    // listening, which would turn a lane that cannot fail into a lane that
    // cannot run.
    hermetic: true,
  },
  {
    name: 'ui:stagehand',
    globs: [ 'spec/ui/stagehand/*-stagehand.mjs' ],
    testTimeout: '60000',
    timeoutMs: 900000,
    // Needs a live model credential; not safe to run unattended.
    hermetic: false,
  },
  {
    name: 'ui:puppeteer',
    globs: [ 'spec/ui/puppeteer/*-puppeteer.mjs' ],
    testTimeout: '60000',
    timeoutMs: 600000,
    hermetic: false,
  },
];

// Running these two is what "the suite" means. The others need live services or
// credentials and are opt-in via --all.
export const DEFAULT_LANE_NAMES = [ 'unit', 'ui:playwright' ];

// Suffixes that mark a file as an executable spec. Any spec file carrying one of
// these but matching no lane glob is invisible to every gate; the lane-coverage
// spec fails in that case rather than letting it rot.
export const SPEC_SUFFIXES = [ '-spec.mjs', '-playwright.mjs', '-stagehand.mjs', '-puppeteer.mjs' ];

export function resolveSelection(argv) {
  if (argv.includes('--all'))
    return new Set(LANES.map((lane) => lane.name));

  let named = argv.filter((argument) => !argument.startsWith('-'));
  if (named.length > 0)
    return new Set(named);

  return new Set(DEFAULT_LANE_NAMES);
}

export function unknownLaneNames(selection) {
  return [ ...selection ].filter((name) => !LANES.some((lane) => lane.name === name));
}
