// Seam contract tests: does the fork planner actually reach the create path?
//
// Two kinds of assertion live here, and the difference matters:
//
//   1. STATIC assertions over real source text. The wiring does not exist yet,
//      so there is no live behaviour to assert. Each names the exact failure
//      mode that makes a well-tested pure function inert.
//   2. BEHAVIOURAL assertions against a real FrameRuntime and an in-memory
//      AeorDB fake. These prove the write path the seam will use already works
//      — durable, order-preserving, manifest-updating — so the seam is a
//      request for wiring, not for new machinery.
//
// The static wiring assertions are RED today on purpose. Applying §2 of
// spec/core/context/fork-seam.md turns them green. A green run before the
// wiring lands would mean they had gone vacuous.
//
// Evidence behind each behavioural claim is in spec/core/context/fork-seam.md.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { FrameRuntime } from '../../../src/core/runtime/frame-runtime.mjs';
import { planSessionFork } from '../../../src/core/context/session-fork.mjs';
import { frameToModelTurn } from '../../../src/core/plugins/agent-model-context.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const SESSION_TOOLS = join(repoRoot, 'src', 'core', 'tools', 'session-tools.mjs');
const SESSION_FORK = join(repoRoot, 'src', 'core', 'context', 'session-fork.mjs');
const FRAME_ENGINE = join(repoRoot, 'src', 'core', 'frames', 'frame-engine.mjs');
const SESSION_HELPERS = join(repoRoot, 'src', 'core', 'tools', 'session-tool-helpers.mjs');
const FRAME_STORE_COMMIT = join(repoRoot, 'src', 'core', 'aeordb', 'frame-store-commit.mjs');
const FRAME_STORE_PATHS = join(repoRoot, 'src', 'core', 'aeordb', 'frame-store-paths.mjs');

const read = (path) => readFile(path, 'utf8');

// ok(regex.test(...)) rather than match(): match() prints the whole source file
// on failure, which buries the reason the gate went red.
function expectMatch(source, pattern, message) {
  assert.ok(pattern.test(source), message);
}

/** 1-based line number of the first line matching `pattern`, or -1. */
function lineOf(source, pattern) {
  let lines = source.split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (pattern.test(lines[index]))
      return index + 1;
  }
  return -1;
}

// In-memory AeorDB fake, mirroring spec/core/frame-runtime-spec.mjs. The store
// is ONE keyspace, not a tree of directories — that is the point of the
// storage-model correction, so the fake models keys and nothing else.
function createClient() {
  return {
    files: new Map(),
    async putFile(path, body) {
      this.files.set(path, body);
      return { path };
    },
    async getFile(path) {
      return this.files.get(path) || null;
    },
    async listDirectory(path, requestOptions) {
      let prefix = `${path.replace(/\/+$/, '')}/`;
      let items = [];
      for (let filePath of this.files.keys()) {
        if (!filePath.startsWith(prefix))
          continue;

        if ((requestOptions?.glob === '*/session.json' || requestOptions?.glob === '**/session.json')
          && !/^\/kikx\/sessions\/[^/]+\/session\.json$/.test(filePath))
          continue;

        if (requestOptions?.glob === '**/frames/*.json' && !filePath.includes('/frames/'))
          continue;

        items.push({ path: filePath });
      }
      return { items };
    },
  };
}

let idPool = () => Array.from({ length: 400 }, (_, i) => `id_${Math.random().toString(36).slice(2)}_${i}`);

function createRuntime(aeordb) {
  let ids = idPool();
  let index = 0;
  return new FrameRuntime({
    aeordb,
    clock: () => 1000,
    runnerID: 'runtime',
    idGenerator: () => ids[index++],
  });
}

async function authorFrames(entry, sessionID, count) {
  let frames = [];
  for (let i = 0; i < count; i++) {
    frames.push({
      id: `pf_${i}`,
      type: 'UserMessage',
      sessionID,
      authorType: 'user',
      authorID: 'u1',
      content: { text: `hello ${i}` },
      hidden: false,
      deleted: false,
    });
  }
  entry.frameEngine.merge(frames, {});
}

/** Create a parent of `count` frames, flush it, and return both. */
async function seedParent(aeordb, rt, count) {
  let parent = await rt.createSession({ title: 'parent' });
  let entry = await rt.ensureSessionEntry(parent.id);
  await authorFrames(entry, parent.id, count);
  await rt.frameStore.flush();
  return { parent, entry };
}

/** Fork `parent` into a new child through the recommended seam. */
async function forkChild(rt, parent, pEntry, freshContext = false) {
  let child = await rt.createSession({ title: 'child', parentSessionID: parent.id });
  let cEntry = await rt.ensureSessionEntry(child.id);
  let plan = planSessionFork({
    parentFrames: pEntry.frameEngine.toArray(),
    childSessionID: child.id,
    parentSessionID: parent.id,
    freshContext,
  });
  if (plan.seedFrames.length > 0) {
    cEntry.frameEngine.merge(plan.seedFrames, { authorType: 'agent', authorID: 'a1', silent: true });
    await rt.frameStore.flush();
  }
  return { child, cEntry, plan };
}

const project = (frames) => frames
  .map((frame) => frameToModelTurn(frame))
  .filter(Boolean)
  .map((turn) => ({ role: turn.role, content: turn.content }));

// ---------------------------------------------------------------------------
// 1. Static: the tool boundary must declare the flag.
// ---------------------------------------------------------------------------
describe('fork seam: schema', () => {
  it('session-create declares freshContext in its parameter set', async () => {
    let source = await read(SESSION_TOOLS);

    // The schema is serialised to the model, so anything undeclared is
    // invisible: the model can never emit the flag and the feature is
    // unreachable from a conversation. (It is NOT stripped at runtime — there
    // is no argument validation in src/core — but invisible is fatal all the same.)
    assert.notEqual(
      lineOf(source, /^\s*freshContext\s*:/),
      -1,
      'session-create must declare a `freshContext` parameter, or the model can never send the flag',
    );
  });

  it('the freshContext declaration is a boolean with a description', async () => {
    let lines = (await read(SESSION_TOOLS)).split('\n');
    let start = lines.findIndex((line) => /^\s*freshContext\s*:/.test(line));
    assert.notEqual(start, -1, 'freshContext parameter missing');

    let block = lines.slice(start, start + 6).join('\n');
    assert.ok(/type:\s*'boolean'/.test(block), 'freshContext must be typed boolean');
    assert.ok(/description:/.test(block), 'freshContext must carry a description so the model knows when to use it');
  });

  it('the tool help text documents the fresh/fork choice', async () => {
    let source = await read(SESSION_TOOLS);
    let help = lineOf(source, /static help = 'Use session-create/);
    assert.notEqual(help, -1, 'session-create help text not found');

    assert.ok(
      /fresh/i.test(source.split('\n')[help - 1]),
      'session-create help must mention the fresh/fork choice, or the model assumes every child is fresh',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Static: the planner must actually be reachable from the create path.
// ---------------------------------------------------------------------------
describe('fork seam: planner reachability', () => {
  it('the planner module exists and exports planSessionFork', async () => {
    expectMatch(await read(SESSION_FORK), /export function planSessionFork\s*\(/, 'planSessionFork must be exported');
  });

  it('session-tools imports the planner', async () => {
    expectMatch(
      await read(SESSION_TOOLS),
      /from\s+['"][^'"]*context\/session-fork\.mjs['"]/,
      'src/core/tools/session-tools.mjs does not import session-fork.mjs: the planner is connected to nothing',
    );
  });

  it('session-tools calls planSessionFork', async () => {
    expectMatch(
      await read(SESSION_TOOLS),
      /planSessionFork\s*\(/,
      'session-tools imports but never calls the planner, so creation still yields a fresh session',
    );
  });

  it('session-tools does not grow a second, divergent compaction finder', async () => {
    // The latest-compaction rule lives in one place (agent-brief-state.mjs,
    // reused by session-fork.mjs). A second local copy is the split-brain
    // defect class this codebase has been bitten by.
    assert.equal(
      /function\s+\w*[Ff]indLatestCompaction|function\s+\w+isCompactionFrame/.test(await read(SESSION_TOOLS)),
      false,
      'session-tools must reuse session-fork.mjs, not re-derive compaction',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Static: ordering and the write path.
// ---------------------------------------------------------------------------
describe('fork seam: ordering', () => {
  it('seeding is sited before initialMessage is read', async () => {
    let source = await read(SESSION_TOOLS);

    let seedLine = lineOf(source, /planSessionFork\s*\(/);
    let initialLine = lineOf(source, /normalizeOptionalString\(params\.initialMessage\)/);

    assert.notEqual(seedLine, -1, 'planSessionFork call site not found');
    assert.notEqual(initialLine, -1, 'initialMessage read not found');

    // postAgentSessionMessage takes its own stamp and merges one frame. If it
    // ran first it would claim the lowest order, putting the parent's context
    // BEHIND the child's opening turn.
    assert.ok(
      seedLine < initialLine,
      `fork seeding must run before initialMessage is read (seed at ${seedLine}, initialMessage at ${initialLine})`,
    );
  });

  it('the seed write goes through the engine merge path', async () => {
    expectMatch(
      await read(SESSION_TOOLS),
      /frameEngine\.merge\s*\(/,
      'seeding must merge into the child engine, which is what makes frames durable and updates messageCount',
    );
  });

  it('the seed write flushes before returning', async () => {
    expectMatch(
      await read(SESSION_TOOLS),
      /frameStore\?\.flush\?\.\s*\(/,
      'seed frames must be flushed to durable storage',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Behavioural: the write path the seam depends on, exercised for real.
// ---------------------------------------------------------------------------
describe('fork seam: the write path is real (behavioural)', () => {
  it('merging seed frames persists them under the CHILD session key', async () => {
    let aeordb = createClient();
    let rt = createRuntime(aeordb);
    let { parent, entry: pEntry } = await seedParent(aeordb, rt, 3);

    let { child, plan } = await forkChild(rt, parent, pEntry);

    // The store is one keyspace. "Copied into the child" means frames exist
    // under a key whose session segment names the child — no directory, no cp.
    let childKeys = [...aeordb.files.keys()]
      .filter((k) => k.includes(`/sessions/${encodeURIComponent(child.id)}/`) && k.includes('/frames/'));
    assert.equal(childKeys.length, plan.inheritedCount,
      'every seed frame must be durable under the child session key');

    let parentKeys = [...aeordb.files.keys()]
      .filter((k) => k.includes(`/sessions/${encodeURIComponent(parent.id)}/`) && k.includes('/frames/'));
    for (let key of childKeys)
      assert.equal(parentKeys.includes(key), false, 'a child frame must not be stored under the parent key');
  });

  it('a forked child reports a non-zero messageCount, not a phantom empty session', async () => {
    // The sidebar-consistency risk named in fork-seam.md §2.2. It is handled for
    // free by the commit listener — but ONLY because the seed goes through
    // merge(), which emits `commit`. A direct putFile would bypass it and leave
    // a session whose model sees N frames while the sidebar sees 0.
    let aeordb = createClient();
    let rt = createRuntime(aeordb);
    let { parent, entry: pEntry } = await seedParent(aeordb, rt, 4);
    rt.syncSessionManifestFromEngine(pEntry, { persist: true });
    await rt.frameStore.flush();
    assert.equal(pEntry.session.messageCount, 4, 'parent baseline');

    let { cEntry, plan } = await forkChild(rt, parent, pEntry);

    assert.equal(cEntry.session.messageCount, plan.inheritedCount,
      'the child manifest must reflect inherited frames, or it renders as an empty session');
  });

  it('the child survives a rehydrate with its frames and its watermark intact', async () => {
    let aeordb = createClient();
    let rt = createRuntime(aeordb);
    let { parent, entry: pEntry } = await seedParent(aeordb, rt, 5);
    let parentMaxOrder = Math.max(...pEntry.frameEngine.toArray().map((f) => f.order));

    let { child, plan } = await forkChild(rt, parent, pEntry);

    // A brand-new runtime over the same store: proves durability rather than
    // in-memory coincidence.
    let rt2 = createRuntime(aeordb);
    let rehydrated = await rt2.ensureSessionEntry(child.id);
    assert.equal(rehydrated.frameEngine.toArray().length, plan.inheritedCount,
      'a forked child must survive a restart with its inherited context');

    // The watermark must fold, so the child's next OWN frame lands after the
    // seed rather than colliding with it.
    let own = rehydrated.frameEngine.merge([{
      id: 'own_1',
      type: 'UserMessage',
      sessionID: child.id,
      authorType: 'user',
      content: { text: 'own' },
    }], {});
    assert.ok(own[0].order > parentMaxOrder,
      `child's own frame (order ${own[0].order}) must land after inherited max order ${parentMaxOrder}`);
  });

  it('freshContext:true produces an empty, fully fresh child', async () => {
    // The inverse guard: without it, a planner that returned [] always would
    // satisfy every fork assertion above.
    let aeordb = createClient();
    let rt = createRuntime(aeordb);
    let { parent, entry: pEntry } = await seedParent(aeordb, rt, 4);

    let { cEntry, plan } = await forkChild(rt, parent, pEntry, true);

    assert.equal(plan.inheritedCount, 0, 'freshContext:true must inherit nothing');
    assert.equal(plan.mode, 'fresh');
    assert.deepEqual(plan.seedFrames, [], 'freshContext:true must yield no seed frames');
    assert.equal(cEntry.frameEngine.toArray().length, 0, 'the child engine must stay empty');
  });

  it('the fork reproduces the parent projection exactly — the cache claim', async () => {
    // This is the test that justifies the feature. If the forked child's
    // projected turns are not byte-identical to the parent's, the provider
    // cache misses and there is no reason to fork rather than summarise.
    let aeordb = createClient();
    let rt = createRuntime(aeordb);
    let { parent, entry: pEntry } = await seedParent(aeordb, rt, 6);

    let { child } = await forkChild(rt, parent, pEntry);

    // Compare through the STORE on both sides, so this cannot accidentally
    // compare an in-memory object graph with itself.
    let rt2 = createRuntime(aeordb);
    let pFrames = (await rt2.ensureSessionEntry(parent.id)).frameEngine.toArray();
    let cFrames = (await rt2.ensureSessionEntry(child.id)).frameEngine.toArray();

    let parentTurns = project(pFrames);
    let childTurns = project(cFrames);

    assert.ok(parentTurns.length > 0, 'parent projection must not be empty, or the comparison is vacuous');
    assert.deepEqual(childTurns, parentTurns,
      "the forked child must project to the parent's turns exactly, or the provider cache misses");

    // The actual cache condition is byte equality of the serialised prefix,
    // not merely deep-equality of the parsed form.
    assert.equal(JSON.stringify(childTurns), JSON.stringify(parentTurns),
      'projected turns must be byte-identical for a provider cache hit');

    // Confirm storage identity really did change, so the equality above is a
    // statement about projection rather than about shared identity.
    assert.notEqual(cFrames[0].id, pFrames[0].id, 'child frames must carry fresh ids');
    assert.notEqual(cFrames[0].sessionID, pFrames[0].sessionID, 'child frames must carry the child sessionID');
  });

  it('a silently seeded child does not enqueue routed work', async () => {
    // Context, not conversation: inherited frames must not make the child take
    // a turn. silent:true reaches FrameRouter.enqueueCommit's early return.
    let aeordb = createClient();
    let rt = createRuntime(aeordb);
    let { parent, entry: pEntry } = await seedParent(aeordb, rt, 2);

    let child = await rt.createSession({ title: 'child', parentSessionID: parent.id });
    let cEntry = await rt.ensureSessionEntry(child.id);
    let plan = planSessionFork({
      parentFrames: pEntry.frameEngine.toArray(),
      childSessionID: child.id,
      parentSessionID: parent.id,
      freshContext: false,
    });

    let commits = [];
    cEntry.frameEngine.on('commit', ({ commit }) => commits.push(commit));
    cEntry.frameEngine.merge(plan.seedFrames, { authorType: 'agent', authorID: 'a1', silent: true });
    await rt.frameStore.flush();

    assert.equal(commits.length, 1, 'the seed must produce exactly one commit');
    assert.equal(commits[0].silent, true, 'the seed commit must be marked silent so no turn is routed from inherited context');
  });
});

// ---------------------------------------------------------------------------
// 5. Static evidence that the machinery above is not an invention. If these go
//    red, fork-seam.md §1.1 is wrong and the recommendation must be revisited.
// ---------------------------------------------------------------------------
describe('fork seam: the machinery it relies on', () => {
  it('FrameEngine.merge accepts fully-formed frames with a supplied id and type', async () => {
    expectMatch(
      await read(FRAME_ENGINE),
      /if \(!input \|\| !input\.id \|\| !input\.type\)/,
      'merge must key on caller-supplied id/type',
    );
  });

  it('FrameEngine.merge preserves a supplied order instead of renumbering', async () => {
    expectMatch(
      await read(FRAME_ENGINE),
      /let order = numberOr\(input\.order,/,
      'merge must honour input.order; renumbering would reorder a forked child history',
    );
  });

  it('merging advances the order watermark and hydrate folds it back', async () => {
    let source = await read(FRAME_ENGINE);
    expectMatch(source, /\+\+this\._frameOrder/, 'merge must increment the frame-order watermark');
    expectMatch(source, /this\._frameOrder = Math\.max\(this\._frameOrder, storedOrder\)/, 'hydrate must fold the watermark');
  });

  it('merge supports silent, which suppresses routing for context-only seeds', async () => {
    expectMatch(
      await read(FRAME_ENGINE),
      /silent: options\.silent === true/,
      'merge must be able to mark a commit silent so inherited context does not trigger a routed turn',
    );
  });

  it('the merge-persist idiom already exists in production', async () => {
    let source = await read(SESSION_HELPERS);
    expectMatch(source, /entry\.frameEngine\.merge\s*\(/, 'the append idiom must have a live precedent');
    expectMatch(source, /frameStore\?\.flush\?\./, 'the precedent must flush');
    expectMatch(source, /syncSessionManifestFromEngine/, 'the precedent must sync the manifest');
  });

  it('frames are stored under a per-session KEY in one store, not a directory tree', async () => {
    // The storage-model correction, pinned so nobody reintroduces the
    // "physically partitioned directory" reading.
    expectMatch(
      await read(FRAME_STORE_PATHS),
      /sessions\/\$\{encodeSegment\(sessionID\)\}\/interactions\//,
      'framePath must build a per-session store key',
    );
    expectMatch(
      await read(FRAME_STORE_COMMIT),
      // Prefix match: the real call is
      //   await this.aeordb.putFile(this.framePath(sessionID, frame), serializeFrame(...));
      // so anchoring on a closing paren would be wrong.
      /this\.aeordb\.putFile\(this\.framePath\(sessionID, frame\)/,
      'saveFrame must be a putFile under that key, not a filesystem copy',
    );
  });
});
