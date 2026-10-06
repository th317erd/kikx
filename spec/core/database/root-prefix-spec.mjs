'use strict';

// Regression coverage for enumerating the root prefix. `/` is the only prefix
// whose lower bound is not `base + '/'` and whose `base.length + 1` relative
// slice would drop a real character, so every shared/SQL path-narrowing helper
// needs an explicit root case.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pathBounds,
  relativePath,
  selectDocumentPaths,
} from '../../../src/core/database/document-utils.mjs';

test('pathBounds() special-cases the root prefix', () => {
  assert.deepEqual(pathBounds('/'), [ '/', '0' ]);
  assert.deepEqual(pathBounds('/kikx'), [ '/kikx/', '/kikx0' ]);
});

test('relativePath() strips the root prefix without dropping a character', () => {
  assert.equal(relativePath('/', '/kikx/a.json'), 'kikx/a.json');
  assert.equal(relativePath('/kikx', '/kikx/a.json'), 'a.json');
});

test('selectDocumentPaths() enumerates descendants of the root prefix', () => {
  let keys = [ '/kikx/a.json', '/kikx/sub/b.json', '/kikx/sub/deep/c.json', '/top.json' ];

  assert.deepEqual(
    selectDocumentPaths(keys, '/', { recursive: true, glob: '**/*.json' }),
    [ '/kikx/a.json', '/kikx/sub/b.json', '/kikx/sub/deep/c.json', '/top.json' ],
  );

  assert.deepEqual(
    selectDocumentPaths(keys, '/', { recursive: false, glob: '**' }),
    [ '/top.json' ],
  );

  assert.deepEqual(
    selectDocumentPaths(keys, '/kikx', { recursive: true, glob: '**/*.json' }),
    [ '/kikx/a.json', '/kikx/sub/b.json', '/kikx/sub/deep/c.json' ],
  );
});
