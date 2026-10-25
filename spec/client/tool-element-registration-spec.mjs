'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { CustomElementRegistry, installDom } from './support/mini-dom.mjs';

// aeor-ui.mjs reaches browser-only modules through /vendor/... imports; the same
// stand-ins the other client specs use are enough here because this spec only
// evaluates the registration module, it never renders a card.
register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { registry: customElements } = installDom();

// Importing for side effects is the whole point: `built-in-tool-uses.mjs` calls
// `defineToolElement()` at module scope, so any throw during evaluation is a
// failure this spec must see rather than swallow.
const moduleNamespace = await import('../../src/client/components/tool-renderers/built-in-tool-uses.mjs');
const scriptToolUse = await import('../../src/client/components/tool-renderers/script-tool-use.mjs');

const EXPECTED_TAGS = [
  'kikx-cwd-tool-use',
  'kikx-feedback-tool-use',
  'kikx-shell-tool-use',
  'kikx-script-tool-use',
  'kikx-tag-tool-use',
  'kikx-web-search-use',
  'kikx-fetch-use',
  'kikx-read-file-use',
  'kikx-question-list-use',
  'kikx-write-file-use',
  'kikx-output-read-use',
  'kikx-output-grep-use',
  'kikx-exec-list-use',
  'kikx-exec-status-use',
  'kikx-exec-read-use',
  'kikx-exec-grep-use',
  'kikx-exec-kill-use',
  'kikx-session-tool-use',
  'kikx-agent-tool-use',
  'kikx-todo-tool-use',
];

// The outage this spec exists for: `kikx-question-list-use` was registered with
// the `ReadFileUse` constructor that was ALREADY bound to `kikx-read-file-use`.
// `customElements.define()` throws on constructor reuse, the throw aborted
// module evaluation partway through, and the dynamic import in
// `loadClientComponentDescriptors()` propagated it — so the app recorded zero
// frame component descriptors and every Question frame degraded to bare text
// with no answer box. Every assertion below is a property that regression broke.
test('every built-in tool tag registers without throwing', () => {
  for (let tagName of EXPECTED_TAGS)
    assert.ok(customElements.get(tagName), `expected <${tagName}> to be defined`);
});

test('no two tag names share one constructor', () => {
  let byConstructor = new Map();

  for (let tagName of EXPECTED_TAGS) {
    let ctor = customElements.get(tagName);
    assert.ok(ctor, `expected <${tagName}> to be defined`);

    let previous = byConstructor.get(ctor);
    assert.equal(
      previous,
      undefined,
      `<${tagName}> reuses the constructor already bound to <${previous}>; ` +
      'customElements.define() rejects that and aborts module evaluation',
    );
    byConstructor.set(ctor, tagName);
  }
});

test('the script renderer exposes the start command and every source file', () => {
  let entries = scriptToolUse.scriptSourceEntries({
    start: 'bash probe.sh',
    files: [
      { path: 'probe.sh', content: 'echo probe\n', encoding: 'utf8' },
      { path: 'payload.bin', content: 'AAEC', encoding: 'base64' },
    ],
  });

  assert.deepEqual(entries, [
    { label: 'start', content: 'bash probe.sh' },
    { label: 'probe.sh', content: 'echo probe\n' },
    { label: 'payload.bin', content: '[base64]\nAAEC' },
  ]);

  assert.deepEqual(scriptToolUse.scriptSourceEntries({
    script: 'console.log(1)',
    packageJson: { type: 'module' },
  }), [
    { label: 'index.mjs', content: 'console.log(1)' },
    { label: 'package.json', content: '{\n  "type": "module"\n}' },
  ]);
});

test('the script result card can expand to the start command and source files', () => {
  let ScriptToolUse = customElements.get('kikx-script-tool-use');
  let instance = new ScriptToolUse();
  instance._frame = {
    id: 'script-result',
    type: 'ScriptToolFrame',
    content: {
      toolName: 'exec-script',
      phase: 'result',
      status: 'success',
      input: {
        start: 'bash probe.sh',
        files: [ { path: 'probe.sh', content: 'echo probe\n' } ],
      },
    },
  };

  let section = instance.renderToolSpecificSections();
  assert.ok(section, 'expected a script source disclosure');
  assert.equal(section.querySelector('summary')?.textContent, 'View script source');

  section.open = true;
  section.dispatchEvent(new Event('toggle'));
  assert.match(section.textContent, /bash probe\.sh/);
  assert.match(section.textContent, /probe\.sh/);
  assert.match(section.textContent, /echo probe/);
});

test('question-list has its own renderer, not the read-file one', () => {
  let questionList = customElements.get('kikx-question-list-use');
  let readFile = customElements.get('kikx-read-file-use');

  assert.ok(questionList, 'expected <kikx-question-list-use> to be defined');
  assert.notEqual(questionList, readFile, 'question-list must not alias the read-file element');
  assert.equal(questionList.toolName, 'question-list');
  assert.equal(readFile.toolName, 'read-file');
});

test('the renderer reports what it lists, not "Reading file"', () => {
  let QuestionListUse = customElements.get('kikx-question-list-use');
  let instance = new QuestionListUse();

  assert.equal(instance.displayName(), 'List questions');
  assert.equal(instance.callSummary(), 'Listing open questions...');
});

test('a failing define does not take the later tags down with it', async () => {
  // The outage, reproduced at the registration layer: bind a built-in
  // constructor to a foreign tag so that the module's own
  // `defineToolElement('kikx-read-file-use', ReadFileUse)` throws
  // constructor-reuse — the exact error the browser raised. The guard must
  // swallow it and keep going, because an unaborted throw is what left the app
  // with zero frame component descriptors and every Question frame as bare text.
  let poisoned = new CustomElementRegistry();
  poisoned.define('kikx-spec-poison', moduleNamespace.ReadFileUse);

  let originalCustomElements = globalThis.customElements;
  let originalError = console.error;
  let logged = [];
  console.error = (...args) => logged.push(args.join(' '));

  try {
    globalThis.customElements = poisoned;
    // Cache-busted so this is a second, independent evaluation of the module
    // against the poisoned registry rather than a no-op replay.
    await import(new URL('../../src/client/components/tool-renderers/built-in-tool-uses.mjs?poisoned=1', import.meta.url).href);
  } finally {
    globalThis.customElements = originalCustomElements;
    console.error = originalError;
  }

  assert.equal(
    poisoned.get('kikx-read-file-use'),
    undefined,
    'the poisoned tag is expected to fail; this test is pointless otherwise',
  );
  assert.equal(logged.length, 1, `expected one warning, got ${logged.length}: ${logged.join(' | ')}`);
  assert.match(logged[0], /kikx-read-file-use/);

  // Every tag registered AFTER the failing one must still be present. This is
  // the assertion the outage violates, and the one the previous test name
  // promised without checking.
  let survivors = EXPECTED_TAGS.slice(EXPECTED_TAGS.indexOf('kikx-write-file-use'));
  for (let tagName of survivors)
    assert.ok(poisoned.get(tagName), `expected <${tagName}> to survive the failed define`);
});

test('the registration helper is not exported state — the namespace is classes only', () => {
  // Cheap structural check that this module keeps exporting classes and does not
  // start exporting the mutable registry helpers.
  for (let [ name, value ] of Object.entries(moduleNamespace)) {
    if (typeof value === 'function' && /^[A-Z]/.test(name))
      assert.ok(value.prototype instanceof HTMLElement, `${name} should be a custom element class`);
  }
});
