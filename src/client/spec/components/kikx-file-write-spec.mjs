'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// jsdom setup — fresh instance per test with custom element registered
// ---------------------------------------------------------------------------

let dom;

function setupDOM() {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url:               'http://localhost/kikx/',
    pretendToBeVisual: true,
  });

  registerComponent();
}

function teardownDOM() {
  if (dom)
    dom.window.close();

  dom = null;
}

// ---------------------------------------------------------------------------
// Test-local component definition
// ---------------------------------------------------------------------------

function registerComponent() {
  let JsdomHTMLElement = dom.window.HTMLElement;

  class KikxFileWrite extends JsdomHTMLElement {
    static get observedAttributes() {
      return ['file-path', 'created'];
    }

    constructor() {
      super();
      this._expanded      = false;
      this._diff          = null;
      this._onHeaderClick = this._onHeaderClick.bind(this);
    }

    connectedCallback() {
      if (this._initialized) return;
      this._initialized = true;

      this.innerHTML = `
        <button class="file-header">
          <span class="collapse-indicator">\u25B6</span>
          <span class="file-icon">\u270F\uFE0F</span>
          <span class="file-path"></span>
          <span class="diff-stats">
            <span class="additions"></span>
            <span class="removals"></span>
          </span>
          <span class="status-badge"></span>
        </button>
        <div class="file-body">
          <div class="diff-lines"></div>
        </div>
      `;

      this._header            = this.querySelector('.file-header');
      this._collapseIndicator = this.querySelector('.collapse-indicator');
      this._filePathElement   = this.querySelector('.file-path');
      this._additionsElement  = this.querySelector('.diff-stats .additions');
      this._removalsElement   = this.querySelector('.diff-stats .removals');
      this._statusBadge       = this.querySelector('.status-badge');
      this._body              = this.querySelector('.file-body');
      this._diffContainer     = this.querySelector('.diff-lines');

      this._header.addEventListener('click', this._onHeaderClick);
      this._render();
    }

    disconnectedCallback() {
      if (this._header)
        this._header.removeEventListener('click', this._onHeaderClick);
    }

    attributeChangedCallback() {
      if (this.isConnected)
        this._render();
    }

    get diff() { return this._diff; }
    set diff(value) {
      this._diff = value;
      this._render();
    }

    toggle() {
      if (this._expanded) this.collapse();
      else this.expand();
    }

    expand() {
      this._expanded = true;
      this._body.classList.add('expanded');
      this._collapseIndicator.classList.add('expanded');
    }

    collapse() {
      this._expanded = false;
      this._body.classList.remove('expanded');
      this._collapseIndicator.classList.remove('expanded');
    }

    _onHeaderClick() { this.toggle(); }

    _render() {
      this._renderHeader();
      this._renderDiff();
    }

    _renderHeader() {
      if (!this._filePathElement) return;
      this._filePathElement.textContent = this.getAttribute('file-path') || '';

      let isCreated = this.hasAttribute('created');
      this._statusBadge.textContent = (isCreated) ? 'Created' : 'Modified';
      this._statusBadge.className   = 'status-badge ' + ((isCreated) ? 'created' : 'modified');

      let diff = this._diff;
      if (diff) {
        let additions = diff.additions || 0;
        let removals  = diff.removals || 0;
        this._additionsElement.textContent = (additions > 0) ? `+${additions}` : '';
        this._removalsElement.textContent  = (removals > 0) ? `-${removals}` : '';
      } else {
        this._additionsElement.textContent = '';
        this._removalsElement.textContent  = '';
      }
    }

    _renderDiff() {
      if (!this._diffContainer) return;

      let diff = this._diff;
      if (!diff || !diff.hunks || diff.hunks.length === 0) {
        this._diffContainer.innerHTML = '';
        return;
      }

      let doc      = this.ownerDocument;
      let fragment = doc.createDocumentFragment();

      for (let hunkIndex = 0; hunkIndex < diff.hunks.length; hunkIndex++) {
        let hunk = diff.hunks[hunkIndex];

        if (hunkIndex > 0) {
          let separator = doc.createElement('span');
          separator.className = 'hunk-separator';
          separator.textContent = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
          fragment.appendChild(separator);
        }

        for (let line of hunk.lines) {
          let span = doc.createElement('span');
          span.className = `diff-line ${line.type}`;

          let gutter = doc.createElement('span');
          gutter.className = 'gutter';
          let oldNum = (line.oldLine !== null) ? String(line.oldLine) : '';
          let newNum = (line.newLine !== null) ? String(line.newLine) : '';
          gutter.textContent = `${oldNum.padStart(4, ' ')} ${newNum.padStart(4, ' ')}`;

          let prefix = doc.createElement('span');
          prefix.className = 'prefix';
          if (line.type === 'add') prefix.textContent = '+';
          else if (line.type === 'remove') prefix.textContent = '-';
          else prefix.textContent = ' ';

          span.appendChild(gutter);
          span.appendChild(prefix);
          span.appendChild(doc.createTextNode(line.content));
          fragment.appendChild(span);
        }
      }

      this._diffContainer.innerHTML = '';
      this._diffContainer.appendChild(fragment);
    }
  }

  dom.window.customElements.define('kikx-file-write', KikxFileWrite);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('kikx-file-write', () => {
  let element;

  beforeEach(() => {
    setupDOM();
    element = dom.window.document.createElement('kikx-file-write');
    dom.window.document.body.appendChild(element);
  });

  afterEach(() => {
    if (element && element.parentNode)
      element.parentNode.removeChild(element);

    teardownDOM();
  });

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  it('registers as a custom element', () => {
    let registered = dom.window.customElements.get('kikx-file-write');
    assert.ok(registered, 'kikx-file-write should be registered');
  });

  // -------------------------------------------------------------------------
  // Template rendering
  // -------------------------------------------------------------------------

  it('renders template on connect', () => {
    assert.ok(element.innerHTML.length > 0);
    assert.ok(element.querySelector('.file-header'));
    assert.ok(element.querySelector('.file-body'));
    assert.ok(element.querySelector('.diff-lines'));
  });

  // -------------------------------------------------------------------------
  // Default state — collapsed
  // -------------------------------------------------------------------------

  it('starts collapsed by default', () => {
    let body = element.querySelector('.file-body');
    assert.ok(!body.classList.contains('expanded'));
  });

  // -------------------------------------------------------------------------
  // File path display
  // -------------------------------------------------------------------------

  it('displays file path from attribute', () => {
    element.setAttribute('file-path', '/src/core/index.mjs');
    let pathElement = element.querySelector('.file-path');
    assert.equal(pathElement.textContent, '/src/core/index.mjs');
  });

  // -------------------------------------------------------------------------
  // Status badge — Created vs Modified
  // -------------------------------------------------------------------------

  it('shows Created badge when created attribute is set', () => {
    element.setAttribute('created', '');
    let badge = element.querySelector('.status-badge');
    assert.equal(badge.textContent, 'Created');
    assert.ok(badge.classList.contains('created'));
  });

  it('shows Modified badge when created attribute is absent', () => {
    let badge = element.querySelector('.status-badge');
    assert.equal(badge.textContent, 'Modified');
    assert.ok(badge.classList.contains('modified'));
  });

  // -------------------------------------------------------------------------
  // Diff stats display
  // -------------------------------------------------------------------------

  it('displays additions and removals counts', () => {
    element.diff = {
      additions: 5,
      removals:  3,
      hunks:     [],
    };

    let additions = element.querySelector('.additions');
    let removals  = element.querySelector('.removals');
    assert.equal(additions.textContent, '+5');
    assert.equal(removals.textContent, '-3');
  });

  it('hides stats when diff has no changes', () => {
    element.diff = { additions: 0, removals: 0, hunks: [] };
    let additions = element.querySelector('.additions');
    let removals  = element.querySelector('.removals');
    assert.equal(additions.textContent, '');
    assert.equal(removals.textContent, '');
  });

  it('hides stats when diff is null', () => {
    element.diff = null;
    let additions = element.querySelector('.additions');
    let removals  = element.querySelector('.removals');
    assert.equal(additions.textContent, '');
    assert.equal(removals.textContent, '');
  });

  // -------------------------------------------------------------------------
  // Toggle / expand / collapse
  // -------------------------------------------------------------------------

  it('clicking header toggles expanded state', () => {
    let header = element.querySelector('.file-header');
    let body   = element.querySelector('.file-body');

    assert.ok(!body.classList.contains('expanded'));

    header.click();
    assert.ok(body.classList.contains('expanded'));

    header.click();
    assert.ok(!body.classList.contains('expanded'));
  });

  it('expand() and collapse() work correctly', () => {
    let body = element.querySelector('.file-body');

    element.expand();
    assert.ok(body.classList.contains('expanded'));

    element.collapse();
    assert.ok(!body.classList.contains('expanded'));
  });

  // -------------------------------------------------------------------------
  // Diff rendering
  // -------------------------------------------------------------------------

  it('renders diff lines with correct types', () => {
    element.diff = {
      additions: 1,
      removals:  1,
      hunks: [{
        oldStart: 1, oldCount: 3, newStart: 1, newCount: 3,
        lines: [
          { type: 'context', content: 'aaa', oldLine: 1, newLine: 1 },
          { type: 'remove',  content: 'bbb', oldLine: 2, newLine: null },
          { type: 'add',     content: 'BBB', oldLine: null, newLine: 2 },
          { type: 'context', content: 'ccc', oldLine: 3, newLine: 3 },
        ],
      }],
    };

    let diffLines = element.querySelectorAll('.diff-line');
    assert.equal(diffLines.length, 4);

    assert.ok(diffLines[0].classList.contains('context'));
    assert.ok(diffLines[1].classList.contains('remove'));
    assert.ok(diffLines[2].classList.contains('add'));
    assert.ok(diffLines[3].classList.contains('context'));
  });

  it('renders prefix characters (+, -, space)', () => {
    element.diff = {
      additions: 1,
      removals:  1,
      hunks: [{
        oldStart: 1, oldCount: 2, newStart: 1, newCount: 2,
        lines: [
          { type: 'remove', content: 'old', oldLine: 1, newLine: null },
          { type: 'add',    content: 'new', oldLine: null, newLine: 1 },
          { type: 'context', content: 'same', oldLine: 2, newLine: 2 },
        ],
      }],
    };

    let prefixes = element.querySelectorAll('.prefix');
    assert.equal(prefixes[0].textContent, '-');
    assert.equal(prefixes[1].textContent, '+');
    assert.equal(prefixes[2].textContent, ' ');
  });

  it('renders hunk separators between multiple hunks', () => {
    element.diff = {
      additions: 2,
      removals:  0,
      hunks: [
        {
          oldStart: 1, oldCount: 1, newStart: 1, newCount: 1,
          lines: [{ type: 'add', content: 'a', oldLine: null, newLine: 1 }],
        },
        {
          oldStart: 20, oldCount: 1, newStart: 21, newCount: 1,
          lines: [{ type: 'add', content: 'b', oldLine: null, newLine: 21 }],
        },
      ],
    };

    let separators = element.querySelectorAll('.hunk-separator');
    assert.equal(separators.length, 1);
    assert.ok(separators[0].textContent.includes('@@'));
  });

  it('clears diff when set to null', () => {
    element.diff = {
      additions: 1, removals: 0,
      hunks: [{ oldStart: 1, oldCount: 0, newStart: 1, newCount: 1, lines: [{ type: 'add', content: 'x', oldLine: null, newLine: 1 }] }],
    };

    assert.ok(element.querySelectorAll('.diff-line').length > 0);

    element.diff = null;
    assert.equal(element.querySelector('.diff-lines').innerHTML, '');
  });

  it('renders gutter with line numbers', () => {
    element.diff = {
      additions: 1,
      removals:  0,
      hunks: [{
        oldStart: 5, oldCount: 1, newStart: 5, newCount: 2,
        lines: [
          { type: 'context', content: 'ctx', oldLine: 5, newLine: 5 },
          { type: 'add',     content: 'new', oldLine: null, newLine: 6 },
        ],
      }],
    };

    let gutters = element.querySelectorAll('.gutter');
    assert.equal(gutters.length, 2);

    // Context line should show both old and new line numbers
    assert.ok(gutters[0].textContent.includes('5'));

    // Add line should show only new line number
    assert.ok(gutters[1].textContent.includes('6'));
  });

  // -------------------------------------------------------------------------
  // Real module exports
  // -------------------------------------------------------------------------

  it('real module exports a class constructor', async () => {
    globalThis.HTMLElement    = dom.window.HTMLElement;
    globalThis.customElements = { define() {}, get() {} };
    globalThis.document       = dom.window.document;

    try {
      let mod = await import('../../components/kikx-file-write/kikx-file-write.mjs');
      assert.equal(typeof mod.default, 'function');
    } finally {
      delete globalThis.HTMLElement;
      delete globalThis.customElements;
      delete globalThis.document;
    }
  });
});
