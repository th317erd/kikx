'use strict';

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  LocalCommandExecutionService,
  LocalFileAccessService,
} from '../../../src/core/tools/index.mjs';

// Kikx is a global service: a direct construction with no cwd must land in the
// user's home, never in whatever directory the process happened to start from.
test('LocalFileAccessService defaults its cwd to the user home', () => {
  let service = new LocalFileAccessService();

  assert.equal(service.cwd, os.homedir());
});

test('LocalCommandExecutionService defaults its cwd to the user home', () => {
  let service = new LocalCommandExecutionService();

  assert.equal(service.cwd, os.homedir());
});

test('an explicit cwd still wins over the user-home default', () => {
  let cwd = path.resolve('/tmp/kikx-explicit-local-cwd');

  assert.equal(new LocalFileAccessService({ cwd }).cwd, cwd);
  assert.equal(new LocalCommandExecutionService({ cwd }).cwd, cwd);
});
