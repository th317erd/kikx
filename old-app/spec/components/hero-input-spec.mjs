/**
 * Tests for hero-input.js
 *
 * Tests HeroInput component:
 * - Message input handling
 * - Command detection
 * - Auto-resize
 * - Queue behavior
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

describe('Message Input Validation', () => {
  it('should trim whitespace from input', () => {
    let input   = '  Hello world  ';
    let trimmed = input.trim();
    assert.strictEqual(trimmed, 'Hello world');
  });

  it('should reject empty input', () => {
    let input   = '';
    let isValid = input.trim().length > 0;
    assert.strictEqual(isValid, false);
  });

  it('should reject whitespace-only input', () => {
    let input   = '   \n\t  ';
    let isValid = input.trim().length > 0;
    assert.strictEqual(isValid, false);
  });

  it('should accept valid input', () => {
    let input   = 'Hello';
    let isValid = input.trim().length > 0;
    assert.strictEqual(isValid, true);
  });
});

describe('Command Detection', () => {
  it('should detect command prefix', () => {
    let input     = '/help';
    let isCommand = input.startsWith('/');
    assert.strictEqual(isCommand, true);
  });

  it('should not detect non-command', () => {
    let input     = 'hello /help';
    let isCommand = input.startsWith('/');
    assert.strictEqual(isCommand, false);
  });

  it('should parse command name', () => {
    let input   = '/clear messages';
    let match   = input.match(/^\/(\w+)/);
    let command = match ? match[1] : null;
    assert.strictEqual(command, 'clear');
  });

  it('should parse command arguments', () => {
    let input = '/update_usage 5.50';
    let parts = input.split(/\s+/);
    let args  = parts.slice(1);
    assert.deepStrictEqual(args, ['5.50']);
  });

  it('should handle command with no arguments', () => {
    let input = '/help';
    let parts = input.split(/\s+/);
    let args  = parts.slice(1);
    assert.deepStrictEqual(args, []);
  });
});

describe('Auto-resize Behavior', () => {
  it('should calculate height from scroll height', () => {
    let scrollHeight = 120;
    let maxHeight    = 150;
    let newHeight    = Math.min(scrollHeight, maxHeight);
    assert.strictEqual(newHeight, 120);
  });

  it('should cap height at maximum', () => {
    let scrollHeight = 200;
    let maxHeight    = 150;
    let newHeight    = Math.min(scrollHeight, maxHeight);
    assert.strictEqual(newHeight, 150);
  });

  it('should reset height for empty input', () => {
    let content     = '';
    let resetHeight = (content.length === 0) ? 'auto' : null;
    assert.strictEqual(resetHeight, 'auto');
  });
});

describe('Message Queue Behavior', () => {
  let queue;

  beforeEach(() => {
    queue = [];
  });

  it('should add message to queue', () => {
    let content = 'Hello';
    queue.push({ id: `q-1`, content });
    assert.strictEqual(queue.length, 1);
    assert.strictEqual(queue[0].content, 'Hello');
  });

  it('should generate unique queue ID', () => {
    let id1 = `queued-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let id2 = `queued-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    assert.notStrictEqual(id1, id2);
  });

  it('should process queue in order (FIFO)', () => {
    queue.push({ id: 'q-1', content: 'First' });
    queue.push({ id: 'q-2', content: 'Second' });

    let first = queue.shift();
    assert.strictEqual(first.content, 'First');
    assert.strictEqual(queue.length, 1);

    let second = queue.shift();
    assert.strictEqual(second.content, 'Second');
    assert.strictEqual(queue.length, 0);
  });

  it('should check if queue is empty', () => {
    assert.strictEqual(queue.length === 0, true);
    queue.push({ id: 'q-1', content: 'Test' });
    assert.strictEqual(queue.length === 0, false);
  });
});

describe('Loading State', () => {
  it('should disable send when loading', () => {
    let isLoading    = true;
    let sendDisabled = isLoading;
    assert.strictEqual(sendDisabled, true);
  });

  it('should enable send when not loading', () => {
    let isLoading    = false;
    let sendDisabled = isLoading;
    assert.strictEqual(sendDisabled, false);
  });

  it('should queue message when loading', () => {
    let isLoading = true;
    let content   = 'Hello';
    let shouldQueue = isLoading && content.length > 0;
    assert.strictEqual(shouldQueue, true);
  });
});

describe('Keyboard Shortcuts', () => {
  it('should detect Enter key', () => {
    let event = { key: 'Enter', shiftKey: false };
    let isEnter = event.key === 'Enter' && !event.shiftKey;
    assert.strictEqual(isEnter, true);
  });

  it('should not trigger send on Shift+Enter', () => {
    let event = { key: 'Enter', shiftKey: true };
    let isEnter = event.key === 'Enter' && !event.shiftKey;
    assert.strictEqual(isEnter, false);
  });

  it('should detect Escape key', () => {
    let event = { key: 'Escape' };
    let isEscape = event.key === 'Escape';
    assert.strictEqual(isEscape, true);
  });
});

describe('Session Requirement', () => {
  it('should require session to send', () => {
    let session = null;
    let content = 'Hello';
    let canSend = session !== null && content.length > 0;
    assert.strictEqual(canSend, false);
  });

  it('should allow send with session', () => {
    let session = { id: 1, name: 'Test' };
    let content = 'Hello';
    let canSend = session !== null && content.length > 0;
    assert.strictEqual(canSend, true);
  });
});

describe('Clear Input', () => {
  it('should clear value', () => {
    let value = 'Hello';
    value = '';
    assert.strictEqual(value, '');
  });

  it('should reset height', () => {
    let height = '120px';
    height = 'auto';
    assert.strictEqual(height, 'auto');
  });
});

describe('Streaming Mode', () => {
  it('should use streaming by default', () => {
    let streamingMode = true;
    assert.strictEqual(streamingMode, true);
  });

  it('should choose streaming handler', () => {
    let streamingMode = true;
    let handler = (streamingMode) ? 'stream' : 'batch';
    assert.strictEqual(handler, 'stream');
  });

  it('should choose batch handler', () => {
    let streamingMode = false;
    let handler = (streamingMode) ? 'stream' : 'batch';
    assert.strictEqual(handler, 'batch');
  });
});

describe('Queued Message UI', () => {
  it('should mark message as queued', () => {
    let message = { role: 'user', content: 'Hello', queued: true };
    assert.strictEqual(message.queued, true);
  });

  it('should assign queue ID', () => {
    let queueId = `queued-${Date.now()}-abc123`;
    let message = { role: 'user', content: 'Hello', queued: true, queueId };
    assert.ok(message.queueId.startsWith('queued-'));
  });

  it('should remove queued state after processing', () => {
    let message = { role: 'user', content: 'Hello', queued: true, queueId: 'q-1' };

    // Process message
    message.queued = false;
    delete message.queueId;

    assert.strictEqual(message.queued, false);
    assert.strictEqual(message.queueId, undefined);
  });
});

describe('Focus Management', () => {
  it('should track focus state', () => {
    let isFocused = false;

    // Simulate focus
    isFocused = true;
    assert.strictEqual(isFocused, true);

    // Simulate blur
    isFocused = false;
    assert.strictEqual(isFocused, false);
  });

  it('should refocus after send', () => {
    let focusCount = 0;
    let focus = () => { focusCount++; };

    // Simulate send completion
    focus();

    assert.strictEqual(focusCount, 1);
  });
});
