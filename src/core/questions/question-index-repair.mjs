'use strict';

import {
  normalizeQuestionDoc,
  summarizeQuestion,
} from './question-doc.mjs';

/**
 * Repair for the derived ask-user indexes.
 *
 * The open index and the per-agent mirrors are caches over the per-question
 * docs (plan §3.2, D-6), but until this module existed nothing in production
 * rebuilt them: `listOpen()` reads the index only, so a lost entry stayed
 * invisible forever. `QuestionsStore.reindex()` could already rebuild, but it
 * had no non-spec caller.
 *
 * This is that caller. It lives outside the store deliberately — the store is
 * already at its size budget — and the scan is capability-adaptive because the
 * database surfaces differ: drivers expose `list`, while the thin client and
 * the test stubs expose only `listDirectory`.
 *
 * Two safety properties matter more than the repair itself:
 *
 * 1. A scan that cannot see any docs must never wipe a non-empty index. A stub
 *    or a misconfigured driver that silently returns `[]` would otherwise
 *    destroy exactly the data this path exists to recover.
 * 2. A healthy index must not be rewritten on every boot. AeorDB has no
 *    conditional write, and each rewrite churns `updatedAt` and the mirrors,
 *    so the rebuild is computed first and compared against current state.
 */

// Scan-time screening only: a doc must look like a question before its id is
// handed to `writeIndexes`, which runs the store's canonical normalizer and
// decides status/shape for the index itself.
const SCANNABLE_STATUSES = [ 'open', 'answered', 'dismissed', 'undeliverable' ];

/**
 * Enumerate doc items under `path` on whichever surface the db offers.
 */
export async function listDocPaths(db, path, options = {}) {
  let glob = options.glob;
  let recursive = options.recursive === true;

  if (typeof db?.list === 'function')
    return normalizeItems(await db.list(path, { glob, recursive }));

  if (typeof db?.listDirectory === 'function') {
    // On the file surface `depth: -1` is the recursive spelling. A literal
    // `recursive` flag would be ignored there: the driver adapter derives
    // recursion from `depth` alone.
    return normalizeItems(await db.listDirectory(path, { glob, depth: recursive ? -1 : 0 }));
  }

  throw new Error('question index repair requires db.list or db.listDirectory');
}

/**
 * Rebuild the open index and the per-agent mirrors from the per-question docs.
 *
 * Returns `{ scanned, skipped, repaired, openIDs }`, plus `skippedReason` when
 * the rebuild was refused and `unchanged: true` when it was unnecessary.
 * `repaired` counts index ids whose presence changed — 0 means the indexes
 * were already correct.
 */
export async function repairQuestionIndex(store, options = {}) {
  let logger = options.logger || null;
  let rootPath = store.rootPath;

  let existing = await store.readOpenIndex();
  let existingIDs = (Array.isArray(existing?.summaries) ? existing.summaries : [])
    .map((summary) => summary?.id)
    .filter(Boolean);

  let items = await listDocPaths(store.aeordb, `${rootPath}/questions`, { glob: '*.json' });

  // Property 1: a blind scan must not read as "every question is gone".
  if (items.length === 0 && existingIDs.length > 0) {
    return {
      scanned: 0,
      skipped: 0,
      repaired: 0,
      openIDs: [],
      skippedReason: 'scan-returned-nothing',
    };
  }

  let scanned = [];
  let skipped = 0;

  for (let item of items) {
    let doc = null;
    try {
      doc = await store.aeordb.getFile(item.path);
    } catch (error) {
      if (error.status !== 404)
        throw error;

      skipped++;
      continue;
    }

    if (!isScannableQuestion(doc)) {
      skipped++;
      continue;
    }

    scanned.push(doc);
  }

  let expectedOpenIDs = scanned
    .filter((doc) => doc.status === 'open')
    .map((doc) => doc.id)
    .sort();

  // A summary is a *projection*, so it can go stale without any id changing:
  // when `summarizeQuestion` gains a field, every index entry written by the
  // older code keeps the old shape forever, because an id-only comparison sees
  // nothing wrong. That is exactly how a newly exposed field would land for new
  // questions while every existing row stayed silently incomplete — so the
  // rebuild decision compares projections, not just ids.
  // `normalizeQuestionDoc` rejects a doc whose shape it cannot trust, so a
  // screened-but-unusable doc drops out here rather than reaching the projection.
  let expectedSummaries = scanned
    .filter((doc) => doc.status === 'open')
    .map((doc) => normalizeQuestionDoc(doc))
    .filter(Boolean)
    .map((doc) => summarizeQuestion(doc));

  let expectedByAgent = new Map();
  for (let doc of scanned) {
    if (doc.status !== 'open' || !doc.agentID)
      continue;

    if (!expectedByAgent.has(doc.agentID))
      expectedByAgent.set(doc.agentID, []);

    expectedByAgent.get(doc.agentID).push(doc.id);
  }

  for (let ids of expectedByAgent.values())
    ids.sort();

  let existingMirrorAgentIDs = await scanAgentIndexAgentIDs(store, rootPath);

  // Property 2: write only when the rebuild would change something.
  if (await indexesAlreadyCorrect(store, {
    existingIDs,
    expectedOpenIDs,
    existingSummaries: Array.isArray(existing?.summaries) ? existing.summaries : [],
    expectedSummaries,
    expectedByAgent,
    existingMirrorAgentIDs,
  })) {
    return {
      scanned: scanned.length,
      skipped,
      repaired: 0,
      openIDs: expectedOpenIDs,
      unchanged: true,
    };
  }

  // `writeIndexes` derives mirror owners from the docs and also rewrites every
  // agent id passed as `touchedAgentIDs`, which is how a stale mirror gets
  // emptied instead of lingering.
  await store.writeIndexes(
    scanned.map((doc) => doc.id),
    [ ...existingMirrorAgentIDs ],
  );

  let repaired = countDifference(existingIDs, expectedOpenIDs);

  if (repaired > 0)
    logger?.warn?.('Kikx repaired the ask-user question index', {
      repaired,
      scanned: scanned.length,
      skipped,
    });

  return {
    scanned: scanned.length,
    skipped,
    repaired,
    openIDs: expectedOpenIDs,
  };
}

async function indexesAlreadyCorrect(store, {
  existingIDs,
  expectedOpenIDs,
  existingSummaries,
  expectedSummaries,
  expectedByAgent,
  existingMirrorAgentIDs,
}) {
  if (!sameIDs(existingIDs, expectedOpenIDs))
    return false;

  if (!sameSummaries(existingSummaries, expectedSummaries))
    return false;

  let agentIDs = new Set([
    ...existingMirrorAgentIDs,
    ...expectedByAgent.keys(),
  ]);

  for (let agentID of agentIDs) {
    let mirror = await store.listForAgent(agentID);
    if (!sameIDs(mirror.ids || [], expectedByAgent.get(agentID) || []))
      return false;
  }

  return true;
}

/**
 * Compare index summaries against freshly projected ones.
 *
 * Subset comparison, keyed by summary id: every field the current projection
 * produces must already be present with that exact value. Extra keys already in
 * the index are ignored on purpose — they only mean the row was written by a
 * different build, and treating them as wrong would make the repair rewrite the
 * index on every single boot. Missing or differing values are what must rebuild.
 */
function sameSummaries(existing, expected) {
  let byID = new Map();
  for (let summary of existing) {
    if (summary?.id)
      byID.set(summary.id, summary);
  }

  for (let wanted of expected) {
    let have = byID.get(wanted.id);
    if (!have)
      return false;

    for (let [ key, value ] of Object.entries(wanted)) {
      if (!sameValue(have[key], value))
        return false;
    }
  }

  return true;
}

/**
 * Structural equality for JSON values, insensitive to object key order.
 *
 * Comparing serialized forms would be cheaper, but key order is not part of a
 * JSON object's identity: a storage layer is free to normalize it on write
 * (Postgres jsonb sorts keys recursively) and the same value would then compare
 * unequal, making the repair rewrite the index on every boot. Today the
 * documents table is `body text`, so order survives the round trip — this keeps
 * the comparison correct if that ever becomes jsonb, which the codebase already
 * casts elsewhere.
 */
function sameValue(left, right) {
  if (left === right)
    return true;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right))
      return false;
    if (left.length !== right.length)
      return false;
    return left.every((item, index) => sameValue(item, right[index]));
  }

  if (left && right && typeof left === 'object' && typeof right === 'object') {
    let leftKeys = Object.keys(left);
    let rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length)
      return false;
    return leftKeys.every((key) => (
      Object.hasOwn(right, key) && sameValue(left[key], right[key])
    ));
  }

  // NaN and ±0 do not occur in question docs, but keep the fallback honest.
  return Number.isNaN(left) && Number.isNaN(right);
}

function sameIDs(left, right) {
  let a = [ ...left ].sort();
  let b = [ ...right ].sort();

  if (a.length !== b.length)
    return false;

  return a.every((id, index) => id === b[index]);
}

function isScannableQuestion(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc))
    return false;

  if (typeof doc.id !== 'string' || doc.id.trim() === '')
    return false;

  if (typeof doc.text !== 'string' || doc.text.trim() === '')
    return false;

  return SCANNABLE_STATUSES.includes(doc.status);
}

async function scanAgentIndexAgentIDs(store, rootPath) {
  let items;

  try {
    items = await listDocPaths(store.aeordb, `${rootPath}/agents`, {
      recursive: true,
      glob: 'questions.json',
    });
  } catch (_error) {
    return [];
  }

  let agentIDs = [];
  for (let item of items) {
    let match = /\/([^/]+)\/questions\.json$/.exec(item.path);
    if (match)
      agentIDs.push(decodeURIComponent(match[1]));
  }

  return agentIDs;
}

function countDifference(before, after) {
  let beforeSet = new Set(before);
  let afterSet = new Set(after);
  let changed = 0;

  for (let id of beforeSet) {
    if (!afterSet.has(id))
      changed++;
  }

  for (let id of afterSet) {
    if (!beforeSet.has(id))
      changed++;
  }

  return changed;
}

function normalizeItems(result) {
  let items = Array.isArray(result?.items) ? result.items : [];
  return items.filter((item) => typeof item?.path === 'string');
}
