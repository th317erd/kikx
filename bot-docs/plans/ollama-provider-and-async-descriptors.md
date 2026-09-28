# Plan: Ollama Agent Provider + Async Provider Descriptors

Status: COMPLETE (2026-09-28)
Date: 2026-09-28
Repos touched: `kikx` (core), `kikx-plugin-ollama` (new, private), `kikx-plugin-codex` (spec/fix)

## 1. Purpose

Add a DeepSeek 4.1 Flash agent to Kikx via a new Ollama agent provider plugin, using
Ollama's **native** `/api/chat` surface (owner ruling: this is a ground-up generic
harness, not an OpenAI-compatibility shim).

To give the plugin a live "Model" selectbox in the Add Agent dialog, upgrade the
plugin-driven provider descriptor path from synchronous class-statics to an **async**
contract that can make a request (e.g. Ollama `GET /api/tags`) when building
`configFields`.

## 2. Non-goals

- No dynamic discovery for existing providers beyond adding the capability.
- No auth/key handling for Ollama (local proxy to ollama.com currently needs none).
- No changes to Kikx routing, frame projection, compaction, or tool execution
  contracts.
- No dynamic *non-model* fields; the async hook is generic but only Ollama exercises it.

## 3. Observed facts (verified this session)

- Ollama 0.34.4 at `http://127.0.0.1:11434`; model `deepseek-v4.1-flash:cloud`
  (capabilities `completion`, `thinking`, `tools`, `vision`; 1M ctx; ollama.com remote).
- Native `/api/chat` streams NDJSON. Per line: `message.thinking`, `message.content`,
  `message.tool_calls[{function:{name,arguments}}]` (arguments arrive as an object),
  and a final line with `done:true`, `prompt_eval_count`, `eval_count`,
  `prompt_eval_cached_count`. Tool results are sent back as
  `{role:'tool', content:<string>}`; round-trip verified working.
- Existing provider contract (current, non-legacy): `kikx-plugin-codex/index.mjs`
  implements `setup(provide)` + `class extends AgentInterface` + `async *ask(prompt, options)`
  yielding `BeginTyping` / `AgentThinking` / `AgentMessageDelta` (phantoms carrying
  `responseFrameID`) / `EndTyping` / final `AgentMessage (id: responseFrameID,
  content.status:'complete')` / `Done {content.usage}`. `kikx-plugin-claude` and
  `kikx-plugin-google` are legacy and not wired to the live loop.
- Provider descriptor path today:
  - `AgentInterface.getAgentProviderDescriptor()` static/sync — `agent-interface.mjs:497`
  - `normalizeConfigFields()` — `agent-interface.mjs:1471`
  - `PluginRegistry.listAgentProviderDescriptors()` sync map — `plugin-registry.mjs:75`
  - `AgentManager.listProviders()` sync — `agent-manager.mjs:16`
  - `AgentManager.normalizeInput()` sync, calls `provider.getAgentProviderDescriptor()` — `agent-manager.mjs:93`
  - `GET /api/v1/agent-providers` inside async `routeRequest` — `create-server.mjs:348`
  - Client renders `configFields`, including `type:'select'` with `field.options` —
    `kikx-app.mjs:429-447`, `normalizeFieldOptions` `kikx-app.mjs:1675`
- Loop-control tools (`agent-respond`, `agent-null-response`, `internal-forward`, ...)
  are ordinary entries in `options.tools`; a provider executes them inside its own
  tool loop and feeds the returned `LoopControl` object back to the model as a tool
  result (Codex does exactly this; see `kikx-plugin-codex/spec/setup-spec.mjs:283-396`).
- `Done.content.usage` aliases accepted by `normalizeProviderUsage`:
  input `inputTokens|input_tokens|promptTokens|prompt_tokens|readTokens`,
  output `outputTokens|output_tokens|completionTokens|completion_tokens|writeTokens`,
  total `tokensUsed|totalTokens|total_tokens|total`. Zero total => usage not recorded.
- Compaction calls `provider.ask(prompt, {compaction:true, oneShot:true, tools:{},
  toolDefinitions:[], ...})` and harvests text from `content`/`content.text`/`text` —
  `compaction-service.mjs:272`.
- `PluginLoader` reads `package.json.main` (default `index.mjs`) and calls exported
  `setup(provide)` — `plugin-loader.mjs:87-99`. Dev plugin list is
  `KIKX_PLUGIN_PATHS` in `.env.dev` (currently codex + claude only).
- `createServer` accepts `options.fetchImpl` for the AeorDB client only; agent
  providers get their `fetch` from `context.fetchImpl` / `services.fetchImpl` /
  `globalThis.fetch` (Codex pattern).
- Baselines: `npm test` = `timeout 120 node --test --test-timeout=30000 'spec/**/*-spec.mjs'`.
  Codex spec = `timeout 60 node --test --test-timeout=30000 'spec/**/*-spec.mjs'` (14 lines pkg).
  Working tree has extensive uncommitted changes on `main`; commit this work atomically.

## 4. Contracts

### 4.1 Async provider descriptor (Kikx core)

Make the descriptor chain async. Single source of truth; no dual sync/async API.

- `AgentInterface`:
  - Add extension point `static async resolveConfigFields()` whose default returns
    `this.configFields`. This is what dynamic plugins override.
  - Change `static getAgentProviderDescriptor()` to `static async` and build
    `configFields: normalizeConfigFields(await this.resolveConfigFields())`.
  - `getModels()` stays sync (it is metadata, not UI-driving).
- `PluginRegistry.listAgentProviderDescriptors()` becomes async:
  `await Promise.all([...].map((C) => C.getAgentProviderDescriptor()))`.
  Preserve insertion order.
- `AgentManager.listProviders()` becomes async; `AgentManager.normalizeInput()`
  becomes async and `await`s the descriptor. Its callers
  (`createAgent` `agent-manager.mjs:21`, `updateAgent` `:71`) already `async` => add `await`.
- `create-server.mjs:352` => `providers: await agentManager.listProviders()`
  (routeRequest is already async).
- Fallback: a provider whose `resolveConfigFields()` throws must not break
  `/api/v1/agent-providers`. `listAgentProviderDescriptors()` catches per-provider,
  logs a warning, and emits a descriptor with `configFields: []` for that provider.
  `normalizeInput` must surface the descriptor error as a 400/502 rather than crash.

Compatibility note: this is a breaking change for any plugin overriding the old sync
`getAgentProviderDescriptor()`. Only Codex participates; it inherits the base and
only needs its spec updated. Legacy Claude/Google plugins are already non-functional
and out of scope.

### 4.2 Ollama plugin

Repo: `/home/wyatt/Projects/kikx-workspace/kikx-plugin-ollama`

```
kikx-plugin-ollama/
├── package.json          # type module, main index.mjs, node>=22, test script
├── index.mjs             # setup(provide) + OllamaAgent extends AgentInterface
├── .gitignore            # node_modules
└── spec/
    └── setup-spec.mjs
```

Statics:

```js
static pluginId    = 'ollama-agent';
static featureName = 'chat';
static displayName = 'Ollama';
static description = 'Ollama local/remote model agent provider';
static agentType   = 'ollama';
static serviceType = 'ollama';
static configFields = [
  { name:'baseUrl', label:'Base URL', type:'text', required:true,
    defaultValue:'http://127.0.0.1:11434',
    help:'Ollama server base URL (e.g. http://127.0.0.1:11434).' },
  { name:'model', label:'Model', type:'select', required:true,
    defaultValue:'deepseek-v4.1-flash:cloud', options:[/* fallback list */],
    help:'Model served by the configured Ollama server.' },
];
```

Dynamic options: override `static async resolveConfigFields()`; return the base
`configFields` clone with `model.options` replaced by `GET ${baseUrl}/api/tags`
mapping `models[].name -> {value,label}`. Requirements:
- Short timeout (2s) on the tags request; `AbortController`.
- On non-ok/timeout/parse failure, return the fallback options (no throw, so the
  provider still renders and agent creation still works offline).
- In-memory TTL cache (recommended 60s) keyed by baseUrl to avoid a fetch on every
  `/api/v1/agent-providers` and every create/update call.
- `baseUrl` for discovery read from `process.env.OLLAMA_HOST` default
  `http://127.0.0.1:11434` (the descriptor has no agent instance/config context).

`ask(prompt, options)` — native `/api/chat`:

1. Resolve `baseUrl` (`options.config.baseUrl`), `model` (`options.config.model`),
   `responseFrameID`, `agentID`, `fetchImpl`
   (`this.context?.fetchImpl ?? options.services?.fetchImpl ?? globalThis.fetch`).
2. `yield BeginTyping` phantom (`id: ${responseFrameID}:typing`, `responseFrameID`,
   `content:{agentID, agentName}`) before the request.
3. Build `messages` from `options.frames`/`options.sessionFrames` using the same
   frame->message mapping semantics as Codex (`frameToOpenAIMessage`):
   `UserMessage`->user; own `AgentMessage`->assistant; other-agent `AgentMessage`->user
   wrapped `<agent-message source display-name>`; `CommandResult`->user; skip
   deleted/hidden/empty; skip the current frame id; append the newest prompt as a
   final user message. Prepend a system message describing Kikx session memory.
4. Build `tools` from `options.toolDefinitions` as native
   `{type:'function', function:{name, description, parameters}}`; validate names
   against `/^[A-Za-z0-9_-]+$/`; dedupe.
5. Tool loop (bound `MAX_OLLAMA_TOOL_ROUNDS = 64`):
   - POST `${baseUrl}/api/chat` `{model, messages, tools, stream:true}` with timeout.
   - Parse NDJSON (split on `\n`, ignore blank lines, JSON.parse each).
   - `message.thinking` non-empty => append to `thinkingText`, seq++, set
     `thinkingChunks[String(seq)] = delta`, yield `AgentThinking` phantom
     (`content.thinking = {text, chunks, status:'streaming'}`). **chunks is an
     object keyed by sequence string, never an array.**
   - `message.content` non-empty => append to `outputText`, yield `AgentMessageDelta`
     phantom (`id:responseFrameID`, `content:{delta,text:outputText}`).
   - `message.tool_calls[]` => record `{name, arguments}` (arguments object-or-string;
     parse strings). Capture `prompt_eval_count`/`eval_count`/`prompt_eval_cached_count`
     from the final `done:true` line.
   - If no tool calls => break.
   - Else append `{role:'assistant', content: outputText||'', tool_calls:[...]}`,
     execute each via `options.tools[name]`, serialize result with
     `JSON.stringify(normalizeToolResult(result))`, append
     `{role:'tool', content:<string>}`, reset per-round output, continue.
   - Tool handler errors become `{error:{toolName,message}}` results (never abort),
     mirroring Codex.
6. `finally` => `yield EndTyping` phantom.
7. `yield AgentMessage` `{id:responseFrameID, content:{ text: outputText ||
   summarizeToolResults(...), thinking:{text,chunks,status:'complete'}, model,
   status:'complete', ...(toolResults.length?{toolResults}:{}) }}`.
8. `yield Done` `{content:{ usage:{ inputTokens, outputTokens, totalTokens } }}`
   from `prompt_eval_count`/`eval_count` summed across rounds.

Error handling: non-ok HTTP throws `` `Ollama HTTP ${status}: ${bodySnippet}` ``;
malformed NDJSON throws; timeout aborts with a clear message.

Compaction: no special-casing needed; with `tools:{}` the loop makes one request and
yields a text-bearing `AgentMessage`.

## 5. Phases

### P0 — Async provider descriptor (kikx core)
Files: `src/core/plugins/agent-interface.mjs`, `src/core/plugins/plugin-registry.mjs`,
`src/core/agents/agent-manager.mjs`, `src/server/create-server.mjs`,
specs `spec/core/plugin-registry-spec.mjs`, `spec/core/plugin-loader-spec.mjs`,
`spec/core/agents/agent-manager-spec.mjs`, `spec/server/create-server-spec.mjs`,
`kikx-plugin-codex/spec/setup-spec.mjs`.

- Implement §4.1.
- New capability tests (failing-first against current sync code):
  - A provider with `static async resolveConfigFields()` returning dynamic options =>
    `await registry.listAgentProviderDescriptors()` includes those options.
  - A provider whose `resolveConfigFields()` rejects => descriptor still listed with
    `configFields: []`; `normalizeInput` error path asserted.
  - `await manager.listProviders()` returns dynamic options; create/update accept a
    config key resolved dynamically.
- Update existing sync assertions to `await`.
- Start gate: P0 only starts after the pre-existing uncommitted `main` work is
  committed (recovery point) or explicitly stashed.
- Landing gate: `npm test` green; `cd ../kikx-plugin-codex && npm test` green.

### P1 — Ollama plugin (new repo)
Files: `kikx-plugin-ollama/{package.json,index.mjs,.gitignore,spec/setup-spec.mjs}`.
Depends on P0 (async hook) for live discovery; plugin `ask()` is otherwise independent.

Specs (all with mocked `fetchImpl`, no network):
- registration + descriptor: pluginID/agentType/serviceType/displayName/description,
  `baseUrl` + `model` fields, default model.
- dynamic discovery: mock `GET /api/tags` => options populated; rejection/timeout =>
  fallback options, no throw; TTL cache means one fetch for two calls.
- streaming happy path: frames exactly
  `BeginTyping, AgentThinking, AgentMessageDelta..., EndTyping, AgentMessage, Done`;
  phantom ids/`responseFrameID`; `thinking.chunks` object-keyed; final
  `content.status:'complete'`; usage mapping from `prompt_eval_*`/`eval_*`.
- tools: first round returns `tool_calls`; assert handler invoked, tool result fed
  back, second round completes; loop-control tool (e.g. `agent-respond`) executes.
- tool error: handler throws => error result fed back, stream still completes.
- failures: HTTP 500, malformed NDJSON line, timeout/abort.

Landing gate: `cd ../kikx-plugin-ollama && npm test` green.

### P2 — Wiring, UI coverage, real end-to-end
- Append `:/home/wyatt/Projects/kikx-workspace/kikx-plugin-ollama` to
  `KIKX_PLUGIN_PATHS` in `.env.dev`.
- Stagehand UI coverage (project quirk `stagehand-coverage-for-ui-updates`): extend
  `spec/ui/stagehand/stagehand-test-utils.mjs` `createAgentManagerStub` to accept
  providers, add `spec/ui/stagehand/ollama-agent-provider-stagehand.mjs` opening the
  Add Agent dialog, selecting the Ollama provider, and asserting the Model select
  renders with the discovered options. This proves the dynamic-field capability at
  the user-facing level.
- Real end-to-end (dev stack): start AeorDB + Kikx, create an Ollama agent with
  `model=deepseek-v4.1-flash:cloud`, send a message in a session, verify streamed
  thinking/content, tools work, token total updates. Restart Kikx after changes
  per quirks.
- Landing gates: `npm test`, `npm run test:ui:stagehand`.

## 6. Verification spine (DoD)

- P0: `npm test` green; new async-descriptor specs prove dynamic resolution + failure
  fallback; `kikx-plugin-codex` specs green.
- P1: `kikx-plugin-ollama` specs green, covering success, tool loop (incl. loop
  control), tool error, malformed/empty stream, HTTP error, timeout, and usage.
- P2: Stagehand test proves the provider's selectbox renders with dynamic options;
  real dev E2E produces streamed frames + token accounting for
  `deepseek-v4.1-flash:cloud`.
- Regression gates: rerun full `npm test` after P2 integration; grep confirms no
  remaining sync `getAgentProviderDescriptor()` call sites in `src/`.

## 7. Risks / constraints

- **Breaking async change**: any plugin overriding sync `getAgentProviderDescriptor()`
  breaks. Only Codex exists and does not override it. Mitigation: update Codex spec.
- **Descriptor fetch at runtime**: `/api/v1/agent-providers` could slow/fail if the
  Ollama host is down. Mitigation: 2s timeout, TTL cache, non-throwing fallback.
- **`baseUrl` in discovery**: descriptor has no per-agent config; discovery uses
  `OLLAMA_HOST` default. Multi-host setups would need a larger contract change —
  explicitly out of scope.
- **Tool loop runaway**: bounded at 64 rounds; base `maxLoopSteps` still guards script
  steps.
- **chunks as array**: must stay object-keyed (AeorDB merge-patch) — asserted in spec.
- **Repos**: three separate git repos; land P0 (kikx + codex specs) and P1 (plugin)
  as coherent commits. Do not commit until authorized.

## 8. Owner decisions (recorded verbatim)

- "1. What if we just upgrade these static implementations to be `async`? That way,
  they could make a request if-needed (i.e. to pull an active recent list of models)?"
- "2. Let's use the native API surface. We don't want or need to match OpenAI. This
  hardness is deliberately being designed from the ground-up to be able to be used
  with ANY agent"
- 2026-09-28, on discovery base URL: "This is fine for now. We can upgrade and get
  more complex later" => single global `OLLAMA_HOST` (default
  `http://127.0.0.1:11434`) is acceptable.
- 2026-09-28, on fallback model: "yes, I would like DeepSeek to be the fallback
  model" => static fallback option list includes `deepseek-v4.1-flash:cloud` as the
  default.

## 9. Resolved questions

- Discovery base URL: global `OLLAMA_HOST` default; multi-host deferred.
- Fallback model: `deepseek-v4.1-flash:cloud` remains the `model` field
  `defaultValue` and is present in the static fallback `options`.

## 10. Environmental awareness: AeorDB instability

Owner note 2026-09-28: AeorDB is mid-refactor (>1 month). The public `aeordb` binary
is believed to be the latest stable, but a newer refactor binary may have been
installed, which could break Kikx startup. Owner is not very concerned and states the
current Kikx DB is all test data.

Response: no plan change. Before any AeorDB start/stop that risks the current DB,
follow quirks (`rules.md` AeorDB section): preserve suspected-corruption evidence,
SIGINT/SIGTERM not SIGKILL, investigate copies, and do not run destructive recovery
without explicit direction. If the DB is lost it is accepted test-data loss.

## 11. Roadmap (owner-requested, deferred): direct Ollama Cloud with API key

Owner ruling 2026-09-28: "before we are done with this project, I'd also like the
ability to hit Ollama directly using an Ollama API key." Not part of P0-P2.

Design sketch (to be planned as its own phase, P3):
- Add optional secret config field `apiKey` (`secret: true`, not required) to the
  Ollama provider. Kikx already routes `secret:true` fields through
  `AgentManager`/`secretState`, so the UI/plumbing exists.
- When `apiKey` is present, `ask()` sends `Authorization: Bearer <apiKey>` and uses
  `baseUrl` pointing at the Ollama cloud endpoint (native `/api/chat` shape, NOT
  OpenAI-compat, per standing ruling). When absent, current daemon behavior applies.
- `baseUrl` stays an explicit config field so local-daemon and cloud can coexist as
  two agent configs; no inference magic.
- Known limitation to solve in P3: `resolveConfigFields()` discovery has no per-agent
  config/secret, so an authenticated `/api/tags` cannot use the agent's key. Options:
  a global `OLLAMA_API_KEY` env for discovery, a curated fallback list, or a larger
  contract change to make discovery config-aware. Default to curated fallback +
  optional env key.
- Note: the local CLI exposes no direct-key flow (`ollama signin` is daemon-managed);
  direct-key calls mean treating `ollama.com` as a plain HTTP endpoint with a Bearer
  token, not using the local daemon.

## 12. Completion evidence (2026-09-28)

Delivered:
- P0 async provider descriptors: kikx `e87dedf`.
- Core bug fix (provider Done usage lost in the shared ask loop): kikx `7d7a691`.
- P2 Stagehand coverage + gitignore + this plan: kikx `f962c0a`.
- Codex plugin completion-review handling, request timeout, usage specs:
  `kikx-plugin-codex` `6b6fcfd`, `a2d1ccc` (private `th317erd/kikx-plugin-codex`).
- New plugin `kikx-plugin-ollama` `7ec6c02` (private `th317erd/kikx-plugin-ollama`).

Verification:
- kikx `npm test`: 356 pass / 0 fail (was 351 before the usage fix).
- `kikx-plugin-codex` `npm test`: 12 pass / 0 fail (2 pre-existing drift failures fixed).
- `kikx-plugin-ollama` `npm test`: 10 pass / 0 fail.
- kikx `npm run test:ui:stagehand`: 18 pass / 0 fail (AeorDB v0.9.5 running).
- Real daemon `ask()` smoke: discovery returns `deepseek-v4.1-flash:cloud`; streams
  thinking + final `pong`; usage `{inputTokens:74,outputTokens:16,totalTokens:90}`.
- Real daemon tool loop: `get_weather({city:'Paris'})` executed, result fed back,
  final answer produced, `content.toolResults` populated.
- Real dev E2E through running Kikx (`127.0.0.1:3001`): created an `ollama-agent`
  via API, created a session, `/invite`d it, sent a message, observed streamed
  `pong`, and `/api/v1/tokens` recorded `ollama/ollama/ollama-agent`
  (tokensUsed 48643). This also proves the P0 usage fix end to end.

Outstanding / follow-ups:
- P3 direct Ollama Cloud API key support (section 11) remains roadmap.
- `kikx-plugin-claude` and `kikx-plugin-google` are still legacy-contract and
  non-functional under the current loop; out of scope here. They expose empty
  configFields and load without error.
