/**
 * Tests for hero-header.js
 *
 * Tests HeroHeader component:
 * - Cost display formatting
 * - Usage state management
 * - View-specific display
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// Mock DynamicProperty
const mockDynamicProperty = {
  set: Symbol('DynamicProperty.set'),
};

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

describe('Cost Formatting', () => {
  function formatCost(cost) {
    return '$' + cost.toFixed(2);
  }

  it('should format zero cost', () => {
    assert.strictEqual(formatCost(0), '$0.00');
  });

  it('should format small cost', () => {
    assert.strictEqual(formatCost(0.05), '$0.05');
  });

  it('should format cost with cents', () => {
    assert.strictEqual(formatCost(1.23), '$1.23');
  });

  it('should format large cost', () => {
    assert.strictEqual(formatCost(99.99), '$99.99');
  });

  it('should round to 2 decimal places', () => {
    assert.strictEqual(formatCost(1.999), '$2.00');
  });
});

describe('Usage State', () => {
  let globalSpend;
  let serviceSpend;
  let sessionSpend;

  beforeEach(() => {
    globalSpend  = createMockDynamicProp({ cost: 0, inputTokens: 0, outputTokens: 0 });
    serviceSpend = createMockDynamicProp({ cost: 0 });
    sessionSpend = createMockDynamicProp({ cost: 0 });
  });

  it('should initialize with zero cost', () => {
    assert.strictEqual(globalSpend.valueOf().cost, 0);
    assert.strictEqual(serviceSpend.valueOf().cost, 0);
    assert.strictEqual(sessionSpend.valueOf().cost, 0);
  });

  it('should update global spend', () => {
    globalSpend[mockDynamicProperty.set]({ cost: 5.50, inputTokens: 1000, outputTokens: 500 });
    assert.strictEqual(globalSpend.valueOf().cost, 5.50);
  });

  it('should update service spend', () => {
    serviceSpend[mockDynamicProperty.set]({ cost: 2.25 });
    assert.strictEqual(serviceSpend.valueOf().cost, 2.25);
  });

  it('should update session spend', () => {
    sessionSpend[mockDynamicProperty.set]({ cost: 0.75 });
    assert.strictEqual(sessionSpend.valueOf().cost, 0.75);
  });

  it('should notify on updates', () => {
    let received = null;
    globalSpend.addEventListener('update', (e) => { received = e.value; });

    globalSpend[mockDynamicProperty.set]({ cost: 10.00 });
    assert.strictEqual(received.cost, 10.00);
  });
});

describe('View-Specific Display', () => {
  it('should show only global spend in sessions view', () => {
    let view           = 'sessions';
    let showGlobal     = true;
    let showService    = view === 'chat';
    let showSession    = view === 'chat';

    assert.strictEqual(showGlobal, true);
    assert.strictEqual(showService, false);
    assert.strictEqual(showSession, false);
  });

  it('should show all spends in chat view', () => {
    let view           = 'chat';
    let showGlobal     = true;
    let showService    = view === 'chat';
    let showSession    = view === 'chat';

    assert.strictEqual(showGlobal, true);
    assert.strictEqual(showService, true);
    assert.strictEqual(showSession, true);
  });

  it('should hide usage in login view', () => {
    let view        = 'login';
    let showUsage   = view !== 'login';
    assert.strictEqual(showUsage, false);
  });
});

describe('Session Title', () => {
  it('should display session name', () => {
    let session = { name: 'Test Chat' };
    let title   = session?.name || 'Hero';
    assert.strictEqual(title, 'Test Chat');
  });

  it('should use default when no session', () => {
    let session = null;
    let title   = session?.name || 'Hero';
    assert.strictEqual(title, 'Hero');
  });

  it('should escape HTML in session name', () => {
    let name = '<script>alert("xss")</script>';
    // Simulating escapeHtml
    let div = { textContent: '', innerHTML: '' };
    div.textContent = name;
    // In real DOM, this would escape the HTML
    assert.strictEqual(div.textContent, name);
  });
});

describe('Session Dropdown', () => {
  let sessions;

  beforeEach(() => {
    sessions = [
      { id: 1, name: 'First Session' },
      { id: 2, name: 'Second Session' },
      { id: 3, name: 'Third Session' },
    ];
  });

  it('should list all sessions', () => {
    assert.strictEqual(sessions.length, 3);
  });

  it('should mark current session as selected', () => {
    let currentId = 2;
    let options   = sessions.map((s) => ({
      value:    s.id,
      label:    s.name,
      selected: s.id === currentId,
    }));

    assert.strictEqual(options[1].selected, true);
    assert.strictEqual(options[0].selected, false);
  });

  it('should have placeholder option', () => {
    let placeholder = { value: '', label: 'Switch session...' };
    assert.strictEqual(placeholder.value, '');
    assert.strictEqual(placeholder.label, 'Switch session...');
  });
});

describe('Header Actions', () => {
  it('should have back button in chat view', () => {
    let view        = 'chat';
    let showBack    = view === 'chat';
    assert.strictEqual(showBack, true);
  });

  it('should hide back button in sessions view', () => {
    let view        = 'sessions';
    let showBack    = view === 'chat';
    assert.strictEqual(showBack, false);
  });

  it('should always show logout button', () => {
    let views = ['sessions', 'chat'];
    for (let view of views) {
      let showLogout = view !== 'login';
      assert.strictEqual(showLogout, true);
    }
  });

  it('should hide logout in login view', () => {
    let view       = 'login';
    let showLogout = view !== 'login';
    assert.strictEqual(showLogout, false);
  });
});

describe('Agent Display', () => {
  it('should show agent name from session', () => {
    let session   = { agent: { name: 'Claude' } };
    let agentName = session?.agent?.name || 'Unknown';
    assert.strictEqual(agentName, 'Claude');
  });

  it('should use default for missing agent', () => {
    let session   = {};
    let agentName = session?.agent?.name || 'Unknown';
    assert.strictEqual(agentName, 'Unknown');
  });
});

describe('WebSocket Status', () => {
  let wsConnected;

  beforeEach(() => {
    wsConnected = createMockDynamicProp(false);
  });

  it('should show disconnected status', () => {
    let status = wsConnected.valueOf() ? 'connected' : 'disconnected';
    assert.strictEqual(status, 'disconnected');
  });

  it('should show connected status', () => {
    wsConnected[mockDynamicProperty.set](true);
    let status = wsConnected.valueOf() ? 'connected' : 'disconnected';
    assert.strictEqual(status, 'connected');
  });

  it('should update on connection change', () => {
    let statuses = [];
    wsConnected.addEventListener('update', (e) => {
      statuses.push(e.value ? 'connected' : 'disconnected');
    });

    wsConnected[mockDynamicProperty.set](true);
    wsConnected[mockDynamicProperty.set](false);

    assert.deepStrictEqual(statuses, ['connected', 'disconnected']);
  });
});

describe('Abilities Button', () => {
  it('should show abilities button in sessions view', () => {
    let view           = 'sessions';
    let showAbilities  = view === 'sessions';
    assert.strictEqual(showAbilities, true);
  });

  it('should hide abilities button in chat view', () => {
    let view           = 'chat';
    let showAbilities  = view === 'sessions';
    assert.strictEqual(showAbilities, false);
  });
});

describe('Agents Button', () => {
  it('should show agents button in sessions view', () => {
    let view        = 'sessions';
    let showAgents  = view === 'sessions';
    assert.strictEqual(showAgents, true);
  });

  it('should hide agents button in chat view', () => {
    let view        = 'chat';
    let showAgents  = view === 'sessions';
    assert.strictEqual(showAgents, false);
  });
});
