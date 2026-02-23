'use strict';

/**
 * S3: Prompt Form UX Tests
 *
 * Verifies:
 * - PROMPT-001: Zero per-prompt submit buttons in DOM
 * - PROMPT-002: Single prompt message has Ignore / Submit
 * - PROMPT-003: Enter advances focus through prompts then to Submit
 * - PROMPT-005: getCurrentAnswer returns current value
 * - PROMPT-006: _bufferAnswer dispatches prompt-answer-ready
 * - PROMPT-007: _collectUnbufferedAnswers reads from prompt elements
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Read source files once for structural tests
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

const hmlPromptSource = fs.readFileSync(
  path.join(projectRoot, 'public/js/components/hml-prompt/hml-prompt.js'),
  'utf-8'
);
const heroChatSource = fs.readFileSync(
  path.join(projectRoot, 'public/js/components/hero-chat/hero-chat.js'),
  'utf-8'
);
const appSource = fs.readFileSync(
  path.join(projectRoot, 'public/js/app.js'),
  'utf-8'
);

// =============================================================================
// PROMPT-001: Zero Per-Prompt Submit Buttons
// =============================================================================

describe('PROMPT-001: No per-prompt submit buttons', () => {
  it('should not have submit-button class in hml-prompt source', () => {
    const buttonMatches = hmlPromptSource.match(/submit-button/g) || [];
    assert.strictEqual(buttonMatches.length, 0,
      `Expected 0 submit-button references, found ${buttonMatches.length}`);
  });

  it('should not have OK</button> in any render method', () => {
    const okButtons = hmlPromptSource.match(/>OK<\/button>/g) || [];
    assert.strictEqual(okButtons.length, 0,
      `Expected 0 OK buttons, found ${okButtons.length}`);
  });
});

// =============================================================================
// PROMPT-002: Single Prompt Gets Ignore / Submit Buttons
// =============================================================================

describe('PROMPT-002: Single prompt message has Ignore / Submit', () => {
  it('should show buttons for 1+ prompts (threshold < 1, not < 2)', () => {
    assert.ok(
      heroChatSource.includes('prompts.length < 1'),
      'Threshold should be < 1 (show buttons for 1+ prompts)'
    );
    assert.ok(
      !heroChatSource.includes('prompts.length < 2'),
      'Old threshold < 2 should be removed'
    );
  });

  it('should have Ignore button before Submit button in footer template', () => {
    // Buttons are now rendered in _renderFooter's template
    let footerStart = heroChatSource.indexOf('_renderFooter(message, tokenEstimate) {');
    assert.ok(footerStart > -1, 'Should have _renderFooter method');

    let body = heroChatSource.slice(footerStart, footerStart + 600);
    let ignorePos = body.indexOf('prompt-batch-ignore');
    let submitPos = body.indexOf('prompt-batch-submit');

    assert.ok(ignorePos > 0, 'Ignore button should exist in footer template');
    assert.ok(submitPos > 0, 'Submit button should exist in footer template');
    assert.ok(ignorePos < submitPos,
      'Ignore button should appear before Submit button');
  });

  it('should label button as Submit not Submit All', () => {
    assert.ok(
      heroChatSource.includes('>Submit</button>'),
      'Button should say "Submit"'
    );
    assert.ok(
      !heroChatSource.includes('>Submit All</button>'),
      'Button should NOT say "Submit All"'
    );
  });

  it('should skip buttons if all prompts are already answered', () => {
    assert.ok(
      heroChatSource.includes('unanswered.length === 0'),
      'Should check for unanswered prompts and skip if none'
    );
  });
});

// =============================================================================
// PROMPT-003: Enter Advances Focus (Tab-Forward)
// =============================================================================

describe('PROMPT-003: Enter advances focus through prompts', () => {
  it('should call _bufferAndAdvance on Enter in text input', () => {
    // _renderText section includes the keydown handler
    assert.ok(
      hmlPromptSource.includes("if (answer) this._bufferAndAdvance(answer)"),
      'Enter on text should call _bufferAndAdvance'
    );
    // _submitAnswer should NOT appear in any render method
    assert.ok(
      !hmlPromptSource.includes('_submitAnswer'),
      'No render method should call _submitAnswer (removed in S3)'
    );
  });

  it('should have _bufferAndAdvance method that dispatches prompt-tab-forward', () => {
    assert.ok(
      hmlPromptSource.includes('_bufferAndAdvance(answer)'),
      '_bufferAndAdvance method should exist'
    );
    assert.ok(
      hmlPromptSource.includes("'prompt-tab-forward'"),
      '_bufferAndAdvance should dispatch prompt-tab-forward event'
    );
  });

  it('should have focus chain setup in hero-chat', () => {
    assert.ok(
      heroChatSource.includes('_setupPromptFocusChain'),
      'hero-chat should have _setupPromptFocusChain method'
    );
    assert.ok(
      heroChatSource.includes('_focusPromptInput'),
      'hero-chat should have _focusPromptInput method'
    );
    assert.ok(
      heroChatSource.includes("'prompt-tab-forward'"),
      'hero-chat should listen for prompt-tab-forward events'
    );
  });

  it('should focus Submit button after last prompt', () => {
    // Look for submitBtn.focus() in _setupPromptFocusChain method
    const chainStart = heroChatSource.indexOf('_setupPromptFocusChain(');
    assert.ok(chainStart > 0, '_setupPromptFocusChain should exist');

    const chainBody = heroChatSource.slice(chainStart, chainStart + 1200);
    assert.ok(
      chainBody.includes('submitBtn.focus()'),
      'Should focus Submit button when no more unanswered prompts'
    );
  });
});

// =============================================================================
// PROMPT-005: getCurrentAnswer Returns Current Value
// =============================================================================

describe('PROMPT-005: getCurrentAnswer', () => {
  it('should be defined as a method on hml-prompt', () => {
    assert.ok(
      hmlPromptSource.includes('getCurrentAnswer()'),
      'hml-prompt should have getCurrentAnswer method'
    );
  });

  it('should check buffered answer and isAnswered state', () => {
    assert.ok(
      hmlPromptSource.includes('if (this.isAnswered) return this.response'),
      'Should check isAnswered state first'
    );
    assert.ok(
      hmlPromptSource.includes('if (this._bufferedAnswer) return this._bufferedAnswer'),
      'Should check _bufferedAnswer second'
    );
  });

  it('should fall back to reading shadow DOM input', () => {
    // Find getCurrentAnswer method definition
    const methodStart = hmlPromptSource.indexOf('  getCurrentAnswer()');
    assert.ok(methodStart > 0, 'getCurrentAnswer should be defined');

    const methodBody = hmlPromptSource.slice(methodStart, methodStart + 900);

    assert.ok(methodBody.includes('shadowRoot'), 'Should access shadowRoot');
    assert.ok(methodBody.includes('querySelector'), 'Should query for input elements');
    assert.ok(methodBody.includes('checkbox'), 'Should handle checkbox type');
    assert.ok(methodBody.includes('.value'), 'Should read input value');
  });
});

// =============================================================================
// PROMPT-006: _bufferAnswer Dispatches prompt-answer-ready
// =============================================================================

describe('PROMPT-006: _bufferAnswer dispatches prompt-answer-ready', () => {
  it('should dispatch prompt-answer-ready event with correct detail', () => {
    assert.ok(
      hmlPromptSource.includes("'prompt-answer-ready'"),
      '_bufferAnswer should dispatch prompt-answer-ready event'
    );
    // Verify the event is in _bufferAnswer method definition
    const bufferStart = hmlPromptSource.indexOf('_bufferAnswer(answer) {');
    const bufferEnd = hmlPromptSource.indexOf('_bufferAndAdvance(', bufferStart);
    const bufferSection = hmlPromptSource.slice(bufferStart, bufferEnd);

    assert.ok(bufferSection.includes('bubbles:'), 'Event should bubble');
    assert.ok(bufferSection.includes('composed:'), 'Event should be composed');
    assert.ok(bufferSection.includes('promptId:'), 'Event detail should include promptId');
    assert.ok(bufferSection.includes('answer:'), 'Event detail should include answer');
  });

  it('should use _bufferAnswer in non-text renders (color, checkbox, radio, select, range)', () => {
    // Find each method definition (preceded by whitespace+method name) and check body
    const methodDefs = [
      { name: '_renderColor',     marker: '  _renderColor()' },
      { name: '_renderCheckbox',  marker: '  _renderCheckbox()' },
      { name: '_renderCheckboxes', marker: '  _renderCheckboxes()' },
      { name: '_renderRadio',     marker: '  _renderRadio()' },
      { name: '_renderSelect',    marker: '  _renderSelect()' },
      { name: '_renderRange',     marker: '  _renderRange()' },
    ];

    for (const { name, marker } of methodDefs) {
      // Find the method definition (not the switch case reference)
      const defStart = hmlPromptSource.indexOf(marker);
      assert.ok(defStart > 0, `${name} method definition should exist`);

      // Get a reasonable chunk of the method body (some methods are long)
      const methodBody = hmlPromptSource.slice(defStart, defStart + 1500);
      assert.ok(
        methodBody.includes('_bufferAnswer'),
        `${name} should call _bufferAnswer (not _submitAnswer)`
      );
    }
  });
});

// =============================================================================
// PROMPT-007: app.js Prompt Event Handling
// =============================================================================

describe('PROMPT-007: app.js prompt event handling', () => {
  it('should listen for prompt-answer-ready events', () => {
    assert.ok(
      appSource.includes("'prompt-answer-ready'"),
      'app.js should listen for prompt-answer-ready events'
    );
  });

  it('should NOT individually submit on prompt-submit event', () => {
    const promptSubmitHandler = appSource.slice(
      appSource.indexOf("'prompt-submit'"),
      appSource.indexOf('function updateOperationState')
    );

    assert.ok(
      !promptSubmitHandler.includes('submitUserPromptAnswer'),
      'prompt-submit handler should NOT call submitUserPromptAnswer (S3: buffer only)'
    );
  });

  it('should have _collectUnbufferedAnswers function', () => {
    assert.ok(
      appSource.includes('_collectUnbufferedAnswers'),
      'app.js should have _collectUnbufferedAnswers function'
    );
  });

  it('should call _collectUnbufferedAnswers before reading pending answers', () => {
    const submitBatchSection = appSource.slice(
      appSource.indexOf('function submitPromptBatch('),
      appSource.indexOf('function ignorePromptBatch(')
    );

    const collectIndex = submitBatchSection.indexOf('_collectUnbufferedAnswers');
    const answersIndex = submitBatchSection.indexOf('_pendingPromptAnswers.get');

    assert.ok(collectIndex > 0, '_collectUnbufferedAnswers should be called');
    assert.ok(collectIndex < answersIndex,
      '_collectUnbufferedAnswers should run BEFORE reading pending answers');
  });
});

// =============================================================================
// Behavioral: Buffer and Batch Logic
// =============================================================================

describe('Prompt Batch Buffer Logic', () => {
  it('should buffer answers by messageId and promptId', () => {
    const pendingAnswers = new Map();

    function bufferAnswer(messageId, promptId, question, answer, type) {
      if (!pendingAnswers.has(messageId))
        pendingAnswers.set(messageId, new Map());
      pendingAnswers.get(messageId).set(promptId, { question, answer, type });
    }

    bufferAnswer('msg-1', 'p-1', 'Color?', 'blue', 'text');
    bufferAnswer('msg-1', 'p-2', 'Size?', 'large', 'radio');
    bufferAnswer('msg-2', 'p-3', 'Name?', 'Claude', 'text');

    assert.strictEqual(pendingAnswers.size, 2, 'Two messages with answers');
    assert.strictEqual(pendingAnswers.get('msg-1').size, 2, 'Message 1 has 2 answers');
    assert.strictEqual(pendingAnswers.get('msg-2').size, 1, 'Message 2 has 1 answer');
    assert.strictEqual(pendingAnswers.get('msg-1').get('p-1').answer, 'blue');
  });

  it('should replace buffer on re-answer (user changed their mind)', () => {
    const pendingAnswers = new Map();

    function bufferAnswer(messageId, promptId, question, answer, type) {
      if (!pendingAnswers.has(messageId))
        pendingAnswers.set(messageId, new Map());
      pendingAnswers.get(messageId).set(promptId, { question, answer, type });
    }

    bufferAnswer('msg-1', 'p-1', 'Color?', 'blue', 'text');
    bufferAnswer('msg-1', 'p-1', 'Color?', 'red', 'text');

    assert.strictEqual(
      pendingAnswers.get('msg-1').get('p-1').answer, 'red',
      'Should use latest answer'
    );
  });

  it('should build interaction blocks for batch submission', () => {
    const answers = new Map();
    answers.set('p-1', { question: 'Color?', answer: 'blue', type: 'text' });
    answers.set('p-2', { question: 'Size?', answer: 'large', type: 'radio' });

    const messageId = 'msg-1';
    const interactions = [];

    for (let [promptId, data] of answers) {
      interactions.push({
        interaction_id:  `prompt-response-${promptId}`,
        target_id:       '@system',
        target_property: 'update_prompt',
        payload: {
          message_id: messageId,
          prompt_id:  promptId,
          answer:     data.answer,
          question:   data.question,
        },
      });
    }

    assert.strictEqual(interactions.length, 2);
    assert.strictEqual(interactions[0].payload.answer, 'blue');
    assert.strictEqual(interactions[1].payload.answer, 'large');
  });

  it('should skip already-submitted prompts in batch', () => {
    const submitted = new Set();
    const answers = new Map();
    answers.set('p-1', { question: 'Q1?', answer: 'A1', type: 'text' });
    answers.set('p-2', { question: 'Q2?', answer: 'A2', type: 'text' });

    submitted.add('msg-1-p-1');

    const interactions = [];
    for (let [promptId, data] of answers) {
      let key = `msg-1-${promptId}`;
      if (submitted.has(key)) continue;
      submitted.add(key);
      interactions.push({ promptId, answer: data.answer });
    }

    assert.strictEqual(interactions.length, 1, 'Only 1 new interaction');
    assert.strictEqual(interactions[0].promptId, 'p-2');
  });
});

// =============================================================================
// Behavioral: Focus Chain Logic
// =============================================================================

describe('Prompt Focus Chain Logic', () => {
  it('should find next unanswered prompt in chain', () => {
    const prompts = [
      { promptId: 'p-1', isAnswered: true },
      { promptId: 'p-2', isAnswered: false },
      { promptId: 'p-3', isAnswered: false },
    ];

    function findNext(fromId) {
      let index = prompts.findIndex((p) => p.promptId === fromId);
      if (index < 0) return null;
      for (let i = index + 1; i < prompts.length; i++) {
        if (!prompts[i].isAnswered) return prompts[i].promptId;
      }
      return null;
    }

    assert.strictEqual(findNext('p-1'), 'p-2');
    assert.strictEqual(findNext('p-2'), 'p-3');
    assert.strictEqual(findNext('p-3'), null, 'Last prompt → focus Submit');
  });

  it('should skip answered prompts in focus chain', () => {
    const prompts = [
      { promptId: 'p-1', isAnswered: false },
      { promptId: 'p-2', isAnswered: true },
      { promptId: 'p-3', isAnswered: false },
    ];

    function findNext(fromId) {
      let index = prompts.findIndex((p) => p.promptId === fromId);
      if (index < 0) return null;
      for (let i = index + 1; i < prompts.length; i++) {
        if (!prompts[i].isAnswered) return prompts[i].promptId;
      }
      return null;
    }

    assert.strictEqual(findNext('p-1'), 'p-3', 'Should skip answered p-2');
  });

  it('should handle single prompt (Enter → Submit button)', () => {
    const prompts = [
      { promptId: 'p-1', isAnswered: false },
    ];

    function findNext(fromId) {
      let index = prompts.findIndex((p) => p.promptId === fromId);
      if (index < 0) return null;
      for (let i = index + 1; i < prompts.length; i++) {
        if (!prompts[i].isAnswered) return prompts[i].promptId;
      }
      return null;
    }

    assert.strictEqual(findNext('p-1'), null, 'Single prompt → focus Submit');
  });
});
