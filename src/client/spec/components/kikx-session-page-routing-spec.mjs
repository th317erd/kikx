'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// =============================================================================
// createFrameElement — tool-activity routing tests
// =============================================================================
// Tests that the exported createFrameElement() function correctly routes
// tool-activity frames to the appropriate WebComponents based on renderType.
// =============================================================================

let dom;
let createFrameElement;

async function setupDOM() {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url:               'http://localhost/kikx/sessions/test',
    pretendToBeVisual: true,
  });

  // Register stub custom elements so createElement doesn't fail
  let JsdomHTMLElement = dom.window.HTMLElement;

  // kikx-interaction — wrapper element
  class KikxInteraction extends JsdomHTMLElement {
    connectedCallback() {}
  }

  // kikx-file-read — stub
  class KikxFileRead extends JsdomHTMLElement {
    constructor() {
      super();
      this._fileContent = '';
      this._lineCount   = 0;
      this._totalLines  = 0;
      this._offset      = 0;
    }

    get fileContent() { return this._fileContent; }
    set fileContent(value) { this._fileContent = value; }

    get lineCount() { return this._lineCount; }
    set lineCount(value) { this._lineCount = value; }

    get totalLines() { return this._totalLines; }
    set totalLines(value) { this._totalLines = value; }

    get offset() { return this._offset; }
    set offset(value) { this._offset = value; }

    connectedCallback() {}
  }

  // kikx-file-write — stub
  class KikxFileWrite extends JsdomHTMLElement {
    constructor() {
      super();
      this._diff = null;
    }

    get diff() { return this._diff; }
    set diff(value) { this._diff = value; }

    connectedCallback() {}
  }

  // kikx-command-result — stub (fallback)
  class KikxCommandResult extends JsdomHTMLElement {
    constructor() {
      super();
      this._result = '';
    }

    get result() { return this._result; }
    set result(value) { this._result = value; }

    connectedCallback() {}
  }

  // kikx-message-content — stub
  class KikxMessageContent extends JsdomHTMLElement {
    constructor() {
      super();
      this._content = '';
    }

    get content() { return this._content; }
    set content(value) { this._content = value; }

    connectedCallback() {}
  }

  // kikx-reflection-block — stub
  class KikxReflectionBlock extends JsdomHTMLElement {
    constructor() {
      super();
      this._content = '';
    }

    get content() { return this._content; }
    set content(value) { this._content = value; }

    connectedCallback() {}
  }

  dom.window.customElements.define('kikx-interaction', KikxInteraction);
  dom.window.customElements.define('kikx-file-read', KikxFileRead);
  dom.window.customElements.define('kikx-file-write', KikxFileWrite);
  dom.window.customElements.define('kikx-command-result', KikxCommandResult);
  dom.window.customElements.define('kikx-message-content', KikxMessageContent);
  dom.window.customElements.define('kikx-reflection-block', KikxReflectionBlock);

  // Set up globals that createFrameElement needs
  globalThis.HTMLElement    = JsdomHTMLElement;
  globalThis.customElements = dom.window.customElements;
  globalThis.document       = dom.window.document;

  // Minimal store mock for t() function
  globalThis.window = dom.window;

  // Import the real createFrameElement
  let mod = await import('../../components/kikx-session-page/kikx-session-page.mjs');
  createFrameElement = mod.createFrameElement;
}

function teardownDOM() {
  delete globalThis.HTMLElement;
  delete globalThis.customElements;
  delete globalThis.document;
  delete globalThis.window;

  if (dom)
    dom.window.close();

  dom                = null;
  createFrameElement = null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createFrameElement — tool-activity routing', () => {

  beforeEach(async () => {
    await setupDOM();
  });

  afterEach(() => {
    teardownDOM();
  });

  // -------------------------------------------------------------------------
  // file-read renderType → kikx-file-read element
  // -------------------------------------------------------------------------

  it('routes file-read renderType to kikx-file-read element', () => {
    let frame = {
      id:            'frm_test1',
      type:          'tool-activity',
      interactionID: 'int_test1',
      authorType:    'system',
      content: {
        toolName:   'files:read',
        renderType: 'file-read',
        renderData: {
          filePath:   '/src/core/index.mjs',
          content:    'let x = 1;\nlet y = 2;\n',
          lineCount:  2,
          totalLines: 100,
          offset:     0,
          truncated:  true,
          language:   'javascript',
        },
      },
    };

    let element = createFrameElement(frame);

    assert.ok(element, 'Should return an element');
    assert.equal(element.tagName.toLowerCase(), 'kikx-interaction');

    let fileRead = element.querySelector('kikx-file-read');
    assert.ok(fileRead, 'Should contain a kikx-file-read child');
    assert.equal(fileRead.getAttribute('file-path'), '/src/core/index.mjs');
    assert.equal(fileRead.getAttribute('language'), 'javascript');
    assert.equal(fileRead.fileContent, 'let x = 1;\nlet y = 2;\n');
    assert.equal(fileRead.lineCount, 2);
    assert.equal(fileRead.totalLines, 100);
    assert.equal(fileRead.offset, 0);
  });

  // -------------------------------------------------------------------------
  // file-write renderType → kikx-file-write element (modified)
  // -------------------------------------------------------------------------

  it('routes file-write renderType to kikx-file-write element', () => {
    let diff = {
      hunks: [{
        oldStart: 1, oldCount: 3, newStart: 1, newCount: 3,
        lines: [
          { type: 'context', content: 'aaa', oldLine: 1, newLine: 1 },
          { type: 'remove', content: 'bbb', oldLine: 2, newLine: null },
          { type: 'add', content: 'BBB', oldLine: null, newLine: 2 },
          { type: 'context', content: 'ccc', oldLine: 3, newLine: 3 },
        ],
      }],
      additions: 1,
      removals:  1,
    };

    let frame = {
      id:            'frm_test2',
      type:          'tool-activity',
      interactionID: 'int_test2',
      authorType:    'system',
      content: {
        toolName:   'files:write',
        renderType: 'file-write',
        renderData: {
          filePath: '/src/core/config.mjs',
          created:  false,
          diff,
          language: 'javascript',
        },
      },
    };

    let element = createFrameElement(frame);

    assert.ok(element);
    let fileWrite = element.querySelector('kikx-file-write');
    assert.ok(fileWrite, 'Should contain a kikx-file-write child');
    assert.equal(fileWrite.getAttribute('file-path'), '/src/core/config.mjs');
    assert.equal(fileWrite.hasAttribute('created'), false, 'Should NOT have created attribute when created=false');
    assert.deepStrictEqual(fileWrite.diff, diff);
  });

  // -------------------------------------------------------------------------
  // file-write with created=true → sets created attribute
  // -------------------------------------------------------------------------

  it('sets created attribute on kikx-file-write when created is true', () => {
    let frame = {
      id:            'frm_test3',
      type:          'tool-activity',
      interactionID: 'int_test3',
      authorType:    'system',
      content: {
        toolName:   'files:write',
        renderType: 'file-write',
        renderData: {
          filePath: '/src/new-file.mjs',
          created:  true,
          diff:     { hunks: [], additions: 5, removals: 0 },
        },
      },
    };

    let element   = createFrameElement(frame);
    let fileWrite = element.querySelector('kikx-file-write');

    assert.ok(fileWrite);
    assert.ok(fileWrite.hasAttribute('created'), 'Should have created attribute');
  });

  // -------------------------------------------------------------------------
  // Unknown renderType → fallback to kikx-command-result
  // -------------------------------------------------------------------------

  it('falls back to kikx-command-result for unknown renderType', () => {
    let frame = {
      id:            'frm_test4',
      type:          'tool-activity',
      interactionID: 'int_test4',
      authorType:    'system',
      content: {
        toolName:   'custom:tool',
        renderType: 'some-unknown-type',
        renderData: { foo: 'bar' },
      },
    };

    let element       = createFrameElement(frame);
    let commandResult = element.querySelector('kikx-command-result');

    assert.ok(commandResult, 'Should fall back to kikx-command-result');
    assert.equal(commandResult.getAttribute('command-name'), 'custom:tool');
    assert.equal(commandResult.getAttribute('status'), 'success');
    assert.ok(commandResult.result.includes('foo'));
    assert.ok(commandResult.result.includes('bar'));
  });

  // -------------------------------------------------------------------------
  // tool-activity is in RENDERABLE_TYPES (not rejected)
  // -------------------------------------------------------------------------

  it('does not reject tool-activity frames', () => {
    let frame = {
      id:            'frm_test5',
      type:          'tool-activity',
      interactionID: 'int_test5',
      authorType:    'system',
      content: {
        toolName:   'files:read',
        renderType: 'file-read',
        renderData: { filePath: '/test' },
      },
    };

    let element = createFrameElement(frame);
    assert.ok(element, 'tool-activity should be renderable, not rejected');
  });

  // -------------------------------------------------------------------------
  // Hidden types are still rejected
  // -------------------------------------------------------------------------

  it('rejects tool-result frames (hidden type)', () => {
    let frame = {
      id:            'frm_hidden',
      type:          'tool-result',
      interactionID: 'int_hidden',
      content:       { output: 'some output' },
    };

    let element = createFrameElement(frame);
    assert.equal(element, null, 'tool-result should be rejected (hidden type)');
  });

  // -------------------------------------------------------------------------
  // Alignment is 'agent' for tool-activity frames
  // -------------------------------------------------------------------------

  it('sets alignment to agent for tool-activity frames', () => {
    let frame = {
      id:            'frm_test6',
      type:          'tool-activity',
      interactionID: 'int_test6',
      authorType:    'system',
      content: {
        toolName:   'files:read',
        renderType: 'file-read',
        renderData: { filePath: '/test' },
      },
    };

    let element = createFrameElement(frame);
    assert.equal(element.getAttribute('alignment'), 'agent');
  });

  // -------------------------------------------------------------------------
  // file-read without language attribute
  // -------------------------------------------------------------------------

  it('omits language attribute when renderData has no language', () => {
    let frame = {
      id:            'frm_test7',
      type:          'tool-activity',
      interactionID: 'int_test7',
      authorType:    'system',
      content: {
        toolName:   'files:read',
        renderType: 'file-read',
        renderData: {
          filePath:  '/test.txt',
          content:   'hello',
          lineCount: 1,
        },
      },
    };

    let element  = createFrameElement(frame);
    let fileRead = element.querySelector('kikx-file-read');

    assert.ok(fileRead);
    assert.equal(fileRead.hasAttribute('language'), false);
  });

  // -------------------------------------------------------------------------
  // file-write diff is null when not provided
  // -------------------------------------------------------------------------

  it('sets diff to null when renderData has no diff', () => {
    let frame = {
      id:            'frm_test8',
      type:          'tool-activity',
      interactionID: 'int_test8',
      authorType:    'system',
      content: {
        toolName:   'files:write',
        renderType: 'file-write',
        renderData: { filePath: '/test.txt' },
      },
    };

    let element   = createFrameElement(frame);
    let fileWrite = element.querySelector('kikx-file-write');

    assert.ok(fileWrite);
    assert.equal(fileWrite.diff, null);
  });
});
