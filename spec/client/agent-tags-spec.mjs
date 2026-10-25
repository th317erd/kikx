'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAgentTags,
  defaultTagValues,
  tagValuesFromAgent,
} from '../../src/client/state/agent-state-utils.mjs';

const DEFINITIONS = [
  { name: 'leadership_score', targetTypes: [ 'agent' ], type: 'integer', defaultValue: 0 },
  { name: 'ocr_score', targetTypes: [ 'agent' ], type: 'integer', defaultValue: 0 },
  { name: 'session_only', targetTypes: [ 'session' ], type: 'text', defaultValue: 'x' },
];

test('agent tag form defaults only include definitions that target agents', () => {
  assert.deepEqual(defaultTagValues(DEFINITIONS), {
    leadership_score: 0,
    ocr_score: 0,
  });
});

test('agent tag form reads saved agent tags and builds the save payload', () => {
  assert.deepEqual(tagValuesFromAgent({
    tags: [
      { target_type: 'agent', target_id: 'agent_1', name: 'ocr_score', value: 7 },
      { target_type: 'session', target_id: 'ses_1', name: 'ocr_score', value: 2 },
    ],
  }, DEFINITIONS), {
    leadership_score: 0,
    ocr_score: 7,
  });

  assert.deepEqual(buildAgentTags(DEFINITIONS, {
    leadership_score: 10,
    ocr_score: '',
  }), [
    { target_type: 'agent', name: 'leadership_score', value: 10 },
    { target_type: 'agent', name: 'ocr_score', value: null },
  ]);
});
