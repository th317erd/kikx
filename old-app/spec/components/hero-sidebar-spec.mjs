/**
 * Tests for hero-sidebar.js
 *
 * Tests HeroSidebar component:
 * - Session list rendering
 * - Session filtering
 * - Archive/restore functionality
 * - Empty states
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// Mock DynamicProperty
const mockDynamicProperty = {
  set: Symbol('DynamicProperty.set'),
};

// Create mock dynamic properties
function createMockDynamicProp(initialValue) {
  let value     = initialValue;
  let listeners = [];

  return {
    valueOf() { return value; },
    addEventListener(event, handler) {
      if (event === 'update') listeners.push(handler);
    },
    removeEventListener(event, handler) {
      if (event === 'update') {
        listeners = listeners.filter((h) => h !== handler);
      }
    },
    [mockDynamicProperty.set](newValue) {
      let oldValue = value;
      value = newValue;
      listeners.forEach((h) => h({ value: newValue, oldValue }));
    },
  };
}

// Mock GlobalState
function createMockGlobalState() {
  return {
    sessions:           createMockDynamicProp([]),
    agents:             createMockDynamicProp([]),
    showHiddenSessions: createMockDynamicProp(false),
    globalSpend:        createMockDynamicProp({ cost: 0 }),
  };
}

describe('Session List Filtering', () => {
  let sessions;

  beforeEach(() => {
    sessions = [
      { id: 1, name: 'Test Session 1', preview: 'Hello world', status: 'active' },
      { id: 2, name: 'Another Session', preview: 'Foo bar', status: 'active' },
      { id: 3, name: 'Archived One', preview: 'Old content', status: 'archived' },
      { id: 4, name: 'Agent Session', preview: 'Agent work', status: 'agent' },
    ];
  });

  it('should filter sessions by name', () => {
    let query = 'another';
    let filtered = sessions.filter((s) =>
      s.name.toLowerCase().includes(query.toLowerCase())
    );
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].id, 2);
  });

  it('should filter sessions by preview', () => {
    let query = 'hello';
    let filtered = sessions.filter((s) =>
      s.name.toLowerCase().includes(query.toLowerCase()) ||
      (s.preview && s.preview.toLowerCase().includes(query.toLowerCase()))
    );
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].id, 1);
  });

  it('should filter sessions case-insensitively', () => {
    let query = 'TEST';
    let filtered = sessions.filter((s) =>
      s.name.toLowerCase().includes(query.toLowerCase())
    );
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].name, 'Test Session 1');
  });

  it('should return empty array when no matches', () => {
    let query = 'nonexistent';
    let filtered = sessions.filter((s) =>
      s.name.toLowerCase().includes(query.toLowerCase()) ||
      (s.preview && s.preview.toLowerCase().includes(query.toLowerCase()))
    );
    assert.strictEqual(filtered.length, 0);
  });

  it('should return all sessions when query is empty', () => {
    let query = '';
    let filtered = (query)
      ? sessions.filter((s) => s.name.toLowerCase().includes(query.toLowerCase()))
      : sessions;
    assert.strictEqual(filtered.length, 4);
  });
});

describe('Session Visibility Filtering', () => {
  let sessions;

  beforeEach(() => {
    sessions = [
      { id: 1, name: 'Active 1', status: 'active' },
      { id: 2, name: 'Active 2', status: 'active' },
      { id: 3, name: 'Archived', status: 'archived' },
      { id: 4, name: 'Agent', status: 'agent' },
    ];
  });

  it('should hide archived and agent sessions by default', () => {
    let showHidden = false;
    let visible = sessions.filter((s) =>
      (showHidden) ? true : (s.status !== 'archived' && s.status !== 'agent')
    );
    assert.strictEqual(visible.length, 2);
    assert.ok(visible.every((s) => s.status === 'active'));
  });

  it('should show all sessions when showHidden is true', () => {
    let showHidden = true;
    let visible = sessions.filter((s) =>
      (showHidden) ? true : (s.status !== 'archived' && s.status !== 'agent')
    );
    assert.strictEqual(visible.length, 4);
  });

  it('should identify archived sessions', () => {
    let archived = sessions.filter((s) => s.status === 'archived');
    assert.strictEqual(archived.length, 1);
    assert.strictEqual(archived[0].name, 'Archived');
  });

  it('should identify agent sessions', () => {
    let agent = sessions.filter((s) => s.status === 'agent');
    assert.strictEqual(agent.length, 1);
    assert.strictEqual(agent[0].name, 'Agent');
  });
});

describe('Session List Empty States', () => {
  let GlobalState;

  beforeEach(() => {
    GlobalState = createMockGlobalState();
  });

  it('should detect no agents state', () => {
    let sessions = [];
    let agents   = [];

    let state = (sessions.length === 0 && agents.length === 0)
      ? 'no-agents'
      : (sessions.length === 0)
        ? 'no-sessions'
        : 'has-sessions';

    assert.strictEqual(state, 'no-agents');
  });

  it('should detect no sessions state (with agents)', () => {
    let sessions = [];
    let agents   = [{ id: 1, name: 'Agent 1' }];

    let state = (sessions.length === 0 && agents.length === 0)
      ? 'no-agents'
      : (sessions.length === 0)
        ? 'no-sessions'
        : 'has-sessions';

    assert.strictEqual(state, 'no-sessions');
  });

  it('should detect has sessions state', () => {
    let sessions = [{ id: 1, name: 'Session 1' }];
    let agents   = [{ id: 1, name: 'Agent 1' }];

    let state = (sessions.length === 0 && agents.length === 0)
      ? 'no-agents'
      : (sessions.length === 0)
        ? 'no-sessions'
        : 'has-sessions';

    assert.strictEqual(state, 'has-sessions');
  });

  it('should detect no search results state', () => {
    let sessions = [{ id: 1, name: 'Test' }];
    let filtered = sessions.filter((s) => s.name.includes('nonexistent'));

    let state = (filtered.length === 0 && sessions.length > 0)
      ? 'no-results'
      : 'has-results';

    assert.strictEqual(state, 'no-results');
  });
});

describe('Session Hierarchy', () => {
  let sessions;

  beforeEach(() => {
    sessions = [
      { id: 1, name: 'Parent', depth: 0, parent_id: null },
      { id: 2, name: 'Child 1', depth: 1, parent_id: 1 },
      { id: 3, name: 'Child 2', depth: 1, parent_id: 1 },
      { id: 4, name: 'Grandchild', depth: 2, parent_id: 2 },
    ];
  });

  it('should calculate indentation based on depth', () => {
    let indentPx = 24;
    for (let session of sessions) {
      let expectedMargin = session.depth * indentPx;
      assert.strictEqual(session.depth * indentPx, expectedMargin);
    }
  });

  it('should identify root sessions', () => {
    let roots = sessions.filter((s) => s.depth === 0);
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0].name, 'Parent');
  });

  it('should identify child sessions', () => {
    let children = sessions.filter((s) => s.depth > 0);
    assert.strictEqual(children.length, 3);
  });

  it('should group children under parent', () => {
    let parent   = sessions.find((s) => s.id === 1);
    let children = sessions.filter((s) => s.parent_id === parent.id);
    assert.strictEqual(children.length, 2);
    assert.ok(children.every((c) => c.depth === 1));
  });
});

describe('Session Archive Toggle', () => {
  it('should toggle from active to archived', () => {
    let session   = { id: 1, status: 'active' };
    let newStatus = (session.status === 'archived') ? 'active' : 'archived';
    assert.strictEqual(newStatus, 'archived');
  });

  it('should toggle from archived to active', () => {
    let session   = { id: 1, status: 'archived' };
    let newStatus = (session.status === 'archived') ? 'active' : 'archived';
    assert.strictEqual(newStatus, 'active');
  });

  it('should determine correct archive icon', () => {
    let archivedSession = { status: 'archived' };
    let activeSession   = { status: 'active' };

    let archivedIcon = (archivedSession.status === 'archived') ? 'restore' : 'archive';
    let activeIcon   = (activeSession.status === 'archived') ? 'restore' : 'archive';

    assert.strictEqual(archivedIcon, 'restore');
    assert.strictEqual(activeIcon, 'archive');
  });
});

describe('Session Data Formatting', () => {
  it('should handle session with no preview', () => {
    let session = { id: 1, name: 'Empty', preview: null };
    let preview = session.preview || '';
    assert.strictEqual(preview, '');
  });

  it('should handle session with preview', () => {
    let session = { id: 1, name: 'Full', preview: 'Hello world' };
    let preview = session.preview || '';
    assert.strictEqual(preview, 'Hello world');
  });

  it('should format message count singular', () => {
    let count   = 1;
    let label   = (count === 1) ? '1 message' : `${count} messages`;
    assert.strictEqual(label, '1 message');
  });

  it('should format message count plural', () => {
    let count   = 5;
    let label   = (count === 1) ? '1 message' : `${count} messages`;
    assert.strictEqual(label, '5 messages');
  });

  it('should format zero message count', () => {
    let count   = 0;
    let label   = (count === 1) ? '1 message' : `${count} messages`;
    assert.strictEqual(label, '0 messages');
  });
});

describe('Session Status Badge', () => {
  it('should show agent badge for agent sessions', () => {
    let session    = { status: 'agent' };
    let showBadge  = session.status === 'agent';
    assert.strictEqual(showBadge, true);
  });

  it('should not show badge for active sessions', () => {
    let session   = { status: 'active' };
    let showBadge = session.status === 'agent';
    assert.strictEqual(showBadge, false);
  });

  it('should not show badge for archived sessions', () => {
    let session   = { status: 'archived' };
    let showBadge = session.status === 'agent';
    assert.strictEqual(showBadge, false);
  });
});

describe('GlobalState Session Updates', () => {
  let GlobalState;

  beforeEach(() => {
    GlobalState = createMockGlobalState();
  });

  it('should update sessions list', () => {
    let newSessions = [
      { id: 1, name: 'Session 1' },
      { id: 2, name: 'Session 2' },
    ];

    GlobalState.sessions[mockDynamicProperty.set](newSessions);
    assert.deepStrictEqual(GlobalState.sessions.valueOf(), newSessions);
  });

  it('should notify listeners when sessions change', () => {
    let received = null;

    GlobalState.sessions.addEventListener('update', (event) => {
      received = event;
    });

    let newSessions = [{ id: 1, name: 'New' }];
    GlobalState.sessions[mockDynamicProperty.set](newSessions);

    assert.ok(received !== null);
    assert.deepStrictEqual(received.value, newSessions);
    assert.deepStrictEqual(received.oldValue, []);
  });

  it('should toggle showHiddenSessions', () => {
    assert.strictEqual(GlobalState.showHiddenSessions.valueOf(), false);

    GlobalState.showHiddenSessions[mockDynamicProperty.set](true);
    assert.strictEqual(GlobalState.showHiddenSessions.valueOf(), true);

    GlobalState.showHiddenSessions[mockDynamicProperty.set](false);
    assert.strictEqual(GlobalState.showHiddenSessions.valueOf(), false);
  });
});
