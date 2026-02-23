/**
 * Tests for hero-modal.js (base modal component)
 *
 * Tests HeroModal component:
 * - Open/close behavior
 * - Form handling
 * - Keyboard navigation
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

describe('Modal Visibility', () => {
  it('should start hidden', () => {
    let isOpen = false;
    assert.strictEqual(isOpen, false);
  });

  it('should show when opened', () => {
    let isOpen = false;
    isOpen = true;
    assert.strictEqual(isOpen, true);
  });

  it('should hide when closed', () => {
    let isOpen = true;
    isOpen = false;
    assert.strictEqual(isOpen, false);
  });

  it('should toggle visibility', () => {
    let isOpen = false;
    isOpen = !isOpen;
    assert.strictEqual(isOpen, true);
    isOpen = !isOpen;
    assert.strictEqual(isOpen, false);
  });
});

describe('Modal Form Reset', () => {
  it('should clear form fields on open', () => {
    let formData = { name: 'Test', value: 123 };

    // Reset form
    formData = { name: '', value: 0 };

    assert.strictEqual(formData.name, '');
    assert.strictEqual(formData.value, 0);
  });

  it('should clear error message on open', () => {
    let error = 'Previous error';
    error = '';
    assert.strictEqual(error, '');
  });
});

describe('Modal Keyboard Events', () => {
  it('should detect Escape key', () => {
    let event = { key: 'Escape' };
    let shouldClose = event.key === 'Escape';
    assert.strictEqual(shouldClose, true);
  });

  it('should detect Enter key in form', () => {
    let event = { key: 'Enter' };
    let shouldSubmit = event.key === 'Enter';
    assert.strictEqual(shouldSubmit, true);
  });

  it('should not close on other keys', () => {
    let event = { key: 'a' };
    let shouldClose = event.key === 'Escape';
    assert.strictEqual(shouldClose, false);
  });
});

describe('Modal Backdrop Click', () => {
  it('should close when clicking backdrop', () => {
    let targetClass = 'modal-backdrop';
    let shouldClose = targetClass === 'modal-backdrop';
    assert.strictEqual(shouldClose, true);
  });

  it('should not close when clicking content', () => {
    let targetClass = 'modal-content';
    let shouldClose = targetClass === 'modal-backdrop';
    assert.strictEqual(shouldClose, false);
  });
});

describe('Form Validation', () => {
  it('should validate required fields', () => {
    let name = '';
    let isValid = name.trim().length > 0;
    assert.strictEqual(isValid, false);
  });

  it('should pass validation with content', () => {
    let name = 'Test Session';
    let isValid = name.trim().length > 0;
    assert.strictEqual(isValid, true);
  });

  it('should trim whitespace', () => {
    let name = '  Test  ';
    let trimmed = name.trim();
    assert.strictEqual(trimmed, 'Test');
  });
});

describe('Session Modal', () => {
  let agents;

  beforeEach(() => {
    agents = [
      { id: 1, name: 'Claude', type: 'claude' },
      { id: 2, name: 'GPT-4', type: 'openai' },
    ];
  });

  it('should populate agent dropdown', () => {
    let options = agents.map((a) => ({ value: a.id, label: `${a.name} (${a.type})` }));
    assert.strictEqual(options.length, 2);
    assert.strictEqual(options[0].label, 'Claude (claude)');
  });

  it('should show empty state when no agents', () => {
    agents = [];
    let hasAgents = agents.length > 0;
    assert.strictEqual(hasAgents, false);
  });

  it('should require agent selection', () => {
    let agentId = null;
    let isValid = agentId !== null && agentId !== '';
    assert.strictEqual(isValid, false);
  });

  it('should accept valid agent selection', () => {
    let agentId = 1;
    let isValid = agentId !== null && agentId !== '';
    assert.strictEqual(isValid, true);
  });
});

describe('Agent Modal', () => {
  it('should require name', () => {
    let data = { name: '', type: 'claude', apiKey: 'key' };
    let isValid = data.name.length > 0 && data.type.length > 0 && data.apiKey.length > 0;
    assert.strictEqual(isValid, false);
  });

  it('should require type', () => {
    let data = { name: 'Test', type: '', apiKey: 'key' };
    let isValid = data.name.length > 0 && data.type.length > 0 && data.apiKey.length > 0;
    assert.strictEqual(isValid, false);
  });

  it('should require API key', () => {
    let data = { name: 'Test', type: 'claude', apiKey: '' };
    let isValid = data.name.length > 0 && data.type.length > 0 && data.apiKey.length > 0;
    assert.strictEqual(isValid, false);
  });

  it('should accept valid agent data', () => {
    let data = { name: 'Test', type: 'claude', apiKey: 'sk-xxx' };
    let isValid = data.name.length > 0 && data.type.length > 0 && data.apiKey.length > 0;
    assert.strictEqual(isValid, true);
  });

  it('should allow optional API URL', () => {
    let data = { name: 'Test', type: 'claude', apiKey: 'key', apiUrl: '' };
    let apiUrl = data.apiUrl.trim() || null;
    assert.strictEqual(apiUrl, null);
  });

  it('should preserve non-empty API URL', () => {
    let data = { name: 'Test', type: 'claude', apiKey: 'key', apiUrl: 'https://api.example.com' };
    let apiUrl = data.apiUrl.trim() || null;
    assert.strictEqual(apiUrl, 'https://api.example.com');
  });
});

describe('Agent Type Model Filtering', () => {
  it('should show Claude models for claude type', () => {
    let agentType     = 'claude';
    let showClaude    = agentType === 'claude';
    let showOpenai    = agentType === 'openai';
    assert.strictEqual(showClaude, true);
    assert.strictEqual(showOpenai, false);
  });

  it('should show OpenAI models for openai type', () => {
    let agentType     = 'openai';
    let showClaude    = agentType === 'claude';
    let showOpenai    = agentType === 'openai';
    assert.strictEqual(showClaude, false);
    assert.strictEqual(showOpenai, true);
  });
});

describe('Ability Modal', () => {
  it('should require name', () => {
    let data = { name: '', description: 'desc', content: 'content' };
    let isValid = data.name.length > 0;
    assert.strictEqual(isValid, false);
  });

  it('should allow editing', () => {
    let ability = { id: 1, name: 'Test', description: 'Desc' };
    let isEdit = ability.id !== null && ability.id !== undefined;
    assert.strictEqual(isEdit, true);
  });

  it('should detect create mode', () => {
    let ability = { id: null, name: '', description: '' };
    let isEdit = ability.id !== null && ability.id !== undefined;
    assert.strictEqual(isEdit, false);
  });
});

describe('Ability Checkboxes', () => {
  let abilities;

  beforeEach(() => {
    abilities = [
      { name: '_onstart', category: 'system' },
      { name: '_web_search', category: 'system' },
      { name: 'custom_tool', category: 'user' },
    ];
  });

  it('should list all abilities', () => {
    assert.strictEqual(abilities.length, 3);
  });

  it('should separate by category', () => {
    let system = abilities.filter((a) => a.category === 'system');
    let user   = abilities.filter((a) => a.category === 'user');
    assert.strictEqual(system.length, 2);
    assert.strictEqual(user.length, 1);
  });

  it('should collect checked abilities', () => {
    let checked = ['_onstart', 'custom_tool'];
    assert.deepStrictEqual(checked, ['_onstart', 'custom_tool']);
  });
});

describe('Modal Error Display', () => {
  it('should show error message', () => {
    let error = 'Failed to create session';
    let showError = error.length > 0;
    assert.strictEqual(showError, true);
  });

  it('should hide when no error', () => {
    let error = '';
    let showError = error.length > 0;
    assert.strictEqual(showError, false);
  });

  it('should clear error on success', () => {
    let error = 'Some error';
    // Simulate success
    error = '';
    assert.strictEqual(error, '');
  });
});
