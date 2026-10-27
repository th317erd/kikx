'use strict';

// Is a Kikx child session a FORK of its parent's frames, a FRESH session, or a
// FRESH session primed with a summary/handoff?
//
// ANSWER (proven below): fresh — never a fork. The child's first model turn is
// assembled from the *child's own* frame engine only. The single optional
// priming channel is `session-create`'s `initialMessage`, which writes exactly
// one agent-authored frame into the child; nothing carries parent frames,
// parent summaries, or even the parent's id/title/goal.
//
// Why this spec exists rather than a source-reading note: the "fork" hypothesis
// is the one a reader expects from a session tree with `parentSessionID` and
// `generation` lineage. Those fields look like inheritance. They are not: they
// are used for ownership, scope and dedupe only. This spec pins that down by
// driving a real FrameRuntime and asserting on the real assembled message list.
//
// Anti-vacuity: every "does not contain" assertion is paired with a positive
// control. Test 1 proves the marker IS detectable through this exact harness,
// so a harness that silently produced empty contexts could not pass.

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameRuntime } from '../../../src/core/runtime/frame-runtime.mjs';
import { buildModelMessages } from '../../../src/core/plugins/agent-model-context.mjs';
import { projectFrameMessages } from '../../../src/shared/frame-manager/frame-manager.mjs';
import { postAgentSessionMessage } from '../../../src/core/tools/session-tool-helpers.mjs';
import { sessionGeneration } from '../../../src/core/plugins/agent-normalizers.mjs';

// Distinctive, greppable, and deliberately not a word the brief text could
// contain by coincidence.
const PARENT_MARKER = 'PARENT-ONLY-MARKER-7f3a91c4-DO-NOT-BLEED';
const PARENT_TITLE_MARKER = 'Parent Title Marker 5b2e';
const CHILD_HANDOFF_MARKER = 'CHILD-HANDOFF-8c1d02ab';

// In-memory AeorDB stand-in, following the shape the existing
// spec/core/frame-runtime-spec.mjs uses. Files are plain objects keyed by path.
function createClient() {
  let files = new Map();
  return {
    files,
    calls: [],
    async putFile(path, body) {
      this.calls.push({ method: 'putFile', path });
      files.set(path, body);
      return { path };
    },
    async getFile(path) {
      this.calls.push({ method: 'getFile', path });
      return files.get(path) || null;
    },
    async listDirectory(path, requestOptions) {
      this.calls.push({ method: 'listDirectory', path, options: requestOptions });
      let prefix = `${path.replace(/\/+$/g, '')}/`;
      let items = [];
      for (let filePath of files.keys()) {
        if (!filePath.startsWith(prefix))
          continue;
        let glob = requestOptions?.glob;
        if ((glob === '*/session.json' || glob === '**/session.json')
          && !/^\/kikx\/sessions\/[^/]+\/session\.json$/.test(filePath))
          continue;
        if (glob === '**/frames/*.json' && !filePath.includes('/frames/'))
          continue;
        items.push({ path: filePath });
      }
      return { items };
    },
  };
}

function createRuntime(aeordb, ids) {
  let index = 0;
  return new FrameRuntime({
    aeordb,
    clock: () => 1000,
    runnerID: 'runtime',
    idGenerator: () => ids[index++],
  });
}

// Assemble the message list exactly the way the route plugin does:
//   sessionFrames = projectFrameMessages(engine.toArray())   (route plugin 262-263)
//   buildModelMessages({ frames: sessionFrames, ... })
async function firstTurnMessages(runtime, sessionID, { agent, frame, session }) {
  let entry = await runtime.ensureSessionEntry(sessionID);
  let sessionFrames = projectFrameMessages(entry.frameEngine.toArray());
  return {
    sessionFrames,
    messages: buildModelMessages({
      frames: sessionFrames,
      frame,
      agent,
      session,
      sessionGeneration: sessionGeneration(session),
      prompt: frame?.content?.text || '',
    }),
  };
}

function allText(messages) {
  return messages.map((message) => `${message.role}\u0000${message.content}`).join('\n');
}

test('control: the harness can see a parent frame that really exists', async () => {
  // Without this, the negative assertions below could pass simply because the
  // harness never loaded any frames at all.
  let aeordb = createClient();
  let runtime = createRuntime(aeordb, [ 'ses_parent', 'frm_user', 'int_1', 'commit_1' ]);
  let parent = await runtime.createSession({ title: `${PARENT_TITLE_MARKER}` });

  await runtime.appendUserMessage(parent.id, { text: `${PARENT_MARKER}` });

  let entry = await runtime.ensureSessionEntry(parent.id);
  let projected = projectFrameMessages(entry.frameEngine.toArray());
  assert.equal(projected.length, 1, 'the parent session must hold exactly the one user frame');
  assert.match(JSON.stringify(projected), new RegExp(PARENT_MARKER),
    'the marker must survive projection, otherwise the anti-bleed test is vacuous');
});

test('a child session is fresh: its first turn contains no parent frames at all', async () => {
  let aeordb = createClient();
  let runtime = createRuntime(aeordb, [
    'ses_parent', 'frm_user', 'int_1', 'commit_1',   // parent session + its one message
    'ses_child', 'frm_handoff', 'int_2', 'commit_2', // child session + its handoff
  ]);

  // --- parent: a session with real content and an identifying title ---------
  let parent = await runtime.createSession({ title: `${PARENT_TITLE_MARKER}` });
  await runtime.appendUserMessage(parent.id, { text: `${PARENT_MARKER}` });

  // --- child: created the way session-tools.mjs creates one (lines 250-259) --
  // createSession is given title + lineage only. No frames are passed, and the
  // runtime has no parameter through which frames could be passed.
  let child = await runtime.createSession({
    title: 'Child session',
    participantAgentIDs: [ 'agent_child' ],
    createdByAgentID: 'agent_parent',
    parentSessionID: parent.id,
    generation: sessionGeneration(parent) + 1,
  });

  // --- the ONE priming channel: initialMessage -> exactly one agent frame ----
  let posted = await postAgentSessionMessage({
    runtime,
    context: { agent: { id: 'agent_parent', name: 'Parent' } },
    sessionID: child.id,
    text: `${CHILD_HANDOFF_MARKER} do the delegated thing`,
  });
  assert.equal(posted.posted, true);

  let childSession = runtime.getSession(child.id);
  assert.equal(childSession.parentSessionID, parent.id, 'lineage must be recorded');
  assert.equal(childSession.generation, 1, 'generation must be parent + 1');

  // --- what the child's model actually receives on turn 1 -------------------
  let { sessionFrames, messages } = await firstTurnMessages(runtime, child.id, {
    agent: { id: 'agent_child', name: 'Child' },
    frame: posted.frame,
    session: childSession,
  });

  // The child's history is exactly ONE frame: the handoff. Not the parent's.
  assert.equal(sessionFrames.length, 1, `child history must be exactly its own handoff, got ${sessionFrames.length}`);

  let text = allText(messages);

  // 1. No parent frame content.
  assert.ok(!text.includes(PARENT_MARKER),
    'the parent marker must not appear anywhere in the child model context');
  // 2. No parent frame at all — the marker is the parent's only frame, so its
  //    absence above already proves frame non-inheritance; this asserts the
  //    count directly so a future "summary" feature cannot slip in unnoticed.
  assert.equal(sessionFrames.filter((frame) => frame.type === 'UserMessage').length, 0,
    'no parent user frames may be projected into the child');

  // 3. No parent identity anywhere in the assembled prompt: not the id, not the
  //    title. The child cannot even tell WHICH session it came from.
  assert.ok(!text.includes(parent.id), 'the parent session id must not leak into the child prompt');
  assert.ok(!text.includes(PARENT_TITLE_MARKER), 'the parent session title must not leak into the child prompt');
  assert.ok(!text.includes('gen:'), 'no generation line is emitted');

  // 4. The handoff IS present — so the child is primed, not empty.
  assert.ok(text.includes(CHILD_HANDOFF_MARKER),
    'the initialMessage handoff must reach the child model');
});

test('the child never sees the parent even after the parent has many frames', async () => {
  // Guards against a "fork" that only kicks in once the parent has substantial
  // history (e.g. a compaction summary being copied across).
  let aeordb = createClient();
  let ids = [ 'ses_parent' ];
  for (let i = 0; i < 12; i += 1)
    ids.push(`frm_p${i}`, `int_p${i}`, `commit_p${i}`);
  ids.push('ses_child', 'frm_handoff', 'int_c', 'commit_c');

  let runtime = createRuntime(aeordb, ids);
  let parent = await runtime.createSession({ title: 'Big parent' });

  for (let i = 0; i < 12; i += 1)
    await runtime.appendUserMessage(parent.id, { text: `parent turn ${i} ${PARENT_MARKER}` });

  let child = await runtime.createSession({
    title: 'Child session',
    createdByAgentID: 'agent_parent',
    parentSessionID: parent.id,
    generation: sessionGeneration(parent) + 1,
  });

  let parentEntry = await runtime.ensureSessionEntry(parent.id);
  assert.equal(parentEntry.frameEngine.toArray().length, 12,
    'the parent must really hold 12 frames, or this test proves nothing');

  let { sessionFrames, messages } = await firstTurnMessages(runtime, child.id, {
    agent: { id: 'agent_child', name: 'Child' },
    frame: null,
    session: runtime.getSession(child.id),
  });

  assert.equal(sessionFrames.length, 0, 'a child created without initialMessage has an EMPTY history');
  assert.ok(!allText(messages).includes(PARENT_MARKER),
    '12 parent frames still must not reach the child');
});

// ---------------------------------------------------------------------------
// The bare `session-create` callsite: what the child model sees when the
// coordinator omits initialMessage. This is the unguarded case: the tool schema
// marks initialMessage optional and _execute only posts when it is truthy
// (session-tools.mjs:261-263), so nothing is written.
// ---------------------------------------------------------------------------
test('without initialMessage the child still receives Brief A, but no session content', async () => {
  let aeordb = createClient();
  let runtime = createRuntime(aeordb, [ 'ses_parent', 'frm_user', 'int_1', 'commit_1', 'ses_child' ]);
  let parent = await runtime.createSession({ title: 'Parent' });
  await runtime.appendUserMessage(parent.id, { text: `${PARENT_MARKER}` });

  let child = await runtime.createSession({
    title: 'Child session',
    createdByAgentID: 'agent_parent',
    parentSessionID: parent.id,
    generation: 1,
  });
  let childSession = runtime.getSession(child.id);

  // A routed frame with no text is what a genuinely empty child looks like when
  // an agent is first woken in it.
  let triggerFrame = {
    id: 'frm_trigger',
    type: 'AgentMessage',
    sessionID: child.id,
    authorType: 'user',
    authorID: 'usr_owner',
    content: { text: '' },
  };

  let { messages } = await firstTurnMessages(runtime, child.id, {
    agent: { id: 'agent_child', name: 'Child' },
    frame: triggerFrame,
    session: childSession,
  });

  // Brief A is present: the child is not context-free, it is *session*-content-free.
  let system = messages[0];
  assert.equal(system.role, 'system');
  let last = messages[messages.length - 1];
  assert.equal(last.role, 'user');
  assert.match(last.content, /Kikx Advanced Agent Harness/,
    'Brief A must still orient the child with harness/character/tool context');
  assert.match(last.content, /delegated child session/,
    'Brief A must tell the child it is a delegated session');

  // ...but it knows nothing about the parent's work.
  assert.ok(!allText(messages).includes(PARENT_MARKER));
  assert.equal(messages.length, 2, 'system + one user turn, with no history');
});
