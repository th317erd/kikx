'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMentionReferences } from '../../../src/core/mentions/index.mjs';

test('parseMentionReferences extracts unquoted and quoted actor references', () => {
  assert.deepEqual(
    parseMentionReferences('ask @agent-1 and @"Jane Doe" plus @\'Test Agent\' and @UserName'),
    [
      { raw: '@agent-1', reference: 'agent-1', quoted: false },
      { raw: '@"Jane Doe"', reference: 'Jane Doe', quoted: true },
      { raw: '@\'Test Agent\'', reference: 'Test Agent', quoted: true },
      { raw: '@UserName', reference: 'UserName', quoted: false },
    ],
  );
});

test('parseMentionReferences ignores email addresses, dangling ats, and malformed quoted mentions', () => {
  assert.deepEqual(
    parseMentionReferences('mail wyatt@example.com and @ and @"unterminated and @good_one.'),
    [
      { raw: '@good_one', reference: 'good_one', quoted: false },
    ],
  );
});

test('parseMentionReferences de-duplicates references while preserving first mention order', () => {
  assert.deepEqual(
    parseMentionReferences('@agent-1 @agent-1 @"agent-1" @agent-2'),
    [
      { raw: '@agent-1', reference: 'agent-1', quoted: false },
      { raw: '@agent-2', reference: 'agent-2', quoted: false },
    ],
  );
});
