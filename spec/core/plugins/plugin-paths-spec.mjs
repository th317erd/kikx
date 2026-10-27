'use strict';

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { mergePluginPaths } from '../../../src/core/plugins/plugin-paths.mjs';

test('configured plugin sites extend the bundled plugin root instead of replacing it', () => {
  let bundled = '/repo/plugins';
  let configured = [ '/opt/kikx/plugins', '/repo/plugins' ].join(path.delimiter);
  assert.deepEqual(mergePluginPaths(bundled, configured), [ '/repo/plugins', '/opt/kikx/plugins' ]);
});

test('plugin paths may be supplied as strings or arrays and are de-duplicated', () => {
  assert.deepEqual(mergePluginPaths('/a', '/b:/c', [ '/c', '/d' ]), [ '/a', '/b', '/c', '/d' ]);
});
