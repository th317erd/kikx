'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CommandRegistry,
  parsePreferenceCommand,
  parsePreferenceLiteral,
  PreferenceCommand,
  registerInternalCommands,
} from '../../../src/core/commands/index.mjs';
import { PluginRegistry } from '../../../src/core/plugins/index.mjs';
import { FrameRouter } from '../../../src/core/routing/index.mjs';
import { FrameRuntime } from '../../../src/core/runtime/frame-runtime.mjs';
import { OCR_IMAGE_PROXY_PREFERENCE, SESSION_PREFERENCE_DEFAULTS } from '../../../src/core/preferences/index.mjs';
import {
  createIDGenerator,
  createMemoryFrameStore,
  quietLogger,
} from '../preferences/support/memory-frame-store.mjs';

test('/pref set, get, list, and unset operate on the current session', async () => {
  let store = createMemoryFrameStore();
  let runtime = createRuntime(store, [ 'ses_1' ]);
  await runtime.createSession({ id: 'ses_1', title: 'Scratch' });

  let set = await runCommand(runtime, 'ses_1', 'set ocr.image_proxy false');
  assert.equal(set.status, 'ok');
  assert.match(set.message, /Set ocr\.image_proxy = false/);
  assert.deepEqual(store.sessions.get('ses_1').preferences, { 'ocr.image_proxy': false });

  let get = await runCommand(runtime, 'ses_1', 'get ocr.image_proxy');
  assert.equal(get.status, 'ok');
  assert.equal(get.message, 'ocr.image_proxy = false');
  assert.equal(get.data.value, false);
  assert.equal(get.data.found, true);

  let list = await runCommand(runtime, 'ses_1', 'list');
  assert.equal(list.status, 'ok');
  assert.match(list.message, /ocr\.image_proxy = false/);
  assert.deepEqual(list.data.preferences, {
    ...SESSION_PREFERENCE_DEFAULTS,
    'ocr.image_proxy': false,
  });

  let unset = await runCommand(runtime, 'ses_1', 'unset ocr.image_proxy');
  assert.equal(unset.status, 'ok');
  assert.match(unset.message, /now inherits again/);
  assert.deepEqual(store.sessions.get('ses_1').preferences, {});
  assert.equal(await runtime.getEffectivePreference('ses_1', 'ocr.image_proxy'), true);
});

test('/pref set on a parent cascades to descendants and a child override wins', async () => {
  let store = createMemoryFrameStore();
  let runtime = createRuntime(store, [ 'root', 'child', 'grandchild' ]);
  await runtime.createSession({ id: 'root', title: 'Root' });
  await runtime.createSession({ id: 'child', title: 'Child', parentSessionID: 'root' });
  await runtime.createSession({ id: 'grandchild', title: 'Grandchild', parentSessionID: 'child' });

  await runCommand(runtime, 'root', 'set ocr.image_proxy false');
  await runCommand(runtime, 'root', 'set ui.density compact');

  assert.equal(await runtime.getEffectivePreference('child', 'ocr.image_proxy'), false);
  assert.equal(await runtime.getEffectivePreference('grandchild', 'ui.density'), 'compact');

  await runCommand(runtime, 'child', 'set ocr.image_proxy true');
  assert.equal(await runtime.getEffectivePreference('child', 'ocr.image_proxy'), true);
  assert.equal(await runtime.getEffectivePreference('grandchild', 'ocr.image_proxy'), true);
  assert.equal(await runtime.getEffectivePreference('grandchild', 'ui.density'), 'compact');

  // Unsetting the child's override reveals the inherited parent value again.
  await runCommand(runtime, 'child', 'unset ocr.image_proxy');
  assert.equal(await runtime.getEffectivePreference('grandchild', 'ocr.image_proxy'), false);
});

test('/pref stores values in the manifest and survives a runtime reload', async () => {
  let store = createMemoryFrameStore();
  let runtime = createRuntime(store, [ 'root', 'child' ]);
  await runtime.createSession({ id: 'root', title: 'Root' });
  await runtime.createSession({ id: 'child', title: 'Child', parentSessionID: 'root' });

  await runCommand(runtime, 'root', 'set ocr.image_proxy false');
  await runCommand(runtime, 'root', 'set custom.retries 3');
  await runCommand(runtime, 'root', 'set custom.label "quiet mode"');
  await runCommand(runtime, 'child', 'set ui.density compact');
  await store.flush();

  let reloaded = createRuntime(store, []);
  assert.deepEqual((await reloaded.getEffectivePreferences('child')).preferences, {
    ...SESSION_PREFERENCE_DEFAULTS,
    'ocr.image_proxy': false,
    'custom.retries': 3,
    'custom.label': 'quiet mode',
    'ui.density': 'compact',
  });
  assert.equal(await reloaded.getEffectivePreference('child', OCR_IMAGE_PROXY_PREFERENCE), false);
});

test('/pref unset is idempotent and reports when the session had no own value', async () => {
  let store = createMemoryFrameStore();
  let runtime = createRuntime(store, [ 'ses_1' ]);
  await runtime.createSession({ id: 'ses_1', title: 'Scratch' });

  let first = await runCommand(runtime, 'ses_1', 'unset missing.key');
  assert.equal(first.status, 'ok');
  assert.match(first.message, /was not set on this session/);
  assert.deepEqual(store.sessions.get('ses_1').preferences, {});

  let again = await runCommand(runtime, 'ses_1', 'unset missing.key');
  assert.equal(again.status, 'ok');
});

test('/pref help documents set, unset, get, and list without mutating state', async () => {
  let store = createMemoryFrameStore();
  let runtime = createRuntime(store, [ 'ses_1' ]);
  await runtime.createSession({ id: 'ses_1', title: 'Scratch' });

  for (let args of [ '', 'help' ]) {
    let result = await runCommand(runtime, 'ses_1', args);
    assert.equal(result.status, 'ok');
    assert.match(result.message, /\/pref set <key> <value>/);
    assert.match(result.message, /\/pref unset <key>/);
    assert.match(result.message, /\/pref get <key>/);
    assert.match(result.message, /\/pref list/);
  }

  assert.deepEqual(store.sessions.get('ses_1').preferences, {});
});

test('preference command parsing accepts booleans, finite numbers, and quoted strings', () => {
  assert.deepEqual(parsePreferenceCommand('set ocr.image_proxy false'), {
    action: 'set',
    key: 'ocr.image_proxy',
    rawValue: 'false',
  });
  assert.equal(parsePreferenceLiteral('true'), true);
  assert.equal(parsePreferenceLiteral('false'), false);
  assert.equal(parsePreferenceLiteral('42'), 42);
  assert.equal(parsePreferenceLiteral('-1.5'), -1.5);
  assert.equal(parsePreferenceLiteral('1e3'), 1000);
  assert.equal(parsePreferenceLiteral('plain text'), 'plain text');
  assert.equal(parsePreferenceLiteral('"quoted text"'), 'quoted text');
  assert.equal(parsePreferenceLiteral("'it\\'s fine'"), "it's fine");
  assert.equal(parsePreferenceLiteral('""'), '');

  assert.deepEqual(parsePreferenceCommand('get ui.density'), { action: 'get', key: 'ui.density' });
  assert.deepEqual(parsePreferenceCommand('unset ui.density'), { action: 'unset', key: 'ui.density' });
  assert.deepEqual(parsePreferenceCommand('list'), { action: 'list' });
  assert.deepEqual(parsePreferenceCommand(''), { action: 'help' });
});

test('preference command parsing rejects malformed usage', () => {
  assert.throws(() => parsePreferenceCommand('set key'), /Usage: \/pref set <key> <value>/);
  assert.throws(() => parsePreferenceCommand('get'), /Usage: \/pref get <key>/);
  assert.throws(() => parsePreferenceCommand('unset key extra'), /Usage: \/pref unset <key>/);
  assert.throws(() => parsePreferenceCommand('list extra'), /Usage: \/pref list/);
  assert.throws(() => parsePreferenceCommand('nope key'), /Unknown preference command: nope/);
  assert.throws(() => parsePreferenceLiteral('"unterminated'), /Malformed quoted/);
  assert.throws(() => parsePreferenceLiteral('   '), /must not be empty/);
});

test('a routed /pref set persists the preference and returns a command result', async () => {
  let aeordb = createMemoryClient();
  let pluginRegistry = new PluginRegistry({ logger: quietLogger() });
  let commandRegistry = new CommandRegistry({ logger: quietLogger() });
  let router = new FrameRouter({ logger: quietLogger() });
  let runtime;
  let context = {
    require(name) {
      if (name === 'frameRuntime')
        return runtime;
      if (name === 'commandRegistry')
        return commandRegistry;
      throw new Error(`Unknown service: ${name}`);
    },
  };

  registerInternalCommands({ pluginRegistry, commandRegistry });
  router.loadFromRegistry(pluginRegistry);
  runtime = new FrameRuntime({
    aeordb,
    frameRouter: router,
    services: { context },
    logger: quietLogger(),
    clock: () => 1000,
    idGenerator: createIDGenerator([ 'ses_1', 'int_1', 'msg_1', 'commit_1', 'cmd_1', 'commit_2' ]),
  });

  await runtime.createSession({ id: 'ses_1', title: 'Scratch' });
  await runtime.appendUserMessage('ses_1', { text: '/pref set ocr.image_proxy false', userID: 'usr_1' });
  await runtime.frameRouter.flush();
  await runtime.frameStore.flush();

  let saved = await aeordb.getFile('/kikx/sessions/ses_1/session.json');
  assert.deepEqual(saved.preferences, { 'ocr.image_proxy': false });
  assert.equal(await runtime.getEffectivePreference('ses_1', 'ocr.image_proxy'), false);

  let frames = await runtime.listFrames('ses_1', { limit: 20 });
  let result = frames.find((frame) => frame.type === 'CommandResult');
  assert.ok(result, 'the slash command must produce a CommandResult');
  assert.equal(result.content.status, 'ok');
  assert.match(result.content.text, /Set ocr\.image_proxy = false/);
});

test('/pref is registered with preference aliases and a description', () => {
  let registry = new CommandRegistry({ logger: quietLogger() });
  registry.registerCommand('pref', PreferenceCommand, { aliases: PreferenceCommand.aliases });

  assert.equal(registry.getCommand('pref').name, 'pref');
  assert.equal(registry.getCommand('prefs').name, 'pref');
  assert.equal(registry.getCommand('preference').name, 'pref');
  assert.equal(registry.getCommand('preferences').name, 'pref');
  assert.match(registry.getCommand('pref').description, /cascading session preferences/);
});

async function runCommand(runtime, sessionID, args) {
  let session = runtime.getSession(sessionID);
  let frame = { id: `msg_${sessionID}`, sessionID };
  return await new PreferenceCommand().execute({
    args,
    frame,
    session,
    services: { frameRuntime: runtime },
  });
}

function createRuntime(store, ids) {
  return new FrameRuntime({
    frameStore: store,
    logger: quietLogger(),
    clock: () => 1000,
    idGenerator: createIDGenerator(ids),
  });
}

function createMemoryClient() {
  return {
    files: new Map(),
    async putFile(path, body) {
      this.files.set(path, JSON.parse(JSON.stringify(body)));
      return { path };
    },
    async getFile(path) {
      return this.files.get(path) || null;
    },
    async listDirectory() {
      return { items: [] };
    },
  };
}
