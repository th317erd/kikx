'use strict';

// ============================================================================
// Sessions Module Tests
// ============================================================================
// Tests for public/js/sessions.js filtering and rendering logic

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDOM, destroyDOM, getDocument, getWindow } from '../helpers/dom-helpers.mjs';

// ============================================================================
// Test Setup - Session filtering logic
// ============================================================================

function filterSessions(sessions, searchQuery) {
  if (!searchQuery) return sessions;

  let query = searchQuery.toLowerCase();
  return sessions.filter((s) =>
    s.name.toLowerCase().includes(query) ||
    (s.preview && s.preview.toLowerCase().includes(query))
  );
}

function getSessionStatusClass(session) {
  if (session.status === 'archived') return 'archived';
  if (session.status === 'agent') return 'agent-session';
  return '';
}

function getSessionDepthStyle(depth) {
  return (depth > 0) ? `margin-left: ${depth * 24}px` : '';
}

function formatMessageCount(count) {
  return (count === 1) ? '1 message' : `${count} messages`;
}

function getArchiveButtonProps(isArchived) {
  return {
    icon: isArchived ? '♻️' : '🗑️',
    title: isArchived ? 'Restore session' : 'Archive session',
  };
}

// ============================================================================
// Tests: Session Filtering
// ============================================================================

describe('Session Filtering', () => {
  const mockSessions = [
    { id: 1, name: 'Chat about JavaScript', preview: 'Let me help with JS' },
    { id: 2, name: 'Python tutorial', preview: 'Learning Python basics' },
    { id: 3, name: 'General Questions', preview: 'Various topics discussed' },
    { id: 4, name: 'Empty session', preview: null },
  ];

  it('should return all sessions when no query', () => {
    const result = filterSessions(mockSessions, '');
    assert.strictEqual(result.length, 4);
  });

  it('should return all sessions when query is null', () => {
    const result = filterSessions(mockSessions, null);
    assert.strictEqual(result.length, 4);
  });

  it('should filter by session name', () => {
    const result = filterSessions(mockSessions, 'javascript');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'Chat about JavaScript');
  });

  it('should filter by preview content', () => {
    const result = filterSessions(mockSessions, 'python');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'Python tutorial');
  });

  it('should be case insensitive', () => {
    const result = filterSessions(mockSessions, 'JAVASCRIPT');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'Chat about JavaScript');
  });

  it('should match partial strings', () => {
    const result = filterSessions(mockSessions, 'chat');
    assert.strictEqual(result.length, 1);
  });

  it('should return multiple matches', () => {
    const result = filterSessions(mockSessions, 'a'); // Matches 'Chat about JavaScript', 'Python tutorial' (both have 'a')
    assert.ok(result.length > 1, `Expected multiple matches, got ${result.length}`);
  });

  it('should handle sessions with null preview', () => {
    const result = filterSessions(mockSessions, 'empty');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'Empty session');
  });

  it('should return empty array when no matches', () => {
    const result = filterSessions(mockSessions, 'xyz123');
    assert.strictEqual(result.length, 0);
  });

  it('should handle empty sessions array', () => {
    const result = filterSessions([], 'test');
    assert.strictEqual(result.length, 0);
  });
});

// ============================================================================
// Tests: Session Status Classes
// ============================================================================

describe('Session Status Classes', () => {
  it('should return "archived" for archived sessions', () => {
    const session = { status: 'archived' };
    assert.strictEqual(getSessionStatusClass(session), 'archived');
  });

  it('should return "agent-session" for agent sessions', () => {
    const session = { status: 'agent' };
    assert.strictEqual(getSessionStatusClass(session), 'agent-session');
  });

  it('should return empty string for normal sessions', () => {
    const session = { status: 'active' };
    assert.strictEqual(getSessionStatusClass(session), '');
  });

  it('should return empty string for undefined status', () => {
    const session = {};
    assert.strictEqual(getSessionStatusClass(session), '');
  });
});

// ============================================================================
// Tests: Session Depth Styling
// ============================================================================

describe('Session Depth Styling', () => {
  it('should return empty string for depth 0', () => {
    assert.strictEqual(getSessionDepthStyle(0), '');
  });

  it('should calculate margin for depth 1', () => {
    assert.strictEqual(getSessionDepthStyle(1), 'margin-left: 24px');
  });

  it('should calculate margin for depth 2', () => {
    assert.strictEqual(getSessionDepthStyle(2), 'margin-left: 48px');
  });

  it('should calculate margin for depth 3', () => {
    assert.strictEqual(getSessionDepthStyle(3), 'margin-left: 72px');
  });
});

// ============================================================================
// Tests: Message Count Formatting
// ============================================================================

describe('Message Count Formatting', () => {
  it('should format 0 messages', () => {
    assert.strictEqual(formatMessageCount(0), '0 messages');
  });

  it('should format 1 message (singular)', () => {
    assert.strictEqual(formatMessageCount(1), '1 message');
  });

  it('should format 2 messages (plural)', () => {
    assert.strictEqual(formatMessageCount(2), '2 messages');
  });

  it('should format large counts', () => {
    assert.strictEqual(formatMessageCount(100), '100 messages');
    assert.strictEqual(formatMessageCount(1000), '1000 messages');
  });
});

// ============================================================================
// Tests: Archive Button Props
// ============================================================================

describe('Archive Button Props', () => {
  it('should return restore props for archived session', () => {
    const props = getArchiveButtonProps(true);
    assert.strictEqual(props.icon, '♻️');
    assert.strictEqual(props.title, 'Restore session');
  });

  it('should return archive props for non-archived session', () => {
    const props = getArchiveButtonProps(false);
    assert.strictEqual(props.icon, '🗑️');
    assert.strictEqual(props.title, 'Archive session');
  });
});

// ============================================================================
// Tests: Session List Rendering States
// ============================================================================

describe('Session List Rendering States', () => {
  function determineEmptyState(sessions, agents, searchQuery) {
    if (sessions.length === 0 && agents.length === 0) {
      return 'no-agents';
    } else if (sessions.length === 0) {
      return 'no-sessions';
    } else if (searchQuery && filterSessions(sessions, searchQuery).length === 0) {
      return 'no-matches';
    }
    return 'has-sessions';
  }

  it('should detect no-agents state', () => {
    const state = determineEmptyState([], [], '');
    assert.strictEqual(state, 'no-agents');
  });

  it('should detect no-sessions state', () => {
    const agents = [{ id: 1, name: 'Agent' }];
    const state = determineEmptyState([], agents, '');
    assert.strictEqual(state, 'no-sessions');
  });

  it('should detect no-matches state', () => {
    const sessions = [{ id: 1, name: 'Test', preview: 'test' }];
    const agents = [{ id: 1, name: 'Agent' }];
    const state = determineEmptyState(sessions, agents, 'xyz');
    assert.strictEqual(state, 'no-matches');
  });

  it('should detect has-sessions state', () => {
    const sessions = [{ id: 1, name: 'Test', preview: 'test' }];
    const agents = [{ id: 1, name: 'Agent' }];
    const state = determineEmptyState(sessions, agents, '');
    assert.strictEqual(state, 'has-sessions');
  });

  it('should detect has-sessions when search matches', () => {
    const sessions = [{ id: 1, name: 'Test', preview: 'test' }];
    const agents = [{ id: 1, name: 'Agent' }];
    const state = determineEmptyState(sessions, agents, 'test');
    assert.strictEqual(state, 'has-sessions');
  });
});

// ============================================================================
// Tests: Session Row Data
// ============================================================================

describe('Session Row Data', () => {
  function buildSessionRowData(session) {
    const isArchived = session.status === 'archived';
    return {
      id: session.id,
      name: session.name,
      preview: session.preview || '',
      messageLabel: formatMessageCount(session.messageCount || 0),
      statusClass: getSessionStatusClass(session),
      childClass: session.depth > 0 ? 'child-session' : '',
      depthStyle: getSessionDepthStyle(session.depth || 0),
      archiveIcon: isArchived ? '♻️' : '🗑️',
      archiveTitle: isArchived ? 'Restore session' : 'Archive session',
      showAgentBadge: session.status === 'agent',
    };
  }

  it('should build data for normal session', () => {
    const session = {
      id: 1,
      name: 'My Session',
      preview: 'Hello world',
      messageCount: 5,
      status: 'active',
      depth: 0,
    };

    const data = buildSessionRowData(session);

    assert.strictEqual(data.id, 1);
    assert.strictEqual(data.name, 'My Session');
    assert.strictEqual(data.preview, 'Hello world');
    assert.strictEqual(data.messageLabel, '5 messages');
    assert.strictEqual(data.statusClass, '');
    assert.strictEqual(data.childClass, '');
    assert.strictEqual(data.depthStyle, '');
    assert.strictEqual(data.archiveIcon, '🗑️');
    assert.strictEqual(data.showAgentBadge, false);
  });

  it('should build data for archived session', () => {
    const session = {
      id: 2,
      name: 'Archived Session',
      status: 'archived',
      messageCount: 10,
      depth: 0,
    };

    const data = buildSessionRowData(session);

    assert.strictEqual(data.statusClass, 'archived');
    assert.strictEqual(data.archiveIcon, '♻️');
    assert.strictEqual(data.archiveTitle, 'Restore session');
  });

  it('should build data for agent session', () => {
    const session = {
      id: 3,
      name: 'Agent Session',
      status: 'agent',
      messageCount: 0,
      depth: 0,
    };

    const data = buildSessionRowData(session);

    assert.strictEqual(data.statusClass, 'agent-session');
    assert.strictEqual(data.showAgentBadge, true);
  });

  it('should build data for child session', () => {
    const session = {
      id: 4,
      name: 'Child Session',
      status: 'active',
      depth: 2,
    };

    const data = buildSessionRowData(session);

    assert.strictEqual(data.childClass, 'child-session');
    assert.strictEqual(data.depthStyle, 'margin-left: 48px');
  });

  it('should handle missing preview', () => {
    const session = {
      id: 5,
      name: 'No Preview',
      preview: null,
    };

    const data = buildSessionRowData(session);

    assert.strictEqual(data.preview, '');
  });

  it('should handle missing messageCount', () => {
    const session = {
      id: 6,
      name: 'No Count',
    };

    const data = buildSessionRowData(session);

    assert.strictEqual(data.messageLabel, '0 messages');
  });
});
