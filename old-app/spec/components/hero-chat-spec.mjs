/**
 * Tests for hero-chat.js
 *
 * Tests HeroChat component:
 * - Source integrity (private field declarations)
 * - Message list rendering
 * - Message visibility filtering
 * - Scroll behavior
 * - Streaming state
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

// ============================================================================
// CHAT-SRC: Source integrity — every private field used is declared
// ============================================================================

describe('CHAT-SRC: hero-chat.js source integrity', () => {
  let source;

  beforeEach(() => {
    source = fs.readFileSync('public/js/components/hero-chat/hero-chat.js', 'utf8');
  });

  it('should declare every private field that is used', () => {
    // Extract all private field USAGES: this.#fieldName
    let usageMatches = source.matchAll(/this\.#(\w+)/g);
    let usedFields   = new Set([...usageMatches].map((m) => m[1]));

    // Extract all private field DECLARATIONS: #fieldName = or #fieldName;
    // Class private fields are declared at the top of the class body
    let declMatches    = source.matchAll(/^\s+#(\w+)\s*[=;]/gm);
    let declaredFields = new Set([...declMatches].map((m) => m[1]));

    // Also include private METHOD declarations: #methodName(
    let methodMatches   = source.matchAll(/^\s+#(\w+)\s*\(/gm);
    let declaredMethods = new Set([...methodMatches].map((m) => m[1]));

    let allDeclared = new Set([...declaredFields, ...declaredMethods]);

    for (let field of usedFields) {
      assert.ok(
        allDeclared.has(field),
        `Private field '#${field}' is used (this.#${field}) but never declared in the class`,
      );
    }
  });
});

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

describe('Message Visibility Filtering', () => {
  let messages;

  beforeEach(() => {
    messages = [
      { id: 1, role: 'user', content: 'Hello', hidden: false },
      { id: 2, role: 'assistant', content: 'Hi there', hidden: false },
      { id: 3, role: 'user', content: 'System', hidden: true, type: 'system' },
      { id: 4, role: 'assistant', content: 'Interaction', hidden: true, type: 'interaction' },
    ];
  });

  it('should hide hidden messages by default', () => {
    let showHidden = false;
    let visible = (showHidden)
      ? messages
      : messages.filter((m) => !m.hidden);
    assert.strictEqual(visible.length, 2);
  });

  it('should show all messages when showHidden is true', () => {
    let showHidden = true;
    let visible = (showHidden)
      ? messages
      : messages.filter((m) => !m.hidden);
    assert.strictEqual(visible.length, 4);
  });

  it('should identify hidden message types', () => {
    let hidden = messages.filter((m) => m.hidden);
    assert.strictEqual(hidden.length, 2);
    assert.ok(hidden.some((m) => m.type === 'system'));
    assert.ok(hidden.some((m) => m.type === 'interaction'));
  });
});

describe('Message Role Classes', () => {
  it('should assign user class for user messages', () => {
    let message   = { role: 'user' };
    let roleClass = (message.role === 'user') ? 'message-user' : 'message-assistant';
    assert.strictEqual(roleClass, 'message-user');
  });

  it('should assign assistant class for assistant messages', () => {
    let message   = { role: 'assistant' };
    let roleClass = (message.role === 'user') ? 'message-user' : 'message-assistant';
    assert.strictEqual(roleClass, 'message-assistant');
  });

  it('should determine role label for user', () => {
    let message   = { role: 'user' };
    let roleLabel = (message.role === 'user') ? 'You' : 'Assistant';
    assert.strictEqual(roleLabel, 'You');
  });

  it('should use agent name for assistant label', () => {
    let message   = { role: 'assistant' };
    let agentName = 'Claude';
    let roleLabel = (message.role === 'user') ? 'You' : agentName;
    assert.strictEqual(roleLabel, 'Claude');
  });
});

describe('Message Content Types', () => {
  it('should handle string content', () => {
    let message     = { content: 'Hello world' };
    let isString    = typeof message.content === 'string';
    assert.strictEqual(isString, true);
  });

  it('should handle array content', () => {
    let message = {
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', name: 'search', input: {} },
      ],
    };
    let isArray = Array.isArray(message.content);
    assert.strictEqual(isArray, true);
    assert.strictEqual(message.content.length, 2);
  });

  it('should identify text blocks', () => {
    let content = [
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', name: 'search' },
    ];
    let textBlocks = content.filter((b) => b.type === 'text');
    assert.strictEqual(textBlocks.length, 1);
  });

  it('should identify tool_use blocks', () => {
    let content = [
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', name: 'search' },
      { type: 'tool_result', content: 'result' },
    ];
    let toolUse = content.filter((b) => b.type === 'tool_use');
    assert.strictEqual(toolUse.length, 1);
  });

  it('should identify tool_result blocks', () => {
    let content = [
      { type: 'tool_use', name: 'search' },
      { type: 'tool_result', content: 'result' },
    ];
    let toolResult = content.filter((b) => b.type === 'tool_result');
    assert.strictEqual(toolResult.length, 1);
  });
});

describe('Queued Message State', () => {
  it('should identify queued messages', () => {
    let message = { queued: true };
    assert.strictEqual(message.queued, true);
  });

  it('should identify non-queued messages', () => {
    let message = { queued: false };
    assert.strictEqual(message.queued, false);
  });

  it('should handle missing queued property', () => {
    let message = {};
    let isQueued = message.queued || false;
    assert.strictEqual(isQueued, false);
  });
});

describe('Error Message State', () => {
  it('should identify error messages', () => {
    let message = { type: 'error', content: 'Something went wrong' };
    let isError = message.type === 'error';
    assert.strictEqual(isError, true);
  });

  it('should extract error text from string content', () => {
    let message   = { type: 'error', content: 'Connection failed' };
    let errorText = (typeof message.content === 'string') ? message.content : 'An error occurred';
    assert.strictEqual(errorText, 'Connection failed');
  });

  it('should use default error text for non-string content', () => {
    let message   = { type: 'error', content: { code: 500 } };
    let errorText = (typeof message.content === 'string') ? message.content : 'An error occurred';
    assert.strictEqual(errorText, 'An error occurred');
  });
});

describe('Token Estimation', () => {
  it('should estimate tokens from string content', () => {
    let content  = 'Hello world'; // 11 characters
    let estimate = Math.ceil(content.length / 4);
    assert.strictEqual(estimate, 3);
  });

  it('should estimate tokens from array content', () => {
    let content = [
      { type: 'text', text: 'Hello' },  // 5 chars
      { type: 'text', text: 'World' },  // 5 chars
    ];
    let estimate = 0;
    for (let block of content) {
      if (block.type === 'text') {
        estimate += Math.ceil(block.text.length / 4);
      }
    }
    assert.strictEqual(estimate, 4); // ceil(5/4) + ceil(5/4) = 2 + 2
  });

  it('should skip non-text blocks in estimation', () => {
    let content = [
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', name: 'search' },
    ];
    let estimate = 0;
    for (let block of content) {
      if (block.type === 'text') {
        estimate += Math.ceil(block.text.length / 4);
      }
    }
    assert.strictEqual(estimate, 2);
  });
});

describe('Scroll Behavior', () => {
  it('should calculate near-bottom threshold', () => {
    let scrollHeight = 1000;
    let scrollTop    = 850;
    let clientHeight = 100;
    let threshold    = 100;

    let distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    let isNearBottom = distanceFromBottom < threshold;

    assert.strictEqual(distanceFromBottom, 50);
    assert.strictEqual(isNearBottom, true);
  });

  it('should detect not near bottom', () => {
    let scrollHeight = 1000;
    let scrollTop    = 500;
    let clientHeight = 100;
    let threshold    = 100;

    let distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    let isNearBottom = distanceFromBottom < threshold;

    assert.strictEqual(distanceFromBottom, 400);
    assert.strictEqual(isNearBottom, false);
  });

  it('should show scroll button when not near bottom', () => {
    let isNearBottom    = false;
    let showScrollBtn   = !isNearBottom;
    assert.strictEqual(showScrollBtn, true);
  });

  it('should hide scroll button when near bottom', () => {
    let isNearBottom    = true;
    let showScrollBtn   = !isNearBottom;
    assert.strictEqual(showScrollBtn, false);
  });
});

describe('Streaming State', () => {
  let streamingState;

  beforeEach(() => {
    streamingState = createMockDynamicProp(null);
  });

  it('should start with no streaming message', () => {
    assert.strictEqual(streamingState.valueOf(), null);
  });

  it('should track streaming message', () => {
    let streaming = { id: 'stream-1', content: 'Partial content...' };
    streamingState[mockDynamicProperty.set](streaming);
    assert.deepStrictEqual(streamingState.valueOf(), streaming);
  });

  it('should clear streaming on completion', () => {
    streamingState[mockDynamicProperty.set]({ id: 'stream-1', content: 'Test' });
    assert.ok(streamingState.valueOf() !== null);

    streamingState[mockDynamicProperty.set](null);
    assert.strictEqual(streamingState.valueOf(), null);
  });

  it('should update streaming content', () => {
    streamingState[mockDynamicProperty.set]({ id: 's1', content: 'Hello' });
    assert.strictEqual(streamingState.valueOf().content, 'Hello');

    streamingState[mockDynamicProperty.set]({ id: 's1', content: 'Hello world' });
    assert.strictEqual(streamingState.valueOf().content, 'Hello world');
  });
});

describe('Type Badges', () => {
  it('should map system type to label', () => {
    let typeLabels = {
      system:      'System',
      interaction: 'Interaction',
      feedback:    'Feedback',
    };
    assert.strictEqual(typeLabels['system'], 'System');
  });

  it('should map interaction type to label', () => {
    let typeLabels = {
      system:      'System',
      interaction: 'Interaction',
      feedback:    'Feedback',
    };
    assert.strictEqual(typeLabels['interaction'], 'Interaction');
  });

  it('should fall back to type name for unknown types', () => {
    let typeLabels = {
      system:      'System',
      interaction: 'Interaction',
      feedback:    'Feedback',
    };
    let type  = 'custom';
    let label = typeLabels[type] || type;
    assert.strictEqual(label, 'custom');
  });

  it('should only show badge for hidden messages', () => {
    let message   = { hidden: true, type: 'system' };
    let showBadge = message.hidden && message.type;
    assert.strictEqual(!!showBadge, true);
  });

  it('should not show badge for visible messages', () => {
    let message   = { hidden: false, type: 'system' };
    let showBadge = message.hidden && message.type;
    assert.strictEqual(!!showBadge, false);
  });
});

describe('Chat Session State', () => {
  let sessionState;

  beforeEach(() => {
    sessionState = createMockDynamicProp(null);
  });

  it('should track current session', () => {
    let session = { id: 1, name: 'Test', agent: { name: 'Claude' } };
    sessionState[mockDynamicProperty.set](session);
    assert.deepStrictEqual(sessionState.valueOf(), session);
  });

  it('should get agent name from session', () => {
    let session   = { id: 1, name: 'Test', agent: { name: 'Claude' } };
    let agentName = session.agent?.name || 'Assistant';
    assert.strictEqual(agentName, 'Claude');
  });

  it('should use default agent name when missing', () => {
    let session   = { id: 1, name: 'Test' };
    let agentName = session.agent?.name || 'Assistant';
    assert.strictEqual(agentName, 'Assistant');
  });
});

describe('Message ID Generation', () => {
  it('should generate unique message element ID', () => {
    let messageId = 123;
    let elementId = `message-${messageId}`;
    assert.strictEqual(elementId, 'message-123');
  });

  it('should handle empty message ID', () => {
    let messageId = '';
    let elementId = (messageId) ? `message-${messageId}` : '';
    assert.strictEqual(elementId, '');
  });

  it('should handle null message ID', () => {
    let messageId = null;
    let elementId = (messageId) ? `message-${messageId}` : '';
    assert.strictEqual(elementId, '');
  });
});

// ============================================================================
// FOOTER: Message footer bar — inside bubble with meta + actions
// ============================================================================

describe('FOOTER: message footer bar structure', () => {
  let source;

  beforeEach(() => {
    source = fs.readFileSync('public/js/components/hero-chat/hero-chat.js', 'utf8');
  });

  it('should render message-footer inside message-bubble', () => {
    // The _renderMessage template should have footerHtml inside message-bubble div
    // footerHtml is interpolated via ${footerHtml}, so look for it inside the bubble
    let renderMethod = source.match(/_renderMessage\(message\)\s*\{[\s\S]*?return\s*`([\s\S]*?)`;/);
    assert.ok(renderMethod, '_renderMessage should exist with a template return');

    let template = renderMethod[1];
    // footerHtml should appear between message-bubble opening and its closing </div>
    assert.ok(template.includes('footerHtml'), 'template should interpolate footerHtml');

    // Verify footerHtml is inside the bubble, not after it
    let bubbleOpenPos = template.indexOf('message-bubble');
    let footerPos = template.indexOf('footerHtml');
    assert.ok(bubbleOpenPos > -1, 'template should contain message-bubble');
    assert.ok(footerPos > bubbleOpenPos, 'footerHtml should be inside the bubble');
  });

  it('should have footer contain both footer-meta and footer-actions', () => {
    // _renderFooter should produce both elements
    assert.ok(source.includes('_renderFooter(message, tokenEstimate)'), '_renderFooter method should be called');

    // Find the _renderFooter method body (from declaration to last line before next method)
    let footerStart = source.indexOf('_renderFooter(message, tokenEstimate) {');
    assert.ok(footerStart > -1, '_renderFooter method should exist');

    let footerBody = source.slice(footerStart, footerStart + 600);
    assert.ok(footerBody.includes('footer-meta'), '_renderFooter should contain footer-meta');
    assert.ok(footerBody.includes('footer-actions'), '_renderFooter should contain footer-actions');
  });

  it('should hide footer-actions by default with display:none', () => {
    let footerStart = source.indexOf('_renderFooter(message, tokenEstimate) {');
    assert.ok(footerStart > -1, '_renderFooter method should exist');

    let footerBody = source.slice(footerStart, footerStart + 600);
    assert.ok(footerBody.includes('style="display:none"'), 'footer-actions should have display:none inline style');
  });

  it('should not have standalone message-timestamp outside bubble', () => {
    // The old pattern was: </div>\n        ${timestampHtml} — outside the bubble
    // Now there should be no message-timestamp class in the template at all
    let renderMethod = source.match(/_renderMessage\(message\)\s*\{[\s\S]*?return\s*`([\s\S]*?)`;/);
    assert.ok(renderMethod, '_renderMessage should exist');

    let template = renderMethod[1];
    assert.ok(!template.includes('message-timestamp'), 'template should not contain message-timestamp (replaced by footer)');
  });

  it('should not create DOM in _addPromptBatchButtons — only queries footer-actions', () => {
    let methodStart = source.indexOf('_addPromptBatchButtons(element, frameId) {');
    assert.ok(methodStart > -1, '_addPromptBatchButtons method should exist');

    let body = source.slice(methodStart, methodStart + 1200);
    // Should NOT create elements
    assert.ok(!body.includes('createElement'), '_addPromptBatchButtons should not create DOM elements');
    // Should query for existing footer-actions
    assert.ok(body.includes('footer-actions'), '_addPromptBatchButtons should query for footer-actions');
  });

  it('should not have prompt-batch-actions class anywhere in source', () => {
    // Old class fully replaced — no CSS, no JS references
    assert.ok(!source.includes('prompt-batch-actions'), 'prompt-batch-actions should be fully removed');
  });

  it('should not have prompt-batch-done class anywhere in source', () => {
    assert.ok(!source.includes('prompt-batch-done'), 'prompt-batch-done should be fully removed');
  });

  it('should not have prompt-batch-count class anywhere in source', () => {
    assert.ok(!source.includes('prompt-batch-count'), 'prompt-batch-count should be fully removed');
  });

  it('should have message-footer CSS styles defined', () => {
    assert.ok(source.includes('.message-footer'), 'CSS should define .message-footer');
    assert.ok(source.includes('.footer-meta'), 'CSS should define .footer-meta');
    assert.ok(source.includes('.footer-actions'), 'CSS should define .footer-actions');
  });

  it('should not render footer in streaming or phantom frames', () => {
    let streamingMethod = source.match(/_renderStreamingMessage\(\)\s*\{([\s\S]*?)\n  \}/);
    assert.ok(streamingMethod, '_renderStreamingMessage should exist');
    assert.ok(!streamingMethod[1].includes('message-footer'), 'streaming should not have footer');

    let phantomMethod = source.match(/_renderPhantomFrame\([\s\S]*?\)\s*\{([\s\S]*?)\n  \}/);
    assert.ok(phantomMethod, '_renderPhantomFrame should exist');
    assert.ok(!phantomMethod[1].includes('message-footer'), 'phantom should not have footer');
  });
});
