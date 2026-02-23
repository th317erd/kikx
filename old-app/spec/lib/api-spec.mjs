'use strict';

// ============================================================================
// API Module Tests
// ============================================================================
// Tests for public/js/api.js pure functions

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ============================================================================
// framesToMessages Implementation (copied from api.js for testing)
// ============================================================================

function framesToMessages(frames, compiled = null) {
  let messages = [];

  for (let frame of frames) {
    let payload = (compiled && compiled[frame.id]) ? compiled[frame.id] : frame.payload;

    if (frame.type === 'message') {
      messages.push({
        id:         frame.id,
        role:       payload.role || (frame.authorType === 'user' ? 'user' : 'assistant'),
        content:    payload.content || '',
        hidden:     payload.hidden || false,
        type:       frame.type,
        authorType: frame.authorType,
        timestamp:  frame.timestamp,
        frameId:    frame.id,
      });
    } else if (frame.type === 'request') {
      messages.push({
        id:         frame.id,
        role:       'assistant',
        content:    '',
        hidden:     false,
        type:       'request',
        action:     payload.action,
        data:       payload,
        authorType: frame.authorType,
        timestamp:  frame.timestamp,
        frameId:    frame.id,
        parentId:   frame.parentId,
      });
    } else if (frame.type === 'result') {
      messages.push({
        id:         frame.id,
        role:       'system',
        content:    '',
        hidden:     false,
        type:       'result',
        result:     payload,
        authorType: frame.authorType,
        timestamp:  frame.timestamp,
        frameId:    frame.id,
        parentId:   frame.parentId,
      });
    } else if (frame.type === 'compact') {
      messages.push({
        id:         frame.id,
        role:       'system',
        content:    payload.context || '[Compacted context]',
        hidden:     true,
        type:       'compact',
        authorType: frame.authorType,
        timestamp:  frame.timestamp,
        frameId:    frame.id,
      });
    }
  }

  return messages;
}

// ============================================================================
// Tests: framesToMessages
// ============================================================================

describe('framesToMessages', () => {
  describe('Message Frames', () => {
    it('should convert user message frame', () => {
      const frames = [{
        id: 'frame-1',
        type: 'message',
        authorType: 'user',
        timestamp: '2024-01-15T12:00:00Z',
        payload: {
          role: 'user',
          content: 'Hello, AI!',
        },
      }];

      const messages = framesToMessages(frames);

      assert.strictEqual(messages.length, 1);
      assert.strictEqual(messages[0].id, 'frame-1');
      assert.strictEqual(messages[0].role, 'user');
      assert.strictEqual(messages[0].content, 'Hello, AI!');
      assert.strictEqual(messages[0].type, 'message');
      assert.strictEqual(messages[0].frameId, 'frame-1');
    });

    it('should convert assistant message frame', () => {
      const frames = [{
        id: 'frame-2',
        type: 'message',
        authorType: 'assistant',
        timestamp: '2024-01-15T12:01:00Z',
        payload: {
          role: 'assistant',
          content: 'Hello! How can I help?',
        },
      }];

      const messages = framesToMessages(frames);

      assert.strictEqual(messages.length, 1);
      assert.strictEqual(messages[0].role, 'assistant');
      assert.strictEqual(messages[0].content, 'Hello! How can I help?');
    });

    it('should default role based on authorType when not specified', () => {
      const frames = [{
        id: 'frame-3',
        type: 'message',
        authorType: 'user',
        timestamp: '2024-01-15T12:00:00Z',
        payload: {
          content: 'No role specified',
        },
      }];

      const messages = framesToMessages(frames);

      assert.strictEqual(messages[0].role, 'user');
    });

    it('should handle hidden messages', () => {
      const frames = [{
        id: 'frame-4',
        type: 'message',
        authorType: 'assistant',
        timestamp: '2024-01-15T12:00:00Z',
        payload: {
          content: 'Hidden message',
          hidden: true,
        },
      }];

      const messages = framesToMessages(frames);

      assert.strictEqual(messages[0].hidden, true);
    });

    it('should default hidden to false', () => {
      const frames = [{
        id: 'frame-5',
        type: 'message',
        authorType: 'user',
        timestamp: '2024-01-15T12:00:00Z',
        payload: {
          content: 'Normal message',
        },
      }];

      const messages = framesToMessages(frames);

      assert.strictEqual(messages[0].hidden, false);
    });
  });

  describe('Request Frames', () => {
    it('should convert request frame', () => {
      const frames = [{
        id: 'frame-req-1',
        type: 'request',
        authorType: 'assistant',
        parentId: 'frame-1',
        timestamp: '2024-01-15T12:00:00Z',
        payload: {
          action: 'websearch',
          query: 'test query',
        },
      }];

      const messages = framesToMessages(frames);

      assert.strictEqual(messages.length, 1);
      assert.strictEqual(messages[0].type, 'request');
      assert.strictEqual(messages[0].role, 'assistant');
      assert.strictEqual(messages[0].action, 'websearch');
      assert.strictEqual(messages[0].data.query, 'test query');
      assert.strictEqual(messages[0].parentId, 'frame-1');
    });
  });

  describe('Result Frames', () => {
    it('should convert result frame', () => {
      const frames = [{
        id: 'frame-res-1',
        type: 'result',
        authorType: 'system',
        parentId: 'frame-req-1',
        timestamp: '2024-01-15T12:00:01Z',
        payload: {
          success: true,
          data: [{ title: 'Result 1' }],
        },
      }];

      const messages = framesToMessages(frames);

      assert.strictEqual(messages.length, 1);
      assert.strictEqual(messages[0].type, 'result');
      assert.strictEqual(messages[0].role, 'system');
      assert.strictEqual(messages[0].result.success, true);
      assert.strictEqual(messages[0].parentId, 'frame-req-1');
    });
  });

  describe('Compact Frames', () => {
    it('should convert compact frame with context', () => {
      const frames = [{
        id: 'frame-compact-1',
        type: 'compact',
        authorType: 'system',
        timestamp: '2024-01-15T12:00:00Z',
        payload: {
          context: 'Compacted conversation summary...',
        },
      }];

      const messages = framesToMessages(frames);

      assert.strictEqual(messages.length, 1);
      assert.strictEqual(messages[0].type, 'compact');
      assert.strictEqual(messages[0].role, 'system');
      assert.strictEqual(messages[0].content, 'Compacted conversation summary...');
      assert.strictEqual(messages[0].hidden, true);
    });

    it('should use default text when context is missing', () => {
      const frames = [{
        id: 'frame-compact-2',
        type: 'compact',
        authorType: 'system',
        timestamp: '2024-01-15T12:00:00Z',
        payload: {},
      }];

      const messages = framesToMessages(frames);

      assert.strictEqual(messages[0].content, '[Compacted context]');
    });
  });

  describe('UPDATE Frames', () => {
    it('should not create messages for UPDATE frames', () => {
      const frames = [{
        id: 'frame-update-1',
        type: 'update',
        authorType: 'system',
        timestamp: '2024-01-15T12:00:00Z',
        payload: {
          targetId: 'frame-1',
          changes: { content: 'Updated content' },
        },
      }];

      const messages = framesToMessages(frames);

      assert.strictEqual(messages.length, 0);
    });
  });

  describe('Compiled Payloads', () => {
    it('should use compiled payload when available', () => {
      const frames = [{
        id: 'frame-1',
        type: 'message',
        authorType: 'user',
        timestamp: '2024-01-15T12:00:00Z',
        payload: {
          content: 'Original content',
        },
      }];

      const compiled = {
        'frame-1': {
          content: 'Updated content after edit',
        },
      };

      const messages = framesToMessages(frames, compiled);

      assert.strictEqual(messages[0].content, 'Updated content after edit');
    });

    it('should fall back to frame payload when not compiled', () => {
      const frames = [{
        id: 'frame-1',
        type: 'message',
        authorType: 'user',
        timestamp: '2024-01-15T12:00:00Z',
        payload: {
          content: 'Original content',
        },
      }];

      const compiled = {
        'other-frame': {
          content: 'Different frame',
        },
      };

      const messages = framesToMessages(frames, compiled);

      assert.strictEqual(messages[0].content, 'Original content');
    });
  });

  describe('Multiple Frames', () => {
    it('should convert multiple frames in order', () => {
      const frames = [
        {
          id: 'frame-1',
          type: 'message',
          authorType: 'user',
          timestamp: '2024-01-15T12:00:00Z',
          payload: { content: 'Question' },
        },
        {
          id: 'frame-2',
          type: 'message',
          authorType: 'assistant',
          timestamp: '2024-01-15T12:00:01Z',
          payload: { content: 'Answer' },
        },
      ];

      const messages = framesToMessages(frames);

      assert.strictEqual(messages.length, 2);
      assert.strictEqual(messages[0].content, 'Question');
      assert.strictEqual(messages[1].content, 'Answer');
    });

    it('should handle mixed frame types', () => {
      const frames = [
        {
          id: 'msg-1',
          type: 'message',
          authorType: 'user',
          timestamp: '2024-01-15T12:00:00Z',
          payload: { content: 'Search for something' },
        },
        {
          id: 'req-1',
          type: 'request',
          authorType: 'assistant',
          parentId: 'msg-1',
          timestamp: '2024-01-15T12:00:01Z',
          payload: { action: 'search', query: 'something' },
        },
        {
          id: 'res-1',
          type: 'result',
          authorType: 'system',
          parentId: 'req-1',
          timestamp: '2024-01-15T12:00:02Z',
          payload: { found: true },
        },
        {
          id: 'msg-2',
          type: 'message',
          authorType: 'assistant',
          timestamp: '2024-01-15T12:00:03Z',
          payload: { content: 'I found it!' },
        },
      ];

      const messages = framesToMessages(frames);

      assert.strictEqual(messages.length, 4);
      assert.strictEqual(messages[0].type, 'message');
      assert.strictEqual(messages[1].type, 'request');
      assert.strictEqual(messages[2].type, 'result');
      assert.strictEqual(messages[3].type, 'message');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty frames array', () => {
      const messages = framesToMessages([]);
      assert.strictEqual(messages.length, 0);
    });

    it('should handle empty payload', () => {
      const frames = [{
        id: 'frame-1',
        type: 'message',
        authorType: 'user',
        timestamp: '2024-01-15T12:00:00Z',
        payload: {},
      }];

      const messages = framesToMessages(frames);

      assert.strictEqual(messages[0].content, '');
      assert.strictEqual(messages[0].hidden, false);
    });

    it('should handle unknown frame types gracefully', () => {
      const frames = [{
        id: 'frame-unknown',
        type: 'custom_type',
        authorType: 'system',
        timestamp: '2024-01-15T12:00:00Z',
        payload: { data: 'test' },
      }];

      const messages = framesToMessages(frames);

      // Unknown types should be skipped
      assert.strictEqual(messages.length, 0);
    });
  });
});

// ============================================================================
// Tests: URL Building Helpers
// ============================================================================

describe('API URL Building', () => {
  // Helper to build query strings like the API does
  function buildQueryString(options) {
    let params = new URLSearchParams();
    if (options.showHidden) params.append('showHidden', '1');
    if (options.search) params.append('search', options.search);
    if (options.fromTimestamp) params.append('fromTimestamp', options.fromTimestamp);
    if (options.fromCompact) params.append('fromCompact', '1');
    if (options.types) params.append('types', options.types.join(','));
    if (options.limit) params.append('limit', String(options.limit));
    return params.toString();
  }

  it('should build empty query string for no options', () => {
    const query = buildQueryString({});
    assert.strictEqual(query, '');
  });

  it('should build showHidden query', () => {
    const query = buildQueryString({ showHidden: true });
    assert.strictEqual(query, 'showHidden=1');
  });

  it('should build search query', () => {
    const query = buildQueryString({ search: 'test search' });
    assert.strictEqual(query, 'search=test+search');
  });

  it('should build combined query', () => {
    const query = buildQueryString({ showHidden: true, search: 'test' });
    assert.ok(query.includes('showHidden=1'));
    assert.ok(query.includes('search=test'));
  });

  it('should build frame query with types', () => {
    const query = buildQueryString({ types: ['message', 'request'] });
    assert.strictEqual(query, 'types=message%2Crequest');
  });

  it('should build frame query with limit', () => {
    const query = buildQueryString({ limit: 50 });
    assert.strictEqual(query, 'limit=50');
  });

  it('should build frame query with fromTimestamp', () => {
    const query = buildQueryString({ fromTimestamp: '2024-01-15T12:00:00Z' });
    assert.ok(query.includes('fromTimestamp='));
  });

  it('should build frame query with fromCompact', () => {
    const query = buildQueryString({ fromCompact: true });
    assert.strictEqual(query, 'fromCompact=1');
  });
});

// ============================================================================
// Tests: Ability Filtering
// ============================================================================

describe('Ability Filtering', () => {
  function filterAbilities(abilities) {
    let system = abilities.filter((a) => a.source === 'system' || a.source === 'builtin');
    let user = abilities.filter((a) => a.source === 'user');
    return { system, user, all: abilities };
  }

  it('should separate system abilities', () => {
    const abilities = [
      { id: 1, name: 'Websearch', source: 'system' },
      { id: 2, name: 'Calculator', source: 'builtin' },
      { id: 3, name: 'Custom', source: 'user' },
    ];

    const result = filterAbilities(abilities);

    assert.strictEqual(result.system.length, 2);
    assert.strictEqual(result.user.length, 1);
    assert.strictEqual(result.all.length, 3);
  });

  it('should handle empty abilities', () => {
    const result = filterAbilities([]);

    assert.strictEqual(result.system.length, 0);
    assert.strictEqual(result.user.length, 0);
    assert.strictEqual(result.all.length, 0);
  });

  it('should handle only user abilities', () => {
    const abilities = [
      { id: 1, name: 'Custom1', source: 'user' },
      { id: 2, name: 'Custom2', source: 'user' },
    ];

    const result = filterAbilities(abilities);

    assert.strictEqual(result.system.length, 0);
    assert.strictEqual(result.user.length, 2);
  });

  it('should handle only system abilities', () => {
    const abilities = [
      { id: 1, name: 'Builtin1', source: 'builtin' },
      { id: 2, name: 'System1', source: 'system' },
    ];

    const result = filterAbilities(abilities);

    assert.strictEqual(result.system.length, 2);
    assert.strictEqual(result.user.length, 0);
  });
});
