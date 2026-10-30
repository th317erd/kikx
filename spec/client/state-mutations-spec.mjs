'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { createMutationLedger } from '../../src/client/state/state-mutations.mjs';

test('a mutation ledger records exact breadth, value, revision and order', () => {
  let ledger = createMutationLedger({ scope: 'composer', owner: 'ses_1' });
  ledger.record({ key: 'text', previous: '', next: 'a', operation: 'setText', cause: 'input' });
  ledger.record({ key: 'text', previous: 'a', next: 'ab', operation: 'setText', cause: 'input' });

  assert.deepEqual(ledger.entries().map((entry) => ({
    key: entry.key,
    previous: entry.previous,
    next: entry.next,
    revision: entry.revision,
    scope: entry.scope,
    owner: entry.owner,
  })), [
    { key: 'text', previous: '', next: 'a', revision: 1, scope: 'composer', owner: 'ses_1' },
    { key: 'text', previous: 'a', next: 'ab', revision: 2, scope: 'composer', owner: 'ses_1' },
  ]);
});

test('the ledger is bounded without changing monotonic revision order', () => {
  let ledger = createMutationLedger({ scope: 'composer', owner: 'ses_1', max: 2 });
  ledger.record({ key: 'text', next: '1' });
  ledger.record({ key: 'text', next: '2' });
  ledger.record({ key: 'text', next: '3' });

  assert.deepEqual(ledger.entries().map((entry) => entry.next), [ '2', '3' ]);
  assert.deepEqual(ledger.entries().map((entry) => entry.revision), [ 2, 3 ]);
});
