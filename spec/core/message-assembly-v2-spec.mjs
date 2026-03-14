'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }     from '../../src/core/index.mjs';
import { InteractionLoop }    from '../../src/core/interaction/index.mjs';
import { SessionManager }     from '../../src/core/session/index.mjs';
import { FramePersistence }   from '../../src/core/frames/index.mjs';
import { ContentSanitizer }   from '../../src/core/lib/content-sanitizer.mjs';
import { PrimerAssembler }    from '../../src/core/primer/index.mjs';

// =============================================================================
// Phase B6 — Message Assembly v2
// =============================================================================

describe('Message Assembly v2 (B6)', () => {
  let core;
  let context;
  let loop;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    context = core.getContext();

    let sessionManager   = new SessionManager(context);
    let framePersistence = new FramePersistence(context);

    context.setProperty('sessionManager', sessionManager);
    context.setProperty('framePersistence', framePersistence);
    context.setProperty('contentSanitizer', new ContentSanitizer());

    loop = new InteractionLoop(context);
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  // ---------------------------------------------------------------------------
  // Single-agent backward compat
  // ---------------------------------------------------------------------------

  describe('single-agent (no forAgentID)', () => {
    it('should produce identical output to v1 when no forAgentID', () => {
      let frames = [
        { id: 'f1', type: 'user-message', content: { text: 'Hello' }, hidden: false, deleted: false },
        { id: 'f2', type: 'message', content: { html: '<p>Hi</p>' }, hidden: false, deleted: false, authorType: 'agent', authorID: 'agt_1' },
      ];

      let messages = loop._buildMessages(frames);

      assert.equal(messages.length, 2);
      assert.equal(messages[0].role, 'user');
      assert.equal(messages[0].content, 'Hello');
      assert.equal(messages[1].role, 'assistant');
      assert.equal(messages[1].content, '<p>Hi</p>');
    });

    it('should include frameID on messages', () => {
      let frames = [
        { id: 'f1', type: 'user-message', content: { text: 'Hi' }, hidden: false, deleted: false },
      ];

      let messages = loop._buildMessages(frames);
      assert.equal(messages[0].frameID, 'f1');
    });

    it('should skip hidden/deleted/excluded frames', () => {
      let frames = [
        { id: 'f1', type: 'user-message', content: { text: 'Hi' }, hidden: false, deleted: false },
        { id: 'f2', type: 'user-message', content: { text: 'Hidden' }, hidden: true, deleted: false },
        { id: 'f3', type: 'user-message', content: { text: 'Deleted' }, hidden: false, deleted: true },
        { id: 'f4', type: 'error', content: { message: 'oops' }, hidden: false, deleted: false },
        { id: 'f5', type: 'stop', content: {}, hidden: false, deleted: false },
      ];

      let messages = loop._buildMessages(frames);
      assert.equal(messages.length, 1);
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-agent attribution
  // ---------------------------------------------------------------------------

  describe('multi-agent (with forAgentID)', () => {
    it('should render own messages as role:assistant', () => {
      let frames = [
        { id: 'f1', type: 'message', content: { html: '<p>My msg</p>' }, hidden: false, deleted: false, authorType: 'agent', authorID: 'agt_me' },
      ];

      let messages = loop._buildMessages(frames, 'agt_me');

      assert.equal(messages.length, 1);
      assert.equal(messages[0].role, 'assistant');
      assert.equal(messages[0].content, '<p>My msg</p>');
    });

    it('should wrap other agent messages in attribution tags', () => {
      let frames = [
        { id: 'f1', type: 'message', content: { html: '<p>Other says hi</p>' }, hidden: false, deleted: false, authorType: 'agent', authorID: 'agt_other' },
      ];

      let messages = loop._buildMessages(frames, 'agt_me');

      assert.equal(messages.length, 1);
      assert.equal(messages[0].role, 'user');
      assert.ok(messages[0].content.includes('<agent-message'));
      assert.ok(messages[0].content.includes('source="agt_other"'));
      assert.ok(messages[0].content.includes('<p>Other says hi</p>'));
      assert.equal(messages[0].sourceAgentID, 'agt_other');
    });

    it('should keep user messages as role:user without wrapping', () => {
      let frames = [
        { id: 'f1', type: 'user-message', content: { text: 'User msg' }, hidden: false, deleted: false, authorType: 'user', authorID: 'usr_1' },
      ];

      let messages = loop._buildMessages(frames, 'agt_me');

      assert.equal(messages.length, 1);
      assert.equal(messages[0].role, 'user');
      assert.equal(messages[0].content, 'User msg');
      assert.equal(messages[0].sourceAgentID, undefined);
    });

    it('should handle mixed conversation with multiple agents', () => {
      let frames = [
        { id: 'f1', type: 'user-message', content: { text: 'Hello all' }, hidden: false, deleted: false },
        { id: 'f2', type: 'message', content: { html: '<p>Agent A says hi</p>' }, hidden: false, deleted: false, authorType: 'agent', authorID: 'agt_A' },
        { id: 'f3', type: 'message', content: { html: '<p>Agent B says hi</p>' }, hidden: false, deleted: false, authorType: 'agent', authorID: 'agt_B' },
        { id: 'f4', type: 'message', content: { html: '<p>I respond</p>' }, hidden: false, deleted: false, authorType: 'agent', authorID: 'agt_me' },
      ];

      let messages = loop._buildMessages(frames, 'agt_me');

      assert.equal(messages.length, 4);

      // User message → role:user
      assert.equal(messages[0].role, 'user');
      assert.equal(messages[0].content, 'Hello all');

      // Agent A → role:user with wrapper (other agent)
      assert.equal(messages[1].role, 'user');
      assert.ok(messages[1].content.includes('<agent-message'));

      // Agent B → role:user with wrapper (other agent)
      assert.equal(messages[2].role, 'user');
      assert.ok(messages[2].content.includes('<agent-message'));

      // My message → role:assistant
      assert.equal(messages[3].role, 'assistant');
      assert.equal(messages[3].content, '<p>I respond</p>');
    });

    it('should treat messages without authorID as assistant (backward compat)', () => {
      let frames = [
        { id: 'f1', type: 'message', content: { html: '<p>Old msg</p>' }, hidden: false, deleted: false },
      ];

      let messages = loop._buildMessages(frames, 'agt_me');

      // No authorID → not recognized as another agent → falls to assistant
      assert.equal(messages[0].role, 'assistant');
    });

    it('should include tool-call and tool-result with frameID', () => {
      let frames = [
        { id: 'f1', type: 'tool-call', content: { toolName: 'test', toolUseID: 'tu_1' }, hidden: false, deleted: false },
        { id: 'f2', type: 'tool-result', content: { output: 'done', toolUseID: 'tu_1' }, hidden: false, deleted: false },
      ];

      let messages = loop._buildMessages(frames, 'agt_me');

      assert.equal(messages.length, 2);
      assert.equal(messages[0].frameID, 'f1');
      assert.equal(messages[1].frameID, 'f2');
    });
  });

  // ---------------------------------------------------------------------------
  // PrimerAssembler multi-agent additions
  // ---------------------------------------------------------------------------

  describe('PrimerAssembler multi-agent', () => {
    it('should include multi-agent context when >1 participant', async () => {
      let assembler = new PrimerAssembler(context);

      let primer = await assembler.assemble(
        { id: 'agt_me', name: 'test-me' },
        {
          participants: [
            { agentID: 'agt_me' },
            { agentID: 'agt_other' },
          ],
        },
      );

      assert.ok(primer.includes('MULTI-AGENT SESSION'));
      assert.ok(primer.includes('agt_other'));
      assert.ok(primer.includes('<agent-message'));
    });

    it('should NOT include multi-agent context for single participant', async () => {
      let assembler = new PrimerAssembler(context);

      let primer = await assembler.assemble(
        { id: 'agt_me', name: 'test-me' },
        {
          participants: [
            { agentID: 'agt_me' },
          ],
        },
      );

      assert.ok(!primer.includes('MULTI-AGENT SESSION'));
    });

    it('should NOT include multi-agent context when no participants option', async () => {
      let assembler = new PrimerAssembler(context);

      let primer = await assembler.assemble({ id: 'agt_me', name: 'test-me' });

      assert.ok(!primer.includes('MULTI-AGENT SESSION'));
    });
  });
});
