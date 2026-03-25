'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createKikxCore }       from '../../src/core/index.mjs';
import { InteractionLoop }     from '../../src/core/interaction/index.mjs';
import { SessionManager }      from '../../src/core/session/index.mjs';
import { FramePersistence }    from '../../src/core/frames/index.mjs';
import { MarkdownConverter }   from '../../src/core/lib/markdown-converter.mjs';
import { ContentSanitizer }    from '../../src/core/lib/content-sanitizer.mjs';

// =============================================================================
// postMessage Tests
// =============================================================================
// Tests for InteractionLoop.postMessage() — persists a user-message frame
// without starting an agent interaction. Supports sessions with no agents
// and multi-user channels.
// =============================================================================

describe('InteractionLoop.postMessage', () => {
  let core;
  let models;
  let context;
  let sessionManager;
  let framePersistence;

  before(async () => {
    core    = createKikxCore();
    await core.start();
    models  = core.getModels();
    context = core.getContext();

    sessionManager  = new SessionManager(context);
    framePersistence = new FramePersistence(context);

    context.setProperty('sessionManager', sessionManager);
    context.setProperty('framePersistence', framePersistence);
  });

  after(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  async function createTestSession() {
    let org     = await models.Organization.create({ name: 'Test Org' });
    let session = await sessionManager.createSession(org.id, { name: 'Test Session' });

    return session;
  }

  function createLoop() {
    return new InteractionLoop(context);
  }

  // ===========================================================================
  // Validation
  // ===========================================================================

  describe('validation', () => {
    it('should throw if sessionID is missing', async () => {
      let loop = createLoop();

      await assert.rejects(
        () => loop.postMessage(null, { text: 'hello' }),
        { message: /sessionID is required/ },
      );
    });

    it('should throw if text is missing', async () => {
      let loop    = createLoop();
      let session = await createTestSession();

      await assert.rejects(
        () => loop.postMessage(session.id, { authorType: 'user' }),
        { message: /text is required/ },
      );
    });

    it('should throw if text is empty string', async () => {
      let loop    = createLoop();
      let session = await createTestSession();

      await assert.rejects(
        () => loop.postMessage(session.id, { text: '' }),
        { message: /text is required/ },
      );
    });
  });

  // ===========================================================================
  // Frame creation
  // ===========================================================================

  describe('frame creation', () => {
    it('should persist a user-message frame', async () => {
      let loop    = createLoop();
      let session = await createTestSession();

      let result = await loop.postMessage(session.id, {
        text:       'Hello, world!',
        authorType: 'user',
        authorID:   'user_abc',
      });

      assert.ok(result.interactionID);
      assert.ok(result.frameID);

      // Verify frame is in the database
      let { Frame } = models;
      let frame = await Frame.where.id.EQ(result.frameID).first();

      assert.ok(frame);
      assert.equal(frame.type, 'UserMessage');
      assert.equal(frame.authorType, 'user');
      assert.equal(frame.authorID, 'user_abc');

      let content = typeof frame.getContent === 'function' ? frame.getContent() : frame.content;
      if (typeof content === 'string')
        content = JSON.parse(content);

      assert.equal(content.text, 'Hello, world!');
    });

    it('should not include estimatedTokens on the frame content', async () => {
      let loop    = createLoop();
      let session = await createTestSession();
      let text    = 'a'.repeat(100);

      let result = await loop.postMessage(session.id, { text, authorType: 'user', authorID: 'u1' });

      let { Frame } = models;
      let frame = await Frame.where.id.EQ(result.frameID).first();

      let content = typeof frame.getContent === 'function' ? frame.getContent() : frame.content;
      if (typeof content === 'string')
        content = JSON.parse(content);

      assert.equal(content.estimatedTokens, undefined);
    });

    it('should default authorType to user', async () => {
      let loop    = createLoop();
      let session = await createTestSession();

      let result = await loop.postMessage(session.id, { text: 'test' });

      let { Frame } = models;
      let frame = await Frame.where.id.EQ(result.frameID).first();

      assert.equal(frame.authorType, 'user');
    });

    it('should not start an active interaction', async () => {
      let loop    = createLoop();
      let session = await createTestSession();

      await loop.postMessage(session.id, { text: 'test', authorType: 'user' });

      assert.equal(loop.isActive(session.id), false);
    });
  });

  // ===========================================================================
  // Event emission
  // ===========================================================================

  describe('events', () => {
    it('should emit a frame event', async () => {
      let loop    = createLoop();
      let session = await createTestSession();
      let emitted = [];

      loop.on('frame', (data) => emitted.push(data));

      await loop.postMessage(session.id, { text: 'event test', authorType: 'user', authorID: 'u2' });

      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].sessionID, session.id);
      assert.equal(emitted[0].frame.type, 'UserMessage');
    });

    it('should emit a commit event', async () => {
      let loop    = createLoop();
      let session = await createTestSession();
      let commits = [];

      loop.on('commit', (data) => commits.push(data));

      await loop.postMessage(session.id, { text: 'commit test', authorType: 'user' });

      assert.equal(commits.length, 1);
      assert.equal(commits[0].sessionID, session.id);
      assert.ok(commits[0].commit);
      assert.ok(Array.isArray(commits[0].commit.frames));
      assert.equal(commits[0].commit.frames.length, 1);
      assert.equal(commits[0].commit.frames[0].type, 'UserMessage');
    });

    it('should NOT emit interaction:start or interaction:end', async () => {
      let loop    = createLoop();
      let session = await createTestSession();
      let starts  = [];
      let ends    = [];

      loop.on('interaction:start', (data) => starts.push(data));
      loop.on('interaction:end', (data) => ends.push(data));

      await loop.postMessage(session.id, { text: 'no interaction test', authorType: 'user' });

      assert.equal(starts.length, 0);
      assert.equal(ends.length, 0);
    });
  });

  // ===========================================================================
  // Multiple messages
  // ===========================================================================

  describe('multiple messages', () => {
    it('should persist multiple messages in sequence', async () => {
      let loop    = createLoop();
      let session = await createTestSession();

      let r1 = await loop.postMessage(session.id, { text: 'first',  authorType: 'user', authorID: 'u1' });
      let r2 = await loop.postMessage(session.id, { text: 'second', authorType: 'user', authorID: 'u2' });
      let r3 = await loop.postMessage(session.id, { text: 'third',  authorType: 'user', authorID: 'u1' });

      assert.notEqual(r1.frameID, r2.frameID);
      assert.notEqual(r2.frameID, r3.frameID);

      // All three should exist in DB
      let { Frame } = models;
      let f1 = await Frame.where.id.EQ(r1.frameID).first();
      let f2 = await Frame.where.id.EQ(r2.frameID).first();
      let f3 = await Frame.where.id.EQ(r3.frameID).first();

      assert.ok(f1);
      assert.ok(f2);
      assert.ok(f3);
    });

    it('should handle different authorIDs (multi-user)', async () => {
      let loop    = createLoop();
      let session = await createTestSession();

      let r1 = await loop.postMessage(session.id, { text: 'from alice', authorType: 'user', authorID: 'user_alice' });
      let r2 = await loop.postMessage(session.id, { text: 'from bob',   authorType: 'user', authorID: 'user_bob' });

      let { Frame } = models;
      let f1 = await Frame.where.id.EQ(r1.frameID).first();
      let f2 = await Frame.where.id.EQ(r2.frameID).first();

      assert.equal(f1.authorID, 'user_alice');
      assert.equal(f2.authorID, 'user_bob');
    });
  });

  // ===========================================================================
  // Markdown conversion
  // ===========================================================================

  describe('markdown conversion', () => {
    function createLoopWithMarkdown() {
      let sanitizer = new ContentSanitizer();
      let converter = new MarkdownConverter(sanitizer);
      context.setProperty('markdownConverter', converter);

      return new InteractionLoop(context);
    }

    it('should store content.text when convertMarkdown is false', async () => {
      let loop    = createLoopWithMarkdown();
      let session = await createTestSession();

      let result = await loop.postMessage(session.id, {
        text:            '**bold**',
        authorType:      'user',
        convertMarkdown: false,
      });

      let { Frame } = models;
      let frame = await Frame.where.id.EQ(result.frameID).first();

      let content = typeof frame.getContent === 'function' ? frame.getContent() : frame.content;
      if (typeof content === 'string')
        content = JSON.parse(content);

      assert.equal(content.text, '**bold**');
      assert.equal(content.html, undefined);
    });

    it('should store content.text when convertMarkdown is not provided', async () => {
      let loop    = createLoopWithMarkdown();
      let session = await createTestSession();

      let result = await loop.postMessage(session.id, {
        text:       'hello',
        authorType: 'user',
      });

      let { Frame } = models;
      let frame = await Frame.where.id.EQ(result.frameID).first();

      let content = typeof frame.getContent === 'function' ? frame.getContent() : frame.content;
      if (typeof content === 'string')
        content = JSON.parse(content);

      assert.equal(content.text, 'hello');
      assert.equal(content.html, undefined);
    });

    it('should convert markdown and store content.html when convertMarkdown is true', async () => {
      let loop    = createLoopWithMarkdown();
      let session = await createTestSession();

      let result = await loop.postMessage(session.id, {
        text:            '**bold** and *italic*',
        authorType:      'user',
        convertMarkdown: true,
      });

      let { Frame } = models;
      let frame = await Frame.where.id.EQ(result.frameID).first();

      let content = typeof frame.getContent === 'function' ? frame.getContent() : frame.content;
      if (typeof content === 'string')
        content = JSON.parse(content);

      assert.ok(content.html, 'content.html should be set');
      assert.ok(content.html.includes('<strong>bold</strong>'), 'should contain bold HTML');
      assert.ok(content.html.includes('<em>italic</em>'), 'should contain italic HTML');
      assert.equal(content.text, undefined, 'content.text should not be set');
    });

    it('should not include estimatedTokens when converting markdown', async () => {
      let loop    = createLoopWithMarkdown();
      let session = await createTestSession();
      let text    = '**test** content';

      let result = await loop.postMessage(session.id, {
        text,
        authorType:      'user',
        convertMarkdown: true,
      });

      let { Frame } = models;
      let frame = await Frame.where.id.EQ(result.frameID).first();

      let content = typeof frame.getContent === 'function' ? frame.getContent() : frame.content;
      if (typeof content === 'string')
        content = JSON.parse(content);

      assert.equal(content.estimatedTokens, undefined);
    });

    it('should sanitize converted HTML', async () => {
      let loop    = createLoopWithMarkdown();
      let session = await createTestSession();

      let result = await loop.postMessage(session.id, {
        text:            'Hello <script>alert("xss")</script>',
        authorType:      'user',
        convertMarkdown: true,
      });

      let { Frame } = models;
      let frame = await Frame.where.id.EQ(result.frameID).first();

      let content = typeof frame.getContent === 'function' ? frame.getContent() : frame.content;
      if (typeof content === 'string')
        content = JSON.parse(content);

      assert.ok(!content.html.includes('<script>'), 'should strip script tags');
      assert.ok(!content.html.includes('alert'), 'should strip script content');
    });

    it('should handle markdown with code blocks', async () => {
      let loop    = createLoopWithMarkdown();
      let session = await createTestSession();

      let result = await loop.postMessage(session.id, {
        text:            '```\nconst x = 1;\n```',
        authorType:      'user',
        convertMarkdown: true,
      });

      let { Frame } = models;
      let frame = await Frame.where.id.EQ(result.frameID).first();

      let content = typeof frame.getContent === 'function' ? frame.getContent() : frame.content;
      if (typeof content === 'string')
        content = JSON.parse(content);

      assert.ok(content.html.includes('<pre>'), 'should contain pre tag');
      assert.ok(content.html.includes('<code>'), 'should contain code tag');
    });

    it('should fall back to raw text when markdownConverter is not on context', async () => {
      // Remove converter from context to test fallback
      context.setProperty('markdownConverter', null);

      let loop    = new InteractionLoop(context);
      let session = await createTestSession();

      let result = await loop.postMessage(session.id, {
        text:            '**bold**',
        authorType:      'user',
        convertMarkdown: true,
      });

      let { Frame } = models;
      let frame = await Frame.where.id.EQ(result.frameID).first();

      let content = typeof frame.getContent === 'function' ? frame.getContent() : frame.content;
      if (typeof content === 'string')
        content = JSON.parse(content);

      // Without converter, the raw text is stored as html
      assert.equal(content.html, '**bold**');
    });
  });
});
