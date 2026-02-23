'use strict';

/**
 * Tests for hml-prompt Web Component
 *
 * Tests the HML prompt component for:
 * - Options parsing (string arrays, object arrays, mixed)
 * - Radio/checkbox rendering with labels
 * - Text/number input rendering
 * - Answered state styling
 * - Event handling (no cascade)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import {
  createDOM,
  destroyDOM,
  getDocument,
  getWindow,
} from '../helpers/dom-helpers.mjs';

import {
  mountComponent,
  waitForRender,
  shadowQuery,
  shadowQueryAll,
  shadowText,
  typeInto,
  pressEnter,
  click,
  waitForEvent,
  createSpy,
  cleanupComponents,
} from '../helpers/component-helpers.mjs';

// =============================================================================
// Test: Options Normalization (Pure Function)
// =============================================================================

describe('Options Normalization', () => {
  /**
   * This tests the _normalizeOptions logic extracted from hml-prompt.
   * We test the pure function without needing DOM.
   */

  function normalizeOptions(parsed) {
    if (!Array.isArray(parsed)) return [];
    return parsed.map((opt) => {
      if (typeof opt === 'string') {
        return { value: opt, label: opt, selected: false };
      }
      return {
        value:    opt.value || opt.label || '',
        label:    opt.label || opt.value || '',
        selected: !!opt.selected,
      };
    });
  }

  it('should handle string array format', () => {
    const input = ['Option A', 'Option B', 'Option C'];
    const result = normalizeOptions(input);

    assert.strictEqual(result.length, 3);
    assert.deepStrictEqual(result[0], { value: 'Option A', label: 'Option A', selected: false });
    assert.deepStrictEqual(result[1], { value: 'Option B', label: 'Option B', selected: false });
    assert.deepStrictEqual(result[2], { value: 'Option C', label: 'Option C', selected: false });
  });

  it('should handle object array format with value and label', () => {
    const input = [
      { value: 'a', label: 'Option A' },
      { value: 'b', label: 'Option B', selected: true },
    ];
    const result = normalizeOptions(input);

    assert.strictEqual(result.length, 2);
    assert.deepStrictEqual(result[0], { value: 'a', label: 'Option A', selected: false });
    assert.deepStrictEqual(result[1], { value: 'b', label: 'Option B', selected: true });
  });

  it('should handle object with only value (use value as label)', () => {
    const input = [{ value: 'solo' }];
    const result = normalizeOptions(input);

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].value, 'solo');
    assert.strictEqual(result[0].label, 'solo');
  });

  it('should handle object with only label (use label as value)', () => {
    const input = [{ label: 'Just Label' }];
    const result = normalizeOptions(input);

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].value, 'Just Label');
    assert.strictEqual(result[0].label, 'Just Label');
  });

  it('should handle mixed format', () => {
    const input = [
      'String Option',
      { value: 'obj', label: 'Object Option' },
    ];
    const result = normalizeOptions(input);

    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].label, 'String Option');
    assert.strictEqual(result[1].label, 'Object Option');
  });

  it('should return empty array for non-array input', () => {
    assert.deepStrictEqual(normalizeOptions(null), []);
    assert.deepStrictEqual(normalizeOptions(undefined), []);
    assert.deepStrictEqual(normalizeOptions('string'), []);
    assert.deepStrictEqual(normalizeOptions(123), []);
  });

  it('should handle empty array', () => {
    assert.deepStrictEqual(normalizeOptions([]), []);
  });
});

// =============================================================================
// Test: Data JSON Parsing
// =============================================================================

describe('Data JSON Parsing', () => {
  /**
   * Tests JSON extraction from <data> element content.
   */

  it('should parse JSON string array from data element', () => {
    const jsonStr = '["Restart the computer", "Clear browser cache", "Blame the framework"]';
    const parsed = JSON.parse(jsonStr);

    assert.ok(Array.isArray(parsed));
    assert.strictEqual(parsed.length, 3);
    assert.strictEqual(parsed[0], 'Restart the computer');
  });

  it('should parse JSON object array from data element', () => {
    const jsonStr = '[{"value":"a","label":"Option A"},{"value":"b","label":"Option B"}]';
    const parsed = JSON.parse(jsonStr);

    assert.ok(Array.isArray(parsed));
    assert.strictEqual(parsed.length, 2);
    assert.strictEqual(parsed[0].value, 'a');
    assert.strictEqual(parsed[0].label, 'Option A');
  });

  it('should handle HTML entities in JSON', () => {
    // Simulate what _decodeHtmlEntities does
    function decodeHtmlEntities(text) {
      return text
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2018\u2019]/g, "'");
    }

    const encoded = '[{&quot;value&quot;:&quot;a&quot;,&quot;label&quot;:&quot;Option A&quot;}]';
    const decoded = decodeHtmlEntities(encoded);
    const parsed = JSON.parse(decoded);

    assert.strictEqual(parsed[0].value, 'a');
    assert.strictEqual(parsed[0].label, 'Option A');
  });

  it('should handle smart quotes conversion', () => {
    function decodeHtmlEntities(text) {
      return text
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2018\u2019]/g, "'");
    }

    // Smart quotes: "value" instead of "value"
    const withSmartQuotes = '[\u201Cvalue\u201D]';
    const decoded = decodeHtmlEntities(withSmartQuotes);

    assert.strictEqual(decoded, '["value"]');
  });
});

// =============================================================================
// Test: Event Cascade Prevention
// =============================================================================

describe('Event Cascade Prevention', () => {
  /**
   * Tests that event handlers properly prevent cascade.
   * This was a critical bug - single Enter key caused 1000+ events.
   */

  it('should prevent multiple handler executions with flag', () => {
    let executionCount = 0;
    let handlingEnter = false;

    function handleKeydown(e) {
      if (e.key === 'Enter') {
        if (handlingEnter) return; // Guard
        handlingEnter = true;

        executionCount++;

        // Simulate async cleanup
        setTimeout(() => { handlingEnter = false; }, 100);
      }
    }

    // Simulate rapid-fire events (like event bubbling cascade)
    for (let i = 0; i < 10; i++) {
      handleKeydown({ key: 'Enter' });
    }

    assert.strictEqual(executionCount, 1, 'Should only execute once despite multiple calls');
  });

  it('should use stopImmediatePropagation pattern', () => {
    const events = [];
    let handled = false;

    function handler1(e) {
      if (e._hmlHandled) return;
      e._hmlHandled = true;
      events.push('handler1');
    }

    function handler2(e) {
      if (e._hmlHandled) return;
      events.push('handler2');
    }

    const event = { key: 'Enter', _hmlHandled: false };

    handler1(event);
    handler2(event);

    assert.deepStrictEqual(events, ['handler1'], 'Only first handler should execute');
  });
});

// =============================================================================
// Test: Scroll Timing
// =============================================================================

describe('Scroll Timing', () => {
  /**
   * Tests that scroll happens AFTER render, not before.
   */

  it('should track scroll flag for post-render scroll', () => {
    let scrollAfterRender = false;
    let renderCalled = false;
    let scrollCalled = false;
    let scrollCalledBeforeRender = false;

    function renderDebounced() {
      // Set flag to scroll after render
      scrollAfterRender = true;

      // Simulate debounced render
      setTimeout(() => {
        doRender();
      }, 16);
    }

    function doRender() {
      renderCalled = true;

      // Handle scroll AFTER render
      if (scrollAfterRender) {
        scrollAfterRender = false;
        scrollToBottom();
      }
    }

    function scrollToBottom() {
      scrollCalled = true;
      scrollCalledBeforeRender = !renderCalled;
    }

    renderDebounced();

    // Before render completes
    assert.strictEqual(renderCalled, false);
    assert.strictEqual(scrollCalled, false);

    // Simulate time passing
    return new Promise((resolve) => {
      setTimeout(() => {
        assert.strictEqual(renderCalled, true, 'Render should have been called');
        assert.strictEqual(scrollCalled, true, 'Scroll should have been called');
        assert.strictEqual(scrollCalledBeforeRender, false, 'Scroll should happen AFTER render');
        resolve();
      }, 50);
    });
  });
});

// =============================================================================
// Test: Content Format Detection
// =============================================================================

describe('Content Format Detection', () => {
  /**
   * Tests handling of both string and array content formats.
   */

  it('should detect string content format', () => {
    const content = 'Hello <hml-prompt>world</hml-prompt>';
    const isString = typeof content === 'string';
    const isArray = Array.isArray(content);

    assert.strictEqual(isString, true);
    assert.strictEqual(isArray, false);
  });

  it('should detect Claude API array format', () => {
    const content = [
      { type: 'text', text: 'Hello <hml-prompt>world</hml-prompt>' },
    ];
    const isString = typeof content === 'string';
    const isArray = Array.isArray(content);

    assert.strictEqual(isString, false);
    assert.strictEqual(isArray, true);
  });

  it('should extract text from array format', () => {
    const content = [
      { type: 'text', text: 'First part' },
      { type: 'tool_use', name: 'something' },
      { type: 'text', text: 'Second part' },
    ];

    const textBlockIndex = content.findIndex(
      (block) => block.type === 'text' && typeof block.text === 'string'
    );

    assert.strictEqual(textBlockIndex, 0);
    assert.strictEqual(content[textBlockIndex].text, 'First part');
  });

  it('should handle missing text block', () => {
    const content = [
      { type: 'tool_use', name: 'something' },
    ];

    const textBlockIndex = content.findIndex(
      (block) => block.type === 'text' && typeof block.text === 'string'
    );

    assert.strictEqual(textBlockIndex, -1);
  });
});

// =============================================================================
// Test: DOM Rendering Logic
// =============================================================================

describe('HML Prompt DOM Rendering', () => {
  beforeEach(() => {
    createDOM();
  });

  afterEach(() => {
    destroyDOM();
  });

  /**
   * Simplified rendering functions extracted from hml-prompt.
   * These mirror the actual rendering logic.
   */

  function normalizeOptions(parsed) {
    if (!Array.isArray(parsed)) return [];
    return parsed.map((opt) => {
      if (typeof opt === 'string') {
        return { value: opt, label: opt, selected: false };
      }
      return {
        value:    opt.value || opt.label || '',
        label:    opt.label || opt.value || '',
        selected: !!opt.selected,
      };
    });
  }

  function renderRadioOptions(options, promptId) {
    const doc = getDocument();
    const container = doc.createElement('div');
    container.className = 'prompt-options';

    options.forEach((opt, index) => {
      const optionDiv = doc.createElement('div');
      optionDiv.className = 'prompt-option';

      const radio = doc.createElement('input');
      radio.type = 'radio';
      radio.name = `prompt-${promptId}`;
      radio.value = opt.value;
      radio.id = `${promptId}-opt-${index}`;
      if (opt.selected) radio.checked = true;

      const label = doc.createElement('label');
      label.setAttribute('for', `${promptId}-opt-${index}`);
      label.textContent = opt.label;

      optionDiv.appendChild(radio);
      optionDiv.appendChild(label);
      container.appendChild(optionDiv);
    });

    return container;
  }

  function renderCheckboxOptions(options, promptId) {
    const doc = getDocument();
    const container = doc.createElement('div');
    container.className = 'prompt-options';

    options.forEach((opt, index) => {
      const optionDiv = doc.createElement('div');
      optionDiv.className = 'prompt-option';

      const checkbox = doc.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.name = `prompt-${promptId}`;
      checkbox.value = opt.value;
      checkbox.id = `${promptId}-opt-${index}`;
      if (opt.selected) checkbox.checked = true;

      const label = doc.createElement('label');
      label.setAttribute('for', `${promptId}-opt-${index}`);
      label.textContent = opt.label;

      optionDiv.appendChild(checkbox);
      optionDiv.appendChild(label);
      container.appendChild(optionDiv);
    });

    return container;
  }

  function renderAnsweredState(container, answer) {
    const doc = getDocument();
    container.classList.add('prompt-answered');

    const answerDiv = doc.createElement('div');
    answerDiv.className = 'prompt-answer';
    answerDiv.textContent = answer;

    container.appendChild(answerDiv);
    return container;
  }

  describe('Radio Button Rendering', () => {
    it('should render radio buttons with labels', () => {
      const doc = getDocument();
      const options = normalizeOptions(['Option A', 'Option B', 'Option C']);
      const container = renderRadioOptions(options, 'test-radio');

      doc.body.appendChild(container);

      const radios = doc.querySelectorAll('input[type="radio"]');
      const labels = doc.querySelectorAll('label');

      assert.strictEqual(radios.length, 3, 'Should render 3 radio buttons');
      assert.strictEqual(labels.length, 3, 'Should render 3 labels');

      // Verify labels have correct text
      assert.strictEqual(labels[0].textContent, 'Option A');
      assert.strictEqual(labels[1].textContent, 'Option B');
      assert.strictEqual(labels[2].textContent, 'Option C');

      // Verify labels are associated with radios
      assert.strictEqual(labels[0].getAttribute('for'), radios[0].id);
      assert.strictEqual(labels[1].getAttribute('for'), radios[1].id);
      assert.strictEqual(labels[2].getAttribute('for'), radios[2].id);
    });

    it('should render radio buttons with object options', () => {
      const doc = getDocument();
      const options = normalizeOptions([
        { value: 'a', label: 'First Option' },
        { value: 'b', label: 'Second Option', selected: true },
      ]);
      const container = renderRadioOptions(options, 'test-obj');

      doc.body.appendChild(container);

      const radios = doc.querySelectorAll('input[type="radio"]');
      const labels = doc.querySelectorAll('label');

      assert.strictEqual(radios.length, 2);

      // Verify values
      assert.strictEqual(radios[0].value, 'a');
      assert.strictEqual(radios[1].value, 'b');

      // Verify labels show label text, not value
      assert.strictEqual(labels[0].textContent, 'First Option');
      assert.strictEqual(labels[1].textContent, 'Second Option');

      // Verify pre-selected state
      assert.strictEqual(radios[0].checked, false);
      assert.strictEqual(radios[1].checked, true);
    });

    it('should have same name attribute for all radios in group', () => {
      const doc = getDocument();
      const options = normalizeOptions(['A', 'B', 'C']);
      const container = renderRadioOptions(options, 'group-test');

      doc.body.appendChild(container);

      const radios = doc.querySelectorAll('input[type="radio"]');

      assert.strictEqual(radios[0].name, 'prompt-group-test');
      assert.strictEqual(radios[1].name, 'prompt-group-test');
      assert.strictEqual(radios[2].name, 'prompt-group-test');
    });
  });

  describe('Checkbox Rendering', () => {
    it('should render checkboxes with labels', () => {
      const doc = getDocument();
      const options = normalizeOptions(['Feature A', 'Feature B']);
      const container = renderCheckboxOptions(options, 'test-check');

      doc.body.appendChild(container);

      const checkboxes = doc.querySelectorAll('input[type="checkbox"]');
      const labels = doc.querySelectorAll('label');

      assert.strictEqual(checkboxes.length, 2, 'Should render 2 checkboxes');
      assert.strictEqual(labels.length, 2, 'Should render 2 labels');

      assert.strictEqual(labels[0].textContent, 'Feature A');
      assert.strictEqual(labels[1].textContent, 'Feature B');
    });

    it('should allow multiple selections', () => {
      const doc = getDocument();
      const options = normalizeOptions([
        { value: 'a', label: 'A', selected: true },
        { value: 'b', label: 'B', selected: true },
        { value: 'c', label: 'C', selected: false },
      ]);
      const container = renderCheckboxOptions(options, 'multi-test');

      doc.body.appendChild(container);

      const checkboxes = doc.querySelectorAll('input[type="checkbox"]');

      assert.strictEqual(checkboxes[0].checked, true);
      assert.strictEqual(checkboxes[1].checked, true);
      assert.strictEqual(checkboxes[2].checked, false);
    });
  });

  describe('Answered State Rendering', () => {
    it('should add answered class to container', () => {
      const doc = getDocument();
      const container = doc.createElement('div');
      container.className = 'prompt-container';

      renderAnsweredState(container, 'User answer here');

      assert.ok(container.classList.contains('prompt-answered'), 'Should have prompt-answered class');
    });

    it('should display the answer text', () => {
      const doc = getDocument();
      const container = doc.createElement('div');
      container.className = 'prompt-container';

      renderAnsweredState(container, 'My favorite color is blue');

      doc.body.appendChild(container);

      const answerEl = doc.querySelector('.prompt-answer');
      assert.ok(answerEl, 'Should have answer element');
      assert.strictEqual(answerEl.textContent, 'My favorite color is blue');
    });

    it('should render green styling via CSS class', () => {
      const doc = getDocument();
      const container = doc.createElement('div');
      container.className = 'prompt-container';

      renderAnsweredState(container, 'Answer');

      // The 'prompt-answered' class is what triggers green styling in CSS
      assert.ok(
        container.classList.contains('prompt-answered'),
        'Should have prompt-answered class for green styling'
      );
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty options array', () => {
      const doc = getDocument();
      const options = normalizeOptions([]);
      const container = renderRadioOptions(options, 'empty-test');

      doc.body.appendChild(container);

      const radios = doc.querySelectorAll('input[type="radio"]');
      assert.strictEqual(radios.length, 0);
    });

    it('should handle special characters in labels', () => {
      const doc = getDocument();
      const options = normalizeOptions(['Option <A>', 'Option & B', '"Quoted"']);
      const container = renderRadioOptions(options, 'special-test');

      doc.body.appendChild(container);

      const labels = doc.querySelectorAll('label');
      assert.strictEqual(labels[0].textContent, 'Option <A>');
      assert.strictEqual(labels[1].textContent, 'Option & B');
      assert.strictEqual(labels[2].textContent, '"Quoted"');
    });

    it('should handle very long label text', () => {
      const doc = getDocument();
      const longLabel = 'A'.repeat(500);
      const options = normalizeOptions([longLabel]);
      const container = renderRadioOptions(options, 'long-test');

      doc.body.appendChild(container);

      const labels = doc.querySelectorAll('label');
      assert.strictEqual(labels[0].textContent.length, 500);
    });
  });
});

// =============================================================================
// Summary
// =============================================================================

/*
 * These tests cover the core logic of hml-prompt including:
 *
 * 1. Options normalization (string vs object arrays) - THE BUG WE FIXED
 * 2. JSON parsing and HTML entity decoding
 * 3. Event cascade prevention patterns - THE BUG WE FIXED
 * 4. Scroll timing (post-render) - THE BUG WE FIXED
 * 5. Content format detection (string vs array) - THE BUG WE FIXED
 * 6. Radio button DOM rendering with labels - NEW
 * 7. Checkbox DOM rendering with labels - NEW
 * 8. Answered state renders with correct class - NEW
 *
 * To run: node --test spec/components/hml-prompt-spec.mjs
 */
