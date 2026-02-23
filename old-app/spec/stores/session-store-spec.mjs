'use strict';

/**
 * Tests for SessionStore
 *
 * TDD: These tests define the expected behavior.
 * Implementation comes after tests pass.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

// Will be implemented
import { SessionStore, createSessionStore } from '../../public/js/stores/session-store.mjs';

// =============================================================================
// Test: Store Creation and Multi-Session Support
// =============================================================================

describe('SessionStore Creation', () => {
  let store;

  beforeEach(() => {
    store = createSessionStore();
  });

  it('should create an empty store', () => {
    assert.ok(store);
    assert.strictEqual(typeof store.getSession, 'function');
  });

  it('should support multiple simultaneous sessions', () => {
    const session1 = store.getSession(1);
    const session2 = store.getSession(2);

    session1.add({ role: 'user', content: 'Hello from session 1' });
    session2.add({ role: 'user', content: 'Hello from session 2' });

    assert.strictEqual(session1.count, 1);
    assert.strictEqual(session2.count, 1);
    assert.strictEqual(session1.getAll()[0].content, 'Hello from session 1');
    assert.strictEqual(session2.getAll()[0].content, 'Hello from session 2');
  });

  it('should return same session instance for same ID', () => {
    const session1a = store.getSession(1);
    const session1b = store.getSession(1);

    assert.strictEqual(session1a, session1b);
  });

  it('should handle string and number session IDs', () => {
    const sessionNum = store.getSession(123);
    const sessionStr = store.getSession('123');

    // Should be the same session (coerced)
    sessionNum.add({ role: 'user', content: 'test' });
    assert.strictEqual(sessionStr.count, 1);
  });
});

// =============================================================================
// Test: SessionMessages - Basic CRUD
// =============================================================================

describe('SessionMessages CRUD', () => {
  let store;
  let session;

  beforeEach(() => {
    store = createSessionStore();
    session = store.getSession(1);
  });

  it('should add a message and assign ID if missing', () => {
    const msg = session.add({ role: 'user', content: 'Hello' });

    assert.ok(msg.id);
    assert.strictEqual(msg.role, 'user');
    assert.strictEqual(msg.content, 'Hello');
    assert.ok(msg.createdAt);
  });

  it('should preserve existing ID when adding', () => {
    const msg = session.add({ id: 42, role: 'user', content: 'Hello' });

    assert.strictEqual(msg.id, 42);
  });

  it('should find message by ID', () => {
    session.add({ id: 100, role: 'user', content: 'Find me' });

    const found = session.findById(100);
    assert.ok(found);
    assert.strictEqual(found.content, 'Find me');
  });

  it('should handle string/number ID coercion in findById', () => {
    session.add({ id: 100, role: 'user', content: 'Coercion test' });

    // Find with string when stored as number
    const foundStr = session.findById('100');
    assert.ok(foundStr);
    assert.strictEqual(foundStr.content, 'Coercion test');

    // Find with number when stored as string
    session.add({ id: '200', role: 'user', content: 'String ID' });
    const foundNum = session.findById(200);
    assert.ok(foundNum);
    assert.strictEqual(foundNum.content, 'String ID');
  });

  it('should return null for non-existent ID', () => {
    const found = session.findById(999);
    assert.strictEqual(found, null);
  });

  it('should update message by ID', () => {
    session.add({ id: 1, role: 'user', content: 'Original' });

    const updated = session.update(1, { content: 'Updated' });

    assert.ok(updated);
    assert.strictEqual(updated.content, 'Updated');
    assert.strictEqual(session.findById(1).content, 'Updated');
  });

  it('should remove message by ID', () => {
    session.add({ id: 1, role: 'user', content: 'To delete' });
    assert.strictEqual(session.count, 1);

    const removed = session.remove(1);

    assert.strictEqual(removed, true);
    assert.strictEqual(session.count, 0);
    assert.strictEqual(session.findById(1), null);
  });

  it('should get all messages', () => {
    session.add({ role: 'user', content: 'First' });
    session.add({ role: 'assistant', content: 'Second' });
    session.add({ role: 'user', content: 'Third' });

    const all = session.getAll();

    assert.strictEqual(all.length, 3);
    assert.strictEqual(all[0].content, 'First');
    assert.strictEqual(all[2].content, 'Third');
  });

  it('should filter hidden messages by default', () => {
    session.add({ role: 'user', content: 'Visible' });
    session.add({ role: 'system', content: 'Hidden', hidden: true });

    const visible = session.getAll();
    const all = session.getAll({ includeHidden: true });

    assert.strictEqual(visible.length, 1);
    assert.strictEqual(all.length, 2);
  });

  it('should clear all messages', () => {
    session.add({ role: 'user', content: 'One' });
    session.add({ role: 'user', content: 'Two' });
    assert.strictEqual(session.count, 2);

    session.clear();

    assert.strictEqual(session.count, 0);
  });
});

// =============================================================================
// Test: Content Format Handling
// =============================================================================

describe('SessionMessages Content Formats', () => {
  let store;
  let session;

  beforeEach(() => {
    store = createSessionStore();
    session = store.getSession(1);
  });

  it('should handle string content format', () => {
    session.add({ id: 1, role: 'assistant', content: 'Hello world' });

    const msg = session.findById(1);
    assert.strictEqual(typeof msg.content, 'string');
  });

  it('should handle Claude API array content format', () => {
    const arrayContent = [
      { type: 'text', text: 'Hello world' },
    ];
    session.add({ id: 1, role: 'assistant', content: arrayContent });

    const msg = session.findById(1);
    assert.ok(Array.isArray(msg.content));
    assert.strictEqual(msg.content[0].text, 'Hello world');
  });

  it('should update content with string format', () => {
    session.add({ id: 1, role: 'assistant', content: 'Original text' });

    session.updateContent(1, (content) => content.replace('Original', 'Updated'));

    assert.strictEqual(session.findById(1).content, 'Updated text');
  });

  it('should update content with array format', () => {
    session.add({
      id: 1,
      role: 'assistant',
      content: [{ type: 'text', text: 'Original text' }],
    });

    session.updateContent(1, (content) => content.replace('Original', 'Updated'));

    const msg = session.findById(1);
    assert.strictEqual(msg.content[0].text, 'Updated text');
  });

  it('should extract text from array format for updateContent', () => {
    session.add({
      id: 1,
      role: 'assistant',
      content: [
        { type: 'tool_use', name: 'something' },
        { type: 'text', text: 'The actual text' },
      ],
    });

    session.updateContent(1, (content) => content.replace('actual', 'modified'));

    const msg = session.findById(1);
    // Should update the text block, not the tool_use block
    assert.strictEqual(msg.content[1].text, 'The modified text');
  });
});

// =============================================================================
// Test: Prompt Operations
// =============================================================================

describe('SessionMessages Prompt Operations', () => {
  let store;
  let session;

  beforeEach(() => {
    store = createSessionStore();
    session = store.getSession(1);
  });

  it('should answer a prompt in message content', () => {
    const content = '<hml-prompt id="prompt-123" type="text">What is your name?</hml-prompt>';
    session.add({ id: 1, role: 'assistant', content });

    const result = session.answerPrompt(1, 'prompt-123', 'Claude');

    assert.strictEqual(result, true);

    const msg = session.findById(1);
    assert.ok(msg.content.includes('answered="true"'));
    assert.ok(msg.content.includes('<response>Claude</response>'));
  });

  it('should answer prompt with ID coercion', () => {
    const content = '<hml-prompt id="prompt-123">Question?</hml-prompt>';
    session.add({ id: '1', role: 'assistant', content }); // String ID

    const result = session.answerPrompt(1, 'prompt-123', 'Answer'); // Number ID

    assert.strictEqual(result, true);
  });

  it('should escape XML characters in answer', () => {
    const content = '<hml-prompt id="prompt-123">Question?</hml-prompt>';
    session.add({ id: 1, role: 'assistant', content });

    session.answerPrompt(1, 'prompt-123', '<script>alert("xss")</script>');

    const msg = session.findById(1);
    assert.ok(msg.content.includes('&lt;script&gt;'));
    assert.ok(!msg.content.includes('<script>'));
  });

  it('should handle prompt in array content format', () => {
    session.add({
      id: 1,
      role: 'assistant',
      content: [
        { type: 'text', text: '<hml-prompt id="prompt-123">Question?</hml-prompt>' },
      ],
    });

    const result = session.answerPrompt(1, 'prompt-123', 'Answer');

    assert.strictEqual(result, true);
    const msg = session.findById(1);
    assert.ok(msg.content[0].text.includes('answered="true"'));
  });

  it('should return false if prompt not found', () => {
    session.add({ id: 1, role: 'assistant', content: 'No prompt here' });

    const result = session.answerPrompt(1, 'prompt-123', 'Answer');

    assert.strictEqual(result, false);
  });

  it('should return false if message not found', () => {
    const result = session.answerPrompt(999, 'prompt-123', 'Answer');

    assert.strictEqual(result, false);
  });

  it('should find unanswered prompts', () => {
    session.add({
      id: 1,
      role: 'assistant',
      content: '<hml-prompt id="p1">Question 1?</hml-prompt>',
    });
    session.add({
      id: 2,
      role: 'assistant',
      content: '<hml-prompt id="p2" answered="true">Question 2?<response>Done</response></hml-prompt>',
    });
    session.add({
      id: 3,
      role: 'assistant',
      content: '<hml-prompt id="p3">Question 3?</hml-prompt>',
    });

    const unanswered = session.findUnansweredPrompts();

    assert.strictEqual(unanswered.length, 2);
    assert.strictEqual(unanswered[0].promptId, 'p1');
    assert.strictEqual(unanswered[1].promptId, 'p3');
  });
});

// =============================================================================
// Test: Optimistic Messages
// =============================================================================

describe('SessionMessages Optimistic Updates', () => {
  let store;
  let session;

  beforeEach(() => {
    store = createSessionStore();
    session = store.getSession(1);
  });

  it('should add optimistic message with temp ID', () => {
    const tempId = session.addOptimistic({ role: 'user', content: 'Sending...' });

    assert.ok(tempId);
    assert.ok(tempId.startsWith('optimistic-'));

    const msg = session.findById(tempId);
    assert.ok(msg);
    assert.strictEqual(msg.optimistic, true);
  });

  it('should confirm optimistic message with real ID', () => {
    const tempId = session.addOptimistic({ role: 'user', content: 'Sending...' });

    session.confirmOptimistic(tempId, {
      id: 42,
      role: 'user',
      content: 'Sent!',
      createdAt: new Date().toISOString(),
    });

    // Temp ID should no longer exist
    assert.strictEqual(session.findById(tempId), null);

    // Real message should exist
    const msg = session.findById(42);
    assert.ok(msg);
    assert.strictEqual(msg.content, 'Sent!');
    assert.strictEqual(msg.optimistic, undefined);
  });

  it('should reject optimistic message', () => {
    const tempId = session.addOptimistic({ role: 'user', content: 'Failed' });
    assert.strictEqual(session.count, 1);

    session.rejectOptimistic(tempId);

    assert.strictEqual(session.count, 0);
    assert.strictEqual(session.findById(tempId), null);
  });
});

// =============================================================================
// Test: Subscriptions
// =============================================================================

describe('SessionMessages Subscriptions', () => {
  let store;
  let session;

  beforeEach(() => {
    store = createSessionStore();
    session = store.getSession(1);
  });

  it('should notify subscribers on add', () => {
    const events = [];
    session.subscribe((event) => events.push(event));

    session.add({ role: 'user', content: 'Test' });

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'add');
    assert.strictEqual(events[0].message.content, 'Test');
  });

  it('should notify subscribers on update', () => {
    const events = [];
    session.add({ id: 1, role: 'user', content: 'Original' });

    session.subscribe((event) => events.push(event));
    session.update(1, { content: 'Updated' });

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'update');
  });

  it('should notify subscribers on remove', () => {
    const events = [];
    session.add({ id: 1, role: 'user', content: 'To remove' });

    session.subscribe((event) => events.push(event));
    session.remove(1);

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'remove');
  });

  it('should notify subscribers on clear', () => {
    const events = [];
    session.add({ role: 'user', content: 'One' });
    session.add({ role: 'user', content: 'Two' });

    session.subscribe((event) => events.push(event));
    session.clear();

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'clear');
  });

  it('should allow unsubscribe', () => {
    const events = [];
    const unsubscribe = session.subscribe((event) => events.push(event));

    session.add({ role: 'user', content: 'First' });
    assert.strictEqual(events.length, 1);

    unsubscribe();

    session.add({ role: 'user', content: 'Second' });
    assert.strictEqual(events.length, 1); // No new event
  });

  it('should support multiple subscribers', () => {
    let count1 = 0;
    let count2 = 0;

    session.subscribe(() => count1++);
    session.subscribe(() => count2++);

    session.add({ role: 'user', content: 'Test' });

    assert.strictEqual(count1, 1);
    assert.strictEqual(count2, 1);
  });
});

// =============================================================================
// Test: Bulk Operations
// =============================================================================

describe('SessionMessages Bulk Operations', () => {
  let store;
  let session;

  beforeEach(() => {
    store = createSessionStore();
    session = store.getSession(1);
  });

  it('should initialize with messages', () => {
    const messages = [
      { id: 1, role: 'user', content: 'Hello' },
      { id: 2, role: 'assistant', content: 'Hi there' },
    ];

    session.init(messages);

    assert.strictEqual(session.count, 2);
    assert.strictEqual(session.findById(1).content, 'Hello');
  });

  it('should notify once for bulk init', () => {
    const events = [];
    session.subscribe((event) => events.push(event));

    session.init([
      { id: 1, role: 'user', content: 'One' },
      { id: 2, role: 'user', content: 'Two' },
    ]);

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'init');
    assert.strictEqual(events[0].messages.length, 2);
  });

  it('should replace existing messages on init', () => {
    session.add({ role: 'user', content: 'Old' });
    assert.strictEqual(session.count, 1);

    session.init([{ id: 1, role: 'user', content: 'New' }]);

    assert.strictEqual(session.count, 1);
    assert.strictEqual(session.findById(1).content, 'New');
  });
});

// =============================================================================
// Summary
// =============================================================================

/*
 * These tests define the SessionStore interface:
 *
 * 1. Multi-session support with getSession(id)
 * 2. CRUD operations (add, findById, update, remove, getAll)
 * 3. ID coercion (string/number handled transparently)
 * 4. Content format handling (string vs Claude API array)
 * 5. Prompt operations (answerPrompt, findUnansweredPrompts)
 * 6. Optimistic updates (addOptimistic, confirm, reject)
 * 7. Subscriptions for reactivity
 * 8. Bulk operations (init, clear)
 *
 * To run: node --test spec/stores/session-store-spec.mjs
 */
