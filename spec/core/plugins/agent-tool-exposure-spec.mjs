'use strict';

// WHY THIS SPEC EXISTS
//
// `spec/plugin-entry-spec.mjs:127` asserts that the Discord plugin registers
// `['discord:send', 'discord:policy_grant', 'discord:policy_revoke']`. That spec
// passes, and it always has. It checks registration only, so it never noticed that
// the core filter in front of registration drops every one of those names.
//
// `AGENT_TOOL_NAME_PATTERN` is /^[A-Za-z0-9_-]+$/. `shouldExposeRegisteredTool()` runs
// it before a registered tool may reach an agent, so a name containing ':' is
// registered, discoverable in the registry, counted by the entry spec, and then
// silently discarded from every agent's toolset. No exception, no log line, no 404 -
// the tool simply is not in the list the model is handed, so the model cannot name it.
//
// Measured on the live 3003 store before this fix: 492 ShellToolFrame, 80
// ExecReadToolFrame, 16 WriteFileToolFrame - every hyphenated core tool executes
// freely - and zero DiscordSendToolFrame, ever. Miri received Discord messages,
// woke, ran real turns, and could not reply, because the one tool that replies was
// never in her list.
//
// Renaming the tools in the plugin was rejected: the registered name is also the
// authority key (`authorize({ actor, action: 'discord.send' })`) and the key every
// existing spec and the capability table use. The model-facing name is a separate
// concern, so it is mapped at exposure time and the registry keeps the real name.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRegisteredToolDefinitions,
  createRegisteredToolHandlers,
  toModelToolName,
} from '../../../src/core/plugins/agent-loop-tools.mjs';
import { AGENT_TOOL_NAME_PATTERN } from '../../../src/core/plugins/agent-tool-definitions.mjs';

// A registry double: the same shape plugin-registry.mjs exposes, seeded with the
// names the real plugins actually register.
function makeRegistry(entries) {
  let tools = new Map(entries.map(([name, overrides]) => [name, {
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    ...overrides,
  }]));
  return { getTools: () => tools };
}

function withRegistry(registry, extra = {}) {
  let executed = [];
  return {
    executed,
    context: {
      pluginRegistry: registry,
      toolExecutor: {
        executeTool: async ({ toolName }) => {
          executed.push(toolName);
          return { ok: true, toolName };
        },
      },
      session: { generation: 1 },
      ...extra,
    },
  };
}

test('a colon-named plugin tool is actually offered to the agent', () => {
  let registry = makeRegistry([
    ['discord:send', {}],
    ['exec', {}],
  ]);
  let { context } = withRegistry(registry);

  let names = createRegisteredToolDefinitions(context).map((d) => d.name);

  assert.ok(names.includes('exec'), 'plain tools keep working');
  assert.ok(
    names.includes('discord__send'),
    `discord:send must be exposed; got ${JSON.stringify(names)}`,
  );
  assert.ok(
    !names.includes('discord:send'),
    'the raw colon name must not leak to the model, which cannot carry it',
  );
});

test('every exposed name satisfies the pattern that gates exposure', () => {
  let registry = makeRegistry([
    ['discord:send', {}],
    ['discord:policy_grant', {}],
    ['discord:policy_revoke', {}],
    ['puppeteer:render_page', {}],
    ['puppeteer:screenshot', {}],
    ['puppeteer:evaluate', {}],
    ['exec', {}],
    ['read-file', {}],
  ]);
  let { context } = withRegistry(registry);

  let names = createRegisteredToolDefinitions(context).map((d) => d.name);

  assert.equal(names.length, 8, `all eight tools must be exposed, got ${names.length}`);
  for (let name of names) {
    assert.match(name, AGENT_TOOL_NAME_PATTERN, `${name} must be a legal agent tool name`);
  }
});

test('a namespaced tool still executes under its registered name', async () => {
  // The exposure name is a display alias. Authority is keyed on the registered name,
  // so dispatching the alias must resolve back to 'discord:send' - not 'discord_send',
  // which no plugin registered and no capability row names.
  let registry = makeRegistry([['discord:send', {}]]);
  let { context, executed } = withRegistry(registry);

  let handlers = createRegisteredToolHandlers(context);
  assert.ok(handlers.discord__send, 'handlers must be keyed by the exposed name');

  await handlers.discord__send({ channel: '123', content: 'hi' });

  assert.deepEqual(executed, ['discord:send'], 'execution must use the registered name');
});

test('the definition and the handler agree on the name', () => {
  let registry = makeRegistry([
    ['discord:send', {}],
    ['puppeteer:screenshot', {}],
  ]);
  let { context } = withRegistry(registry);

  let definitionNames = createRegisteredToolDefinitions(context).map((d) => d.name).sort();
  let handlerNames = Object.keys(createRegisteredToolHandlers(context)).sort();

  assert.deepEqual(
    handlerNames,
    definitionNames,
    'a name offered to the model with no handler is an uncallable tool',
  );
});

test('two tools collapsing onto one exposed name expose only one, loudly', () => {
  // 'discord:send' and 'discord__send' both map to 'discord__send'. Exposing both
  // would make the model's choice ambiguous, so the later one is skipped - but it
  // must be reported, because a silently dropped tool is the exact failure this
  // spec exists to prevent.
  let warnings = [];
  let registry = makeRegistry([
    ['discord:send', {}],
    ['discord__send', {}],
  ]);
  let { context } = withRegistry(registry, {
    logger: { warn: (message) => warnings.push(message) },
  });

  let names = createRegisteredToolDefinitions(context).map((d) => d.name);

  assert.equal(names.length, 1, `exactly one collision winner, got ${JSON.stringify(names)}`);
  assert.equal(warnings.length, 1, 'the collision must be reported, not swallowed');
  assert.match(warnings[0], /collision/i);
  assert.match(warnings[0], /discord/);
});

test('the alias mapping is stable and reversible in shape', () => {
  assert.equal(toModelToolName('discord:send'), 'discord__send');
  assert.equal(toModelToolName('puppeteer:render_page'), 'puppeteer__render_page');
  assert.equal(toModelToolName('exec'), 'exec', 'plain names are untouched');
  assert.equal(toModelToolName('read-file'), 'read-file');
});

test('a tool that opts out of agent exposure is still not exposed', () => {
  let registry = makeRegistry([['discord:send', { exposeToAgents: false }]]);
  let { context } = withRegistry(registry);

  assert.deepEqual(createRegisteredToolDefinitions(context), []);
  assert.deepEqual(Object.keys(createRegisteredToolHandlers(context)), []);
});
