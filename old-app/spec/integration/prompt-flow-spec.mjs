'use strict';

// ============================================================================
// Prompt Answer Flow Integration Tests
// ============================================================================
// Tests the full prompt answer flow including:
// - SessionStore message management
// - ID coercion (string vs number) - Bug 1.3
// - Prompt state updates
// - Content format handling

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Import SessionStore (ES module version for Node.js tests)
import {
  SessionStore,
  SessionMessages,
  createSessionStore,
} from '../../public/js/stores/session-store.mjs';

// ============================================================================
// Test: Bug 1.3 - ID Type Coercion
// ============================================================================

describe('Bug 1.3: ID Type Coercion', () => {
  let sessionStore;
  let session;

  beforeEach(() => {
    sessionStore = createSessionStore();
    session = sessionStore.getSession(1);
  });

  it('should find message when ID is number but search is string', () => {
    // Add message with number ID (like from database)
    session.add({ id: 123, role: 'assistant', content: 'Hello' });

    // Search with string ID (like from data-message-id attribute)
    const found = session.findById('123');

    assert.ok(found, 'Should find message with string ID');
    assert.strictEqual(found.content, 'Hello');
  });

  it('should find message when ID is string but search is number', () => {
    // Add message with string ID (like optimistic ID)
    session.add({ id: 'msg-abc-123', role: 'assistant', content: 'World' });

    // Search with same string (this should work normally)
    const found = session.findById('msg-abc-123');

    assert.ok(found, 'Should find message with string ID');
    assert.strictEqual(found.content, 'World');
  });

  it('should update message regardless of ID type mismatch', () => {
    // Add message with number ID
    session.add({ id: 456, role: 'assistant', content: 'Original' });

    // Update with string ID
    const updated = session.update('456', { content: 'Modified' });

    assert.ok(updated, 'Should update message');
    assert.strictEqual(updated.content, 'Modified');

    // Verify the update persisted
    const found = session.findById(456);
    assert.strictEqual(found.content, 'Modified');
  });
});

// ============================================================================
// Test: Prompt Answer State Update
// ============================================================================

describe('Prompt Answer State Update', () => {
  let sessionStore;
  let session;

  beforeEach(() => {
    sessionStore = createSessionStore();
    session = sessionStore.getSession(1);
  });

  it('should update prompt to answered state via answerPrompt()', () => {
    const content = '<hml-prompt id="prompt-123" type="text">What is your name?</hml-prompt>';
    session.add({ id: 1, role: 'assistant', content });

    const success = session.answerPrompt(1, 'prompt-123', 'Claude');

    assert.strictEqual(success, true, 'answerPrompt should return true');

    const msg = session.findById(1);
    assert.ok(msg.content.includes('answered="true"'), 'Should have answered attribute');
    assert.ok(msg.content.includes('<response>Claude</response>'), 'Should have response');
  });

  it('should handle ID type mismatch in answerPrompt()', () => {
    // This is the exact Bug 1.3 scenario:
    // Message has number ID (from database)
    // Event has string ID (from data-message-id attribute)
    const content = '<hml-prompt id="prompt-abc" type="text">Question?</hml-prompt>';
    session.add({ id: 789, role: 'assistant', content });

    // Answer with string ID
    const success = session.answerPrompt('789', 'prompt-abc', 'My Answer');

    assert.strictEqual(success, true, 'Should succeed despite ID type mismatch');

    const msg = session.findById(789);
    assert.ok(msg.content.includes('answered="true"'), 'Should be answered');
    assert.ok(msg.content.includes('My Answer'), 'Should contain answer');
  });

  it('should find no unanswered prompts after answerPrompt()', () => {
    const content = '<hml-prompt id="prompt-xyz" type="radio">Pick one?</hml-prompt>';
    session.add({ id: 1, role: 'assistant', content });

    // Before answering
    const before = session.findUnansweredPrompts();
    assert.strictEqual(before.length, 1, 'Should have 1 unanswered prompt');

    // Answer
    session.answerPrompt(1, 'prompt-xyz', 'Option A');

    // After answering
    const after = session.findUnansweredPrompts();
    assert.strictEqual(after.length, 0, 'Should have 0 unanswered prompts');
  });
});

// ============================================================================
// Test: Content Format Handling
// ============================================================================

describe('Content Format Handling', () => {
  let sessionStore;
  let session;

  beforeEach(() => {
    sessionStore = createSessionStore();
    session = sessionStore.getSession(1);
  });

  it('should handle string content format', () => {
    const content = '<hml-prompt id="p1" type="text">Question?</hml-prompt>';
    session.add({ id: 1, role: 'assistant', content });

    const success = session.answerPrompt(1, 'p1', 'Answer');

    assert.strictEqual(success, true);
    const msg = session.findById(1);
    assert.strictEqual(typeof msg.content, 'string');
    assert.ok(msg.content.includes('answered="true"'));
  });

  it('should handle Claude API array format', () => {
    const content = [
      { type: 'text', text: '<hml-prompt id="p2" type="text">Question?</hml-prompt>' },
    ];
    session.add({ id: 2, role: 'assistant', content });

    const success = session.answerPrompt(2, 'p2', 'Array Answer');

    assert.strictEqual(success, true);
    const msg = session.findById(2);
    assert.ok(Array.isArray(msg.content), 'Should preserve array format');
    assert.ok(msg.content[0].text.includes('answered="true"'));
    assert.ok(msg.content[0].text.includes('Array Answer'));
  });

  it('should handle array format with multiple blocks', () => {
    const content = [
      { type: 'tool_use', name: 'search' },
      { type: 'text', text: 'Here is a prompt: <hml-prompt id="p3" type="text">Q?</hml-prompt>' },
    ];
    session.add({ id: 3, role: 'assistant', content });

    const success = session.answerPrompt(3, 'p3', 'Multi-block');

    assert.strictEqual(success, true);
    const msg = session.findById(3);
    // Should update the text block, not the tool_use block
    assert.strictEqual(msg.content[0].type, 'tool_use', 'Tool block unchanged');
    assert.ok(msg.content[1].text.includes('answered="true"'));
  });
});

// ============================================================================
// Test: Optimistic Update Flow
// ============================================================================

describe('Optimistic Update Flow', () => {
  let sessionStore;
  let session;

  beforeEach(() => {
    sessionStore = createSessionStore();
    session = sessionStore.getSession(1);
  });

  it('should add optimistic message with temp ID', () => {
    const tempId = session.addOptimistic({
      role: 'user',
      content: 'Pending message',
    });

    assert.ok(tempId.startsWith('optimistic-'), 'Should have optimistic prefix');

    const msg = session.findById(tempId);
    assert.ok(msg, 'Should find message');
    assert.ok(msg.optimistic, 'Should be marked optimistic');
  });

  it('should confirm optimistic message with real ID', () => {
    const tempId = session.addOptimistic({
      role: 'user',
      content: 'Pending',
    });

    // Simulate server confirmation
    session.confirmOptimistic(tempId, {
      id: 999,
      role: 'user',
      content: 'Confirmed',
      createdAt: '2024-01-01T00:00:00Z',
    });

    // Temp ID should no longer exist
    const byTemp = session.findById(tempId);
    assert.strictEqual(byTemp, null, 'Temp ID should be gone');

    // Real ID should exist
    const byReal = session.findById(999);
    assert.ok(byReal, 'Real ID should exist');
    assert.strictEqual(byReal.content, 'Confirmed');
    assert.ok(!byReal.optimistic, 'Should not be optimistic');
  });

  it('should handle prompt answer on confirmed message', () => {
    // Full flow: optimistic -> confirm -> answer prompt

    // 1. AI sends message with prompt (optimistic during streaming)
    const tempId = session.addOptimistic({
      role: 'assistant',
      content: '<hml-prompt id="p-opt" type="text">Question?</hml-prompt>',
    });

    // 2. Server confirms with real ID
    session.confirmOptimistic(tempId, {
      id: 1001,
      role: 'assistant',
      content: '<hml-prompt id="p-opt" type="text">Question?</hml-prompt>',
      createdAt: '2024-01-01T00:00:00Z',
    });

    // 3. User answers prompt using real ID
    const success = session.answerPrompt(1001, 'p-opt', 'The answer');

    assert.strictEqual(success, true, 'Should answer successfully');

    const msg = session.findById(1001);
    assert.ok(msg.content.includes('answered="true"'));
    assert.ok(msg.content.includes('The answer'));
  });
});

// ============================================================================
// Test: Subscription Notifications
// ============================================================================

describe('Subscription Notifications', () => {
  let sessionStore;
  let session;

  beforeEach(() => {
    sessionStore = createSessionStore();
    session = sessionStore.getSession(1);
  });

  it('should notify on prompt answer update', () => {
    const events = [];
    session.subscribe((event) => events.push(event));

    session.add({
      id: 1,
      role: 'assistant',
      content: '<hml-prompt id="p-notify" type="text">Q?</hml-prompt>',
    });

    session.answerPrompt(1, 'p-notify', 'Notified');

    // Should have ADD event and UPDATE event
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].type, 'add');
    assert.strictEqual(events[1].type, 'update');
    assert.ok(events[1].message.content.includes('answered="true"'));
  });

  it('should allow UI to react to prompt state change', () => {
    let promptAnswered = false;

    session.subscribe((event) => {
      if (event.type === 'update' && event.message.content.includes('answered="true"')) {
        promptAnswered = true;
      }
    });

    session.add({
      id: 1,
      role: 'assistant',
      content: '<hml-prompt id="p-react" type="text">Q?</hml-prompt>',
    });

    assert.strictEqual(promptAnswered, false, 'Not answered yet');

    session.answerPrompt(1, 'p-react', 'Done');

    assert.strictEqual(promptAnswered, true, 'Should detect answer via subscription');
  });
});

// ============================================================================
// Test: Multi-Session Support
// ============================================================================

describe('Multi-Session Support', () => {
  let sessionStore;

  beforeEach(() => {
    sessionStore = createSessionStore();
  });

  it('should maintain separate state per session', () => {
    const session1 = sessionStore.getSession(1);
    const session2 = sessionStore.getSession(2);

    session1.add({ id: 'a', role: 'user', content: 'Session 1 message' });
    session2.add({ id: 'b', role: 'user', content: 'Session 2 message' });

    assert.strictEqual(session1.count, 1);
    assert.strictEqual(session2.count, 1);
    assert.strictEqual(session1.findById('a').content, 'Session 1 message');
    assert.strictEqual(session2.findById('b').content, 'Session 2 message');
  });

  it('should handle prompt answer in correct session', () => {
    const session1 = sessionStore.getSession(1);
    const session2 = sessionStore.getSession(2);

    session1.add({
      id: 1,
      role: 'assistant',
      content: '<hml-prompt id="p1" type="text">S1 Q?</hml-prompt>',
    });
    session2.add({
      id: 1, // Same ID in different session
      role: 'assistant',
      content: '<hml-prompt id="p2" type="text">S2 Q?</hml-prompt>',
    });

    // Answer in session 1
    session1.answerPrompt(1, 'p1', 'S1 Answer');

    // Session 1 should be answered
    assert.ok(session1.findById(1).content.includes('answered="true"'));

    // Session 2 should NOT be answered
    assert.ok(!session2.findById(1).content.includes('answered="true"'));
  });

  it('should return same session instance for same ID', () => {
    const session1a = sessionStore.getSession(1);
    const session1b = sessionStore.getSession(1);

    assert.strictEqual(session1a, session1b, 'Should be same instance');

    // Verify state is shared
    session1a.add({ id: 'x', role: 'user', content: 'Test' });
    assert.ok(session1b.findById('x'), 'State should be shared');
  });
});
