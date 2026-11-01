# UserMessage delivery status — neutral → success

Status: **active plan only.** Nothing implemented. Implementation requires explicit owner authorization.

Date: 2026-11-01
Baseline commit: `7106d306` (`docs(report): re-certify frame-window at 0bc14bf0 …`), tree clean.
Requested by owner (verbatim intent): the user's message bubble is grey; it should also carry a
`success` and a `neutral` status. It is `neutral` by default, and becomes `success` as soon as the
message is "fed to the AI", at which point an update event is sent.

---

## 0. Existing knowledge (reused, not re-derived)

- Client/DOM rules from `AGENTS.md` + `~/.bot-common/codex/skills/aeor-web-components/SKILL.md`:
  `ReactiveState` notifies on top-level assignment only; rebuilding a live control re-runs its
  lifecycle; a rebuild that destroys a subtree is how an in-progress answer was wiped before.
  This plan never rebuilds the bubble to change a status — it toggles a class in place.
- File limits: 500 soft / 800 hard. `app.css` is already a known ~4130-line offender; this plan adds
  lines there but extracts nothing (a CSS split is out of scope and would be churn).
- `spec/core/runtime/model-prompt-capture-spec.mjs` and `spec/core/agents/agent-route-frame-plugin-spec.mjs`
  already exist and are the natural homes for new assertions.

## 1. Evidence (all from source at baseline `7106d306`)

### 1.1 Where the bubble is rendered
- `src/client/components/kikx-user-message-frame.mjs` — 328 lines. `updateFrame()` at `:24` calls
  `_ensureStructure()` (`:31`), `_renderText()` (`:87`), `_updatePrompt()` (`:120`). Structure is built
  once (`_structureReady`), and `_renderText` short-circuits on unchanged text (`:90`).
- `src/client/components/kikx-frame-item.mjs:116` maps `UserMessage` → `kikx-user-message-frame`.

### 1.2 Where the "grey" comes from
- The bubble has **no background of its own**. `.kikx-frame` (`app.css:881-918`) sets
  `border: 1px solid #303941; background: #171b1f;`. `.kikx-frame--UserMessage`
  (`app.css:678-680`) only sets `margin`; the second rule (`app.css:922-926`) only sets
  `justify-self: end`. That shared grey shell is the "grey" in the request.

### 1.3 Existing status machinery (and why it cannot be reused as-is)
- `src/client/components/tool-frame-summary.mjs:54` `normalizeFrameStatus()` maps **anything unknown
  to `running`**; `SUCCESS_STATUSES` (`:19`) already contains `'success'` and `ERROR_STATUSES` (`:20`)
  contains `'error'`.
- `kikx-frame-item.mjs:421-451` `_applyFrameState()` computes `tinted = compact || isBotCommunicationFrame(frame) || type === 'Question'`.
  `BOT_COMMUNICATION_TYPES` (`tool-frame-summary.mjs:9`) is `AgentMessage, AgentMessageDelta, AgentProgress`.
  **A `UserMessage` is therefore never tinted, never gets `kikx-frame--status-*`, and never gets
  `data-frame-status`.** Adding a status to a UserMessage today would be invisible.
- `frameStatus()` (`:63`) reads `content.status ?? content.state?.status ?? frame?.state?.status`.

### 1.4 Hazard A — a status named `success` would collide
`success` is already the generic frame status for "a tool step succeeded". Storing
`content.status = 'success'` on a UserMessage makes `frameStatus()` return `'success'`, i.e. it
claims the message itself succeeded as a tool operation. Any future tinting of UserMessage would
then paint it as a completed tool card. The delivery concept needs its **own** vocabulary.

### 1.5 Hazard B — the lifecycle normalizer would *close* the frame
`src/core/frames/frame-engine.mjs:18-29` `TERMINAL_CONTENT_STATUSES` contains
`'complete', 'completed', 'deleted', 'error', 'finalized', 'forwarded', …`.
`normalizeLifecycleState()` (`:627`) runs on **every** merge and, if `content.status` is terminal,
**stamps `state.lifecycle.status = 'closed'` with a reason**.
So writing `content.status = 'complete'` (or `'completed'`, or `'success'` if later added there)
would permanently mark the user's message closed, and `reason` would be that status. This is a
silent, durable state mutation of a message the user authored — unacceptable for a display concern.

**MEASURED, not inferred** (run 2026-11-01 against `FrameEngine` at `7106d306`):

| variant written on a real merged UserMessage | resulting `state.lifecycle` |
|---|---|
| `content.status = 'complete'` (control) | `{"status":"closed","reason":"complete","closedAt":1793554006359,…}` |
| `content.delivery = 'received'` (proposed) | `null` — untouched |

The control fired. The hazard is real, and the proposed key is provably clear of it.

### 1.6 Where "fed to the AI" actually happens (the live hook)
- `src/core/agents/agent-route-frame-plugin.mjs:237` `routeAgent({ …, frame … })`; `frame`/`userFrame`
  are set into `runParams` (`:296-299`).
- `:334` `for await (let output of runProviderWithRetry({ createProvider, runParams, … }))` — this is
  the first moment the user's message is handed to the provider. `runParams` is built at `:296`,
  provider constructed at `:291`.
- The trigger frame is therefore the routed frame itself. `targeting.mjs` / `normalize.mjs` already
  reject non-`UserMessage`, hidden, deleted and coordination-wake frames before reaching here.

### 1.7 The obvious-but-wrong hook
`src/core/runtime/frame-runtime-prompts.mjs:12` `recordModelPrompt()` already does a silent
in-place update of an existing UserMessage and stores `content.modelPrompt`. **It is dead in
production**: `grep` over `src/` and `node_modules` finds **zero** callers other than its own
definition and `agent-interface.mjs:95`. It survives only because specs exercise it.
Do **not** build this feature on `recordModelPrompt`.

### 1.8 Transport reaches the browser
- `frame-runtime-prompts.mjs:55-59` commits with `silent: true`; `silent` is read **only** by
  `src/core/routing/frame-router.mjs:41,56,171` to suppress *routing*, not publication.
- `frame-runtime.mjs:706-716` emits `frame.updated` for any commit whose change operation is
  `'update'`; `src/server/events.mjs:156` and `runtime-event-gateway.mjs:122` coalesce/publish it;
  `src/client/components/kikx-runtime-events.mjs:117` consumes `frame.updated` →
  `queueFrameRuntimeEvent` → `kikx-frame-item.updateFrame()` → `_reconcile()`
  (`kikx-frame-item.mjs:467`, which calls `_applyFrameState` at `:482` **in place, without rebuild**).
  So a status change can reach a live bubble without destroying it.

### 1.9 Persistence and model-context safety
- `src/core/aeordb/frame-store-serialization.mjs:3-12` `serializeFrame` **spreads the whole frame**,
  so a new `content` key persists with no migration and no index change.
- The model turn is built from `content.text` (`frame-type-base.mjs:100`, `frame-type-user-message.mjs:8-19`),
  not from the content object wholesale, so an extra content key does **not** enter the prompt.
  This is the check that makes the feature safe for the AI, not just the eye.

## 2. Territory (entry → storage → publication → client)

| Stage | File:line | Reads/writes the status? |
|---|---|---|
| User sends message | `frame-runtime.mjs:499` `appendUserMessage` → `#appendFrame` | writes it (new) |
| Durable store | `frame-store-serialization.mjs:3` spread | persists it (no change) |
| Engine normalizer | `frame-engine.mjs:627` `normalizeLifecycleState` | **must not** see it as terminal |
| Router | `frame-router.mjs:41,56,171` | ignores it (silent semantics unchanged) |
| Turn begins | `agent-route-frame-plugin.mjs:334` | **writes `success`** (new) |
| Publication | `frame-runtime.mjs:706` → `events.mjs:156` | publishes `frame.updated` |
| Client reduce | `kikx-runtime-events.mjs:117` | unchanged |
| Frame item | `kikx-frame-item.mjs:421-451` | **must tint UserMessage** (new) |
| Bubble | `kikx-user-message-frame.mjs` | renders in place (new) |
| Model context | `frame-type-base.mjs:100`, `frame-type-user-message.mjs:8` | must be unaffected |

Unverified edges, stated: the Discord/transport and merged-session copy paths
(`session-merge-service.mjs:355`, `process-manager-wake.mjs:100`, `pending-tool-recovery.mjs:215`,
`question-deadline-schedule.mjs:90`) also create `UserMessage` frames. They will inherit `neutral`
by default; none is expected to ever receive `success`, because none routes to a provider.

## 3. Frame

**Target.** A user message is visibly `neutral` from the moment it appears, and becomes visibly
`success` when a provider actually begins consuming it, without rebuilding the bubble.

**Non-goals.**
- No `failure`/`error` status. The request names two statuses; failure semantics ("was it ever
  fed?") need the provider-retry ladder to settle first. Deliberately out of scope.
- No change to what the model sees.
- No change to the grey base colour of neutral messages — the owner said grey is fine.
- No backfill of historical messages (they stay `neutral`, which is the truthful default).
- No removal of `recordModelPrompt` (dead code, but deleting it is a separate decision).

**Success criteria.** See §7 — each is an executable assertion.

**Binding constraints.**
1. The status key must **not** be named `status`, and its values must **not** be in
   `TERMINAL_CONTENT_STATUSES` (Hazards A and B).
2. The client must tint `UserMessage` deliberately, or the feature is invisible.
3. `normalizeFrameStatus`'s "unknown → running" fallback must not catch the delivery value.

## 4. Contracts

**Stored contract** — a new own-property on `content`:

```js
content.delivery = 'neutral' | 'received'
```

Rationale for each choice:
- `delivery` (not `status`) keeps it clear of the lifecycle normalizer and of the generic
  frame status that already means "this tool step succeeded".
- `received` (not `success`/`complete`) says exactly what happened — the AI has received it — and is
  not in `TERMINAL_CONTENT_STATUSES` (`frame-engine.mjs:18-29`), so the frame is never closed.
- Values are a closed set of two. Absent means `neutral` (legacy rows need no migration).
- Optional `content.deliveryAt` (epoch ms, same clock basis as `updatedAt`) records when.

**Client mapping**, added to `tool-frame-summary.mjs`:

```js
export function frameDeliveryStatus(frame) {
  let value = String(frame?.content?.delivery ?? '').trim().toLowerCase();
  return value === 'received' ? 'received' : 'neutral';
}
```

**CSS contract** — `kikx-frame-item.mjs` appends a single modifier:

```
kikx-frame--UserMessage kikx-frame--delivery-received
```

and sets `dataset.delivery`. Neutral adds nothing (grey is already correct), which means the
neutral path is a **no-visual-change** refactor and cannot regress the current look.

**Rejected alternatives** (recorded so they are not re-litigated):
- `content.status = 'success'` — Hazard A: collides with the generic tool-status vocabulary.
- `content.status = 'complete'` — Hazard B: closes the lifecycle durably.
- Reusing `content.modelPrompt` as the signal — §1.7: the writer is dead in production.
- Deriving "received" on the client from "an `AgentMessage` exists after this frame" — infers the
  effect from a proxy; wrong under retry, cancellation, and steering (`agent-route-frame-plugin.mjs:322-332`),
  and wrong for a second agent in the same session.

## 5. Decisions (self-answered from evidence)

1. **Which moment is "fed to the AI"?** Immediately before the provider iteration
   (`agent-route-frame-plugin.mjs:334`), after cancellation/steering guards (`:322-332`) have passed.
   Feeding a cancelled or steered turn would be a lie. — Reason: those guards return before any
   provider call, so a message that hits them was never fed.
2. **Should a retry re-send the update?** No. The first attempt already fed it; mark once and
   make the write idempotent (skip if already `received`), so the retry ladder
   (`provider-retry.mjs`) cannot produce a duplicate commit per attempt.
3. **Should the update be `silent: true`?** Yes. Reuse the exact semantics
   `recordModelPrompt` already relies on (`frame-runtime-prompts.mjs:55-59`): silently publish, never
   re-route. A non-silent merge would re-trigger the router and could start a second turn — the
   precise failure this flag exists to prevent.
4. **Does this need an API/route change?** No. It is a content merge on an existing frame.
5. **Do coordination wakes get a status?** No. They are `UserMessage` frames that are not chat
   (`kikx-frame-item.mjs:110-116`); the client gate excludes `kikx-frame--coordination`.

Open for the owner (only real authority questions):
- **Q1.** Confirm the visible affordance: I propose a thin accent left border plus an
  `aria-label`/`title` reading "Received by the agent", with the bubble's grey fill unchanged.
  Alternative: a small check/caret glyph in the header. Default if you do not object: the border.

## 6. Phases (disjoint files, each independently green and revertible)

**P1 — server writes `neutral` at creation.**
- Owned file: `src/core/runtime/frame-runtime.mjs` (`#appendUserMessage` / `buildUserMessageContent`
  call site at `:499`).
- Change: stamp `delivery: 'neutral'` on user-authored message content at creation.
- Done: a new user message stores `content.delivery === 'neutral'`.
- Revert: single file, single hunk.

**P2 — server writes `received` when the provider is fed.**
- Owned files: `src/core/agents/agent-route-frame-plugin.mjs`,
  `src/core/runtime/frame-runtime-prompts.mjs` (add a sibling method next to `recordModelPrompt`,
  reusing its silent-merge shape).
- Change: a new `markFrameDelivered(sessionID, frameID)`; called immediately before `:334`, guarded
  on the same predicates `recordModelPrompt` enforces (`:25-30`: exists, `type === 'UserMessage'`,
  `authorType === 'user'`, not hidden, not deleted). Idempotent: no-op if already `received`.
- Done: exactly one `frame.updated` per fed message; zero when cancelled/steered/suspended.
- Depends on P1 (the two statuses must be consistent).

**P3 — client renders it.**
- Owned files: `src/client/components/tool-frame-summary.mjs` (`frameDeliveryStatus`),
  `src/client/components/kikx-frame-item.mjs` (`_applyFrameState` tint + dataset),
  `src/client/components/kikx-user-message-frame.mjs` (aria/title only),
  `src/client/styles/app.css` (one new modifier rule).
- Change: as per §4. Explicitly add `UserMessage` to the code path that emits a delivery modifier —
  **not** to `BOT_COMMUNICATION_TYPES`, which would also change compaction/mood tinting behaviour.
- Done: DOM carries the modifier for `received` and none for `neutral`; no rebuild observed.
- Depends on P1/P2 for an end-to-end value, but its unit tests use fixtures and can land first if
  ordered that way; keep it serialized after P2 to avoid a half-wired surface.

**P4 — docs + regression notes.** One short section in `docs/` describing the contract and the
`TERMINAL_CONTENT_STATUSES` hazard, so the next person does not "simplify" it back to `status`.

## 7. Verification spine

Every item is executable; none is satisfied by a green that would pass without the change.

**V1 (failing-first, P1).** `spec/core/runtime/…`: append a user message; assert
`content.delivery === 'neutral'`. *Negative control:* revert P1 and re-run — must fail.

**V2 (P2 — the core proof).** In `spec/core/agents/agent-route-frame-plugin-spec.mjs`, use the
existing fake-provider harness: assert the routed frame is `received` **after** the provider is
iterated. Then four discriminating negatives, which are the whole point:
- provider throws before first yield → frame stays `neutral`;
- `hasAgentCancellation` true (`:322`) → stays `neutral`;
- `hasAgentSteering` true (`:328`) → stays `neutral`;
- merge committed with `silent: true` → router is not re-entered (assert no second `process`).

**V3 (Hazard B proof, non-negotiable).** After marking `received`, assert
`state.lifecycle?.status !== 'closed'` **and** `updatedClock` advanced. *Negative control:* the same
spec pointed at a variant that writes `content.status = 'complete'` must observe
`lifecycle.status === 'closed'`. Without this control the guard is untested and the hazard is only
a comment.

*Status: the negative control has already been executed once by hand and behaved as predicted
(`status:'complete'` → `lifecycle.status='closed'`, `reason='complete'`), while
`delivery:'received'` left `state.lifecycle` `null`. V3 turns that one-off into a permanent gate.

**V4 (Hazard A proof).** Assert `frameStatus(frame)` for a `received` UserMessage is **not**
`'success'` — i.e. the delivery vocabulary did not leak into the generic status.

**V5 (no model-context change).** Assert `frameToModelTurn(frame)` for a `received` UserMessage is
byte-identical to the `neutral` one. This is the check that proves the feature is display-only.

*Status: already measured — both produce `{"role":"user","content":"hello there"}`,
`TURNS_IDENTICAL true`. V5 makes it a gate so a future edit cannot quietly start leaking
`delivery` into the prompt.

**V6 (client, DOM-level).** In `spec/client/` with `mini-dom`: `updateFrame` with `neutral` → no
`kikx-frame--delivery-received`; then `updateFrame` with `received` → class present, and the
`kikx-user-message__text` node identity is **unchanged** (proves reconcile-in-place, i.e. the old
"rebuild wiped the node" class of bug does not recur).

**V7 (live end-to-end, real browser).** Puppeteer spec under `spec/ui/puppeteer/`: send a message in
a real session, assert the bubble is `neutral` while the composer clears, then `received` once the
turn starts. This is the only proof that survives the full transport path. Must be bounded by a
timeout and must assert on the DOM attribute, not on an exit code (see the te16 lesson: a harness
that swallows its own failure still exits 0).

**V8 (gates before push).** `node --test` on `spec/architecture/documentation-spec.mjs`,
`spec/scripts/test-lane-coverage-spec.mjs`, plus the full Puppeteer lane
(`node --test --test-timeout=60000 'spec/ui/puppeteer/*-puppeteer.mjs'`). Exit codes captured to
files, never read through a pipe.

**Named flake to isolate.** The Puppeteer lane has one known contention-sensitive boot timeout
(`commit-runtime-event-puppeteer.mjs:65`, 10 s budget). A red there is a known, bounded condition —
re-run isolated before attributing it to this feature.

## 8. Adversarial review (applied)

- *Omitted consumer:* the coordination-frame renderer shares the `UserMessage` type
  (`kikx-frame-item.mjs:110`). Handled by gating the new modifier off `isCoordinationWakeFrame`.
- *Persistence:* no index depends on `content.delivery`; `contentText` extraction
  (`frame-store-serialization.mjs:21-44`) ignores it, so previews/search are unaffected.
- *Coupling:* P2 touches the same file as the boot-timeout todo (`4ddb287d`), which is open but
  untouched — no live worker owns it (verified: all workers idle). No race.
- *Hotspot:* `kikx-frame-item.mjs` is edited by P3; it is 800+ lines and near the hard limit, so P3
  must add a few lines at `_applyFrameState` only — **no refactor inside this feature**.
- *Drift:* if `_promoteTailResponse` (added at `0bc14bf0`) mutates content on the same frames, the
  idempotent guard in P2 is what keeps the two from fighting.
- *Rollback:* each phase is one commit, one unit to revert.

## 9. Completeness

Absorbed here: creation stamp (P1), the live hook (P2), the render path (P3), and the two hazards
that would otherwise be discovered in review. Deliberately **not** in this campaign, on a
dependency-ordered roadmap:
- delivery `failure` (needs a decided failure taxonomy),
- a delivery indicator for coordination wakes,
- deleting the dead `recordModelPrompt` path.

## 10. Landing ritual

Integrate (`git fetch` + `merge --ff-only`; the remote moved 20 commits once already during a
certification in this repo) → run V8 gates against the **combined** revision → push once, only if
every gate is green → record results in `dod-evidence.md`. No push after a red gate; report the red.

## 11. Owner decisions outstanding

- **Q1.** Visible affordance for `received`: left accent border + accessible label (my default
  proposal) or a header glyph?
- **Q2.** Should the change also apply to messages sent by a transport/bot on a user's behalf
  (Discord), or only to messages the operator typed? My default: only operator-authored messages,
  because "the AI received *your* message" is a promise about you.
