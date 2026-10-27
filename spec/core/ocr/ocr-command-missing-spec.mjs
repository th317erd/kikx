'use strict';

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentInterface, PluginRegistry } from '../../../src/core/plugins/index.mjs';
import { OcrService } from '../../../src/core/ocr/index.mjs';
import { setup } from '../../../plugins/ocr/index.mjs';

const MISSING_COMMAND = '/nonexistent/kikx-spec/bot-ocr-does-not-exist';

function createHostOcrProvider() {
  let registry = new PluginRegistry({ logger: { warn() {} } });
  registry.registerClass('AgentInterface', AgentInterface);
  setup((callback) => callback({
    registry,
    registerAgentType: (name, provider) => registry.registerAgentType(name, provider),
  }));
  let Provider = registry.getAgentProvider('host-ocr-command');
  assert.ok(Provider, 'expected host-ocr-command to be registered');
  return Provider;
}

// A command that ignores its arguments, so `-t <n>` can be passed without the
// stub itself rejecting the flag.
function createArgumentTolerantCommand() {
  let tmp = mkdtempSync(join(tmpdir(), 'kikx-ocr-args-'));
  let script = join(tmp, 'stub-ocr.sh');
  writeFileSync(script, '#!/bin/sh\nprintf "stub ok"\n', 'utf8');
  chmodSync(script, 0o755);
  return { tmp, script };
}

// The builtin fallback spawns the bare default command, so whether it resolves
// depends on the PATH of whoever runs the suite. Point PATH at an empty
// directory for the duration of a test so "command absent" is a fact about the
// fixture rather than a fact about the machine.
async function withEmptyPath(callback) {
  let empty = mkdtempSync(join(tmpdir(), 'kikx-ocr-emptypath-'));
  let original = process.env.PATH;
  let originalHome = process.env.HOME;
  process.env.PATH = empty;
  // The host OCR provider also probes the conventional per-user install paths.
  // Point HOME at the same empty directory so this test is about a genuinely
  // missing command, not about whether this developer has bot-ocr installed.
  process.env.HOME = empty;
  try {
    return await callback();
  } finally {
    if (original === undefined)
      delete process.env.PATH;
    else
      process.env.PATH = original;
    if (originalHome === undefined)
      delete process.env.HOME;
    else
      process.env.HOME = originalHome;
    rmSync(empty, { recursive: true, force: true });
  }
}

test('a missing OCR command names the resolved command and the fix instead of a bare spawn error', async () => {
  let Provider = createHostOcrProvider();
  let provider = new Provider({
    agent: { id: 'ocr_missing', name: 'Missing OCR', config: { command: MISSING_COMMAND } },
  });

  let error = null;
  try {
    await provider.runOcr({ images: [ '/tmp/example.png' ], prompt: 'read this' });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error, 'expected runOcr to reject');
  assert.ok(
    error.message.includes(MISSING_COMMAND),
    `message must name the resolved command, got: ${error.message}`,
  );
  assert.match(error.message, /was not found/);
  // A remediation hint, not a raw errno string.
  assert.match(error.message, /Host OCR command/);
  assert.match(error.message, /absolute command path/);
  assert.match(error.message, /'command' config field/);
  // Regression guard against the old silent shape.
  assert.notEqual(error.message, `spawn ${MISSING_COMMAND} ENOENT`);
  assert.doesNotMatch(error.message, /^spawn /);
});

test('a missing OCR command keeps the errno detail and the stdout/stderr fields callers read', async () => {
  let Provider = createHostOcrProvider();
  let provider = new Provider({
    agent: { id: 'ocr_missing', name: 'Missing OCR', config: { command: MISSING_COMMAND } },
  });

  let error = null;
  try {
    await provider.runOcr({ images: [ '/tmp/example.png' ] });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error, 'expected runOcr to reject');
  // Diagnosability must not cost the machine-readable cause. Assert the portable
  // symbolic code and the syscall/path detail; the numeric errno value differs by
  // platform (ENOENT is -2 on Linux and 2 on macOS), so it is not pinned here.
  assert.equal(error.code, 'ENOENT');
  assert.equal(typeof error.errno, 'number');
  assert.equal(error.syscall, `spawn ${MISSING_COMMAND}`);
  assert.equal(error.path, MISSING_COMMAND);
  assert.ok(error.cause instanceof Error, 'expected the original spawn error to be attached');
  // Non-zero-exit errors carry stdout/stderr; keep the shape uniform.
  assert.equal(error.stdout, '');
  assert.equal(error.stderr, '');
});

test('the host OCR command config still declares bot-ocr as its default command', () => {
  let Provider = createHostOcrProvider();
  let commandField = Provider.configFields.find((field) => field.name === 'command');
  assert.ok(commandField, 'expected a command config field');
  assert.equal(commandField.defaultValue, 'bot-ocr');
});

test('listOcrAgents excludes a high ocr_score agent whose provider does not declare supportsOcr', async () => {
  let registry = new PluginRegistry({ logger: { warn() {} } });
  registry.registerClass('AgentInterface', AgentInterface);

  // A provider that does exactly what ollama-agent does: no `supportsOcr` flag.
  class ChatOnlyProvider extends AgentInterface {
    static pluginId = 'chat-only';
    static featureName = 'chat';
    static displayName = 'Chat only';
    static agentType = 'chat-only';
    static configFields = [];
    async *ask() {}
  }
  registry.registerAgentType('chat-only', ChatOnlyProvider);
  setup((callback) => callback({
    registry,
    registerAgentType: (name, provider) => registry.registerAgentType(name, provider),
  }));

  let agents = [
    { id: 'scored_10', name: 'Scored Ten', pluginID: 'chat-only', enabled: true,
      tags: [ { name: 'ocr_score', value: 10, target_type: 'agent' } ] },
  ];
  let service = new OcrService({
    agentManager: { async listAgents() { return agents; } },
    pluginRegistry: registry,
  });

  // The silent no-op: a perfect ocr_score and still never selectable.
  let selectable = await service.listOcrAgents();
  assert.deepEqual(selectable, [], 'an agent on a non-OCR provider must not be selectable');

  // The exclusion is deliberate and must be reported rather than swallowed.
  let ignored = await service.listOcrScoreAgentsWithoutProviderSupport();
  assert.equal(ignored.length, 1);
  assert.equal(ignored[0].id, 'scored_10');
  assert.equal(ignored[0].score, 10);
  assert.equal(ignored[0].pluginID, 'chat-only');
});

test('builtinOcrAgent still resolves to the host OCR command provider', () => {
  class HostOcrProvider {
    static supportsOcr = true;
  }
  let service = new OcrService({
    pluginRegistry: {
      getAgentProvider(pluginID) {
        return pluginID === 'host-ocr-command' ? HostOcrProvider : null;
      },
    },
  });

  let fallback = service.builtinOcrAgent();
  assert.ok(fallback, 'expected a non-null builtin OCR agent');
  assert.equal(fallback.pluginID, 'host-ocr-command');
  assert.equal(fallback.id, 'builtin-host-ocr');
});

test('the empty-roster error names the agents ignored for a missing supportsOcr declaration', async () => {
  let registry = new PluginRegistry({ logger: { warn() {} } });
  registry.registerClass('AgentInterface', AgentInterface);

  class ChatOnlyProvider extends AgentInterface {
    static pluginId = 'chat-only';
    static featureName = 'chat';
    static displayName = 'Chat only';
    static agentType = 'chat-only';
    static configFields = [];
    async *ask() {}
  }
  registry.registerAgentType('chat-only', ChatOnlyProvider);

  let agents = [
    { id: 'scored_10', name: 'Scored Ten', pluginID: 'chat-only', enabled: true,
      tags: [ { name: 'ocr_score', value: 10, target_type: 'agent' } ] },
  ];
  // No OCR plugin registered, so there is no builtin fallback and the roster
  // message is the one that surfaces.
  let service = new OcrService({
    agentManager: { async listAgents() { return agents; } },
    pluginRegistry: registry,
  });

  let message = await service.explainEmptyOcrRoster();
  assert.match(message, /No OCR-capable enabled agents have a positive ocr_score tag/);
  assert.match(message, /supportsOcr/);
  assert.match(message, /Scored Ten/);
  assert.match(message, /ocr_score 10/);
  assert.match(message, /chat-only/);
});

test('the all-agents-failed error names the ignored scored agents even when the builtin fallback exists', async () => {
  let registry = new PluginRegistry({ logger: { warn() {} } });
  registry.registerClass('AgentInterface', AgentInterface);

  class ChatOnlyProvider extends AgentInterface {
    static pluginId = 'chat-only';
    static featureName = 'chat';
    static displayName = 'Chat only';
    static agentType = 'chat-only';
    static configFields = [];
    async *ask() {}
  }
  registry.registerAgentType('chat-only', ChatOnlyProvider);
  setup((callback) => callback({
    registry,
    registerAgentType: (name, provider) => registry.registerAgentType(name, provider),
  }));

  let agents = [
    { id: 'scored_10', name: 'Scored Ten', pluginID: 'chat-only', enabled: true,
      tags: [ { name: 'ocr_score', value: 10, target_type: 'agent' } ] },
  ];
  let service = new OcrService({
    agentManager: { async listAgents() { return agents; } },
    pluginRegistry: registry,
  });

  // The builtin exists, so the empty-roster branch is unreachable. This is the
  // path production actually takes, and it must still explain the filtering.
  assert.ok(service.builtinOcrAgent(), 'expected the builtin fallback to exist');

  await assert.rejects(
    () => withEmptyPath(() => service.run({ images: [ '/tmp/example.png' ] })),
    (error) => {
      assert.match(error.message, /All OCR agents failed/);
      assert.match(error.message, /supportsOcr/);
      assert.match(error.message, /Scored Ten/);
      assert.match(error.message, /ocr_score 10/);
      return true;
    },
  );
});

test('a timed-out OCR command names the command and explains the timeoutMs versus -t mismatch', async () => {
  let Provider = createHostOcrProvider();
  let provider = new Provider({
    agent: {
      id: 'ocr_slow',
      name: 'Slow OCR',
      config: {
        command: process.execPath,
        args: '-e "setTimeout(() => process.stdout.write(\'late\'), 10000)"',
        promptFlag: '',
        timeoutMs: 250,
      },
    },
  });

  let error = null;
  try {
    await provider.runOcr({ images: [ '/tmp/example.png' ] });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error, 'expected a timeout');
  assert.equal(error.code, 'ETIMEDOUT');
  assert.ok(error.message.includes(process.execPath), `message must name the command, got: ${error.message}`);
  assert.match(error.message, /-t\/--timeout/);
  assert.match(error.message, /seconds/);
  assert.match(error.message, /timeoutMs/);
  // The old shape: `OCR command timed out after 250ms`, naming nothing.
  assert.doesNotMatch(error.message, /^OCR command timed out after \d+ms$/);
});

test('a non-executable OCR command explains why it could not run instead of a bare spawn error', async () => {
  let tmp = mkdtempSync(join(tmpdir(), 'kikx-ocr-eacces-'));
  let script = join(tmp, 'not-executable.sh');
  try {
    writeFileSync(script, '#!/bin/sh\nprintf "never runs"\n', 'utf8');
    chmodSync(script, 0o644);

    let Provider = createHostOcrProvider();
    let provider = new Provider({
      agent: { id: 'ocr_eacces', name: 'No Exec', config: { command: script, promptFlag: '' } },
    });

    let error = null;
    try {
      await provider.runOcr({ images: [ '/tmp/example.png' ] });
    } catch (caught) {
      error = caught;
    }

    assert.ok(error, 'expected runOcr to reject');
    assert.ok(
      error.message.includes(script),
      `message must name the resolved command, got: ${error.message}`,
    );
    assert.doesNotMatch(error.message, /^spawn /);
    // Says what is wrong and what to do, in that order.
    assert.match(error.message, /could not be executed/);
    assert.match(error.message, /not executable/);
    assert.match(error.message, /'command' config field/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a -t budget in the free-form args field raises the process deadline instead of being cut short', async () => {
  let tmp = mkdtempSync(join(tmpdir(), 'kikx-ocr-clamp-'));
  try {
    let script = join(tmp, 'stub-ocr.sh');
    writeFileSync(script, '#!/bin/sh\nprintf "stub ok"\n', 'utf8');
    chmodSync(script, 0o755);

    let Provider = createHostOcrProvider();

    // bot-ocr's -t is seconds per image; timeoutMs is one millisecond deadline for
    // the whole process. A 30s -t with a 1s deadline used to be silently cut short.
    let tightProvider = new Provider({
      agent: { id: 'ocr_tight', name: 'Tight', config: { command: script, args: '-t 30', promptFlag: '', timeoutMs: 1000 } },
    });
    let tight = await tightProvider.runOcr({ images: [ '/tmp/example.png' ] });
    assert.equal(tight.timeoutMs, 35000, 'expected 30s plus the 5s start-up margin');
    assert.equal(tight.warnings.length, 1);
    assert.match(tight.warnings[0], /-t\/--timeout/);

    // A deadline already larger than the -t budget is left alone and says nothing.
    let generousProvider = new Provider({
      agent: { id: 'ocr_generous', name: 'Generous', config: { command: script, args: '-t 30', promptFlag: '', timeoutMs: 600000 } },
    });
    let generous = await generousProvider.runOcr({ images: [ '/tmp/example.png' ] });
    assert.equal(generous.timeoutMs, 600000);
    assert.deepEqual(generous.warnings, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('end to end: OcrService surfaces the missing-command message through the builtin fallback', async () => {
  let registry = new PluginRegistry({ logger: { warn() {} } });
  registry.registerClass('AgentInterface', AgentInterface);
  setup((callback) => callback({
    registry,
    registerAgentType: (name, provider) => registry.registerAgentType(name, provider),
  }));
  assert.ok(registry.getAgentProvider('host-ocr-command'), 'expected host-ocr-command registration');

  let service = new OcrService({
    agentManager: { async listAgents() { return []; } },
    pluginRegistry: {
      getAgentProvider(pluginID) {
        return registry.getAgentProvider(pluginID) || null;
      },
      getTools() {
        return new Map();
      },
    },
  });

  // The builtin agent ships `config: {}`, so the bare default command is what runs.
  let builtin = service.builtinOcrAgent();
  assert.ok(builtin, 'expected the builtin host OCR agent');
  assert.deepEqual(builtin.config, {});

  // PATH is emptied so `bot-ocr` is deterministically absent. Without this the
  // test asserts different things on a machine that has bot-ocr installed.
  await withEmptyPath(async () => {
    await assert.rejects(
      () => service.run({ images: [ '/tmp/example.png' ], prompt: 'read this' }),
      (error) => {
        assert.match(error.message, /All OCR agents failed/);
        assert.equal(error.attempts.length, 1);
        let attempt = error.attempts[0];
        assert.equal(attempt.agentID, 'builtin-host-ocr');
        // The exact case this task exists for: absent command, named with a fix.
        assert.match(attempt.error, /was not found/);
        assert.match(attempt.error, /Host OCR command/);
        assert.match(attempt.error, /absolute command path/);
        assert.match(error.message, /OCR command '/);
        return true;
      },
    );
  });
});
