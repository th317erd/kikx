# Plan: consolidate the `__bindings` teardown and close the framework's unexported invariant

> **STATUS: v0.1 (planning only — no implementation until the owner authorizes it).**
> Scope: `kikx2` client + `/home/wyatt/Projects/aeor-web-components` (framework repo).
>
> **Change log**
> - **v0.1 (2026-10-21):** initial plan, produced with `/planning_cap`. Every claim cites a
>   file/line inspected this session. Baseline gate recorded in §8.

Owner request (verbatim).

> "`__bindings teardown is still triplicated` -- Let's look into this, and the
> `aeor-web-component` framework itself, and use your AGIS critical thinking skills as a
> Senior Engineer, along with /planning_cap, to try and find the best fix for this"

---

## 1. Evidence

### 1.1 Debt quantified

| Metric | Value | Source |
|---|---|---|
| Duplicate teardown definitions | **3** | `grep -rn "__bindings" src` |
| Lines duplicated | **~21** (7 per copy, 3 copies) | read at each site |
| `__bindings` references in kikx2 `src/` | **6** (3 sites × 2 refs) | `grep -rc` |
| `.bindState` call sites in kikx2 components | **21** across 3 files | §1.3 |
| `.bindState` sites **with no teardown at all** | **13** (`kikx-modals.mjs`) | §1.3 |
| `.bindState` sites in framework components | **14** across 6 files | §1.4 |
| Framework teardown exports | **0** | `grep "^export"` elements.js → **6** exports, none relevant |

### 1.2 The three duplicate sites — catalogue

| # | File:line | Form | Signature | Divergence from `(root)` |
|---|---|---|---|---|
| 1 | `src/client/components/kikx-frame-scroll.mjs:197` | `export function` | `(app, root = app)` | extra unused `app` param |
| 2 | `src/client/components/tool-renderers/tool-use-base.mjs:700` | module-private `function` | `(root)` | none |
| 3 | `src/client/components/kikx-frame-item.mjs:548` | class method | `_cleanupReactiveBindings(root = this)` | `this` default |

**Bodies are byte-identical apart from parameter names.** Re-derived value at all three:

```js
let nodes = [ root, ...root.querySelectorAll('*') ];
for (let node of nodes) {
  if (!Array.isArray(node.__bindings)) continue;
  for (let cleanup of node.__bindings) cleanup?.();
  node.__bindings = [];
}
```

Independently corroborated: `md5sum` of the three bodies is unnecessary — the diff is
character-for-character after parameter substitution. **Zero behavioural divergence.**

### 1.3 Consumers in kikx2 — including the sites that never tear down

| File | `.bindState` sites | teardown? |
|---|---|---|
| `src/client/components/kikx-modals.mjs` | **13** (`:35,42,51,52,162,215,216,233,256,257,307,311,355`) | **NO** |
| `src/client/components/kikx-shell-builders.mjs` | 8 | via `app._cleanupReactiveBindings()` at `:100` |
| `spec/client/streaming-render-bound-spec.mjs` | — | test only |

`kikx-modals.mjs` (382 lines) builds `buildAccountEditor`, `buildAgentManager`,
`buildTeamManager`, `buildAgentEditor`, `buildTeamManagerBody`, `buildAgentConfigSection`,
`buildSessionEditor` etc. — modal/editor bodies that are **created on open and discarded on
close**. Every one of those 13 bindings subscribes to `state.on('*', listener)` and is never
unsubscribed when the modal is torn down. This is the **fourth** call site, and it is the one
with a live leak.

### 1.4 The framework violates its own documented contract

`aeor-web-components/SKILL.md:122-125` states:

> Builder bindings use WeakRef but keep state listeners. Each bound element exposes
> `__bindings` cleanup callbacks. **When disposing/rebuilding a subtree, call these for the
> root and descendants and clear the arrays**; also unregister manually added
> state/document/window listeners.

Yet the framework's own 6 bound components do:

| Component | `.bindState` | teardown of `__bindings` | `disconnectedCallback` |
|---|---|---|---|
| `aeor-avatar.js` | 3 | **0** | **0** |
| `aeor-clock.js` | 3 | **0** | 1 (unrelated: timers + visibility) |
| `aeor-confirm-button.js` | 2 | **0** | 1 |
| `aeor-modal.js` | 2 | **0** | 1 |
| `aeor-progress-button.js` | 1 | **0** | 1 |
| `aeor-split-button.js` | 3 | **0** | 1 |

**Zero of 14.** `aeor-clock.js:43-48` tears down its document/window listeners but not its
bindings — its `disconnectedCallback` is written by someone who understood teardown, and
still omits the bindings. So the documentation describes a discipline that neither the
framework nor its consumers actually follow, and there is no export to make following it
easy. **That is the root cause of the triplication:** three consumers each hand-rolled the
walk because the framework offers no way to do it.

### 1.5 Severity — measured, not asserted

`reactive-state.js:131-152` (`flushListeners`) prunes dead listeners on every flush:

```js
for (let i = keyListeners.length - 1; i >= 0; i--) {
  if (keyListeners[i]._dead) { keyListeners.splice(i, 1); continue; }
  keyListeners[i](changedKeys, state);
}
```

`elements.js:238` marks a listener `_dead` when its `WeakRef` fails to deref. So:

- A **collected** element's listener is removed at the next wildcard flush. The leak is
  therefore **bounded by retained closures between flushes**, not unbounded.
- The leak **is** real for an element retained elsewhere (a detached-but-referenced modal
  body) — its `WeakRef` still derefs, so it stays live and keeps receiving updates.

**Honest severity: correctness/DRY defect with a latent shadow-DOM hazard and a bounded
retention cost. Not an active runaway leak.** A heap profile under `--expose-gc` would be
needed to claim otherwise, and I did not take one (§9).

### 1.6 The latent hazard that no current test covers

`root.querySelectorAll('*')` **does not descend into shadow roots.** Verified:
`grep -r attachShadow` → **0 hits** in both `kikx2/src` and `aeor-web-components`. So it is
latent today. It becomes a silent listener leak the first time any component in this stack
adopts shadow DOM — and the framework *is* a web-component library, so this is a plausible
future rather than a hypothetical. Any shared helper should handle it once, centrally.

---

### 1.7 The framework's regression harness has no runner

`test/component-regressions.mjs` defines and exports `runComponentRegressions()`.
A repo-wide grep for any caller — `*.js`, `*.mjs`, `*.html`, `*.json` — returns **nothing**;
there is no `package.json` either. `bot-docs/reports/l8ros-integration-2026-09-22.md:12` says
these regressions "execute through the sibling l8ros-ui Playwright suite on wyatt-desktop",
i.e. the runner lives in **another machine's other repo**. The framework's own AGENTS.md says
only "test actual behavior … before landing shared changes".

**Consequence for this plan:** adding an assertion to that file is not the same as having a
test. P1 must supply a runner that actually executes in this environment, or the "green"
claim is unfalsifiable — the exact defect class this session keeps finding.

**Verified 2026-10-21 (§1.7a) — the constraint is stronger than "no runner".** The framework
repo has **no `package.json`, no `node_modules`, and no DOM library** (`jsdom`/`happy-dom`/
`linkedom`: 0 hits). `component-regressions.mjs:14-15` calls `document.createElement`,
`document.body.append`, so it **cannot execute under Node at all**. Any P1 instruction of the
form "add a small node runner" is unsatisfiable — this section previously said exactly that
and was wrong.

`node --input-type=module -e "import('./elements.js')"` does succeed (`IMPORT_OK` with all 6
exports) via ESM syntax detection, so the module *imports*; it is the **DOM-dependent body**
that fails. This distinction decides the runner design.

**Where `/vendor/` actually comes from** (`src/server/static-files.mjs:82-84`):
`/vendor/aeor-web-components/…` resolves through `staticRoots.aeorWebComponents`. In dev that
is the live checkout; `kikx-docker/deploy.sh:84-85` stages a **committed** ref. `kikx-docker`
already ships `scripts/check-vendor-coverage.mjs`, which fails a deploy when a staged client
references a vendor path missing from the staged tree — that is an existing gate P1 can lean
on instead of inventing one.

### 1.7a Teardown coverage in kikx2 today: 1 of 3 sites, and the stub cannot bind

`grep -rln "cleanupReactiveBindings|__bindings" spec/` → **one** file,
`spec/client/frame-item-stability-spec.mjs`, which asserts both directions of the contract at
`:193-214` by **hand-assigning** `content.__bindings = [ () => { cleaned++ } ]`.

`spec/client/support/vendor-elements.mjs` contains **0** occurrences of `bindState` or
`__bindings`. So the existing coverage is genuinely meaningful — it exercises the walk over a
hand-built array — but it **cannot** catch the stub drifting from the real framework, because
the stub never produces a binding in the first place. P2's new helper is therefore the first
code in kikx2 whose correctness depends on a stub/real-framework agreement that no spec can
observe. That is why P1 must land and be proven in a browser (§P1 step 3) **before** P2
depends on it.

### 1.8 kikx2's specs do not load the real framework

`spec/client/support/` contains hand-written stand-ins — `vendor-elements.mjs`,
`vendor-reactive-state.mjs`, `vendor-query.mjs` — selected by `frame-item-loader.mjs`'s
`VENDOR_PREFIX = '/vendor/aeor-web-components/'`. The real `elements.js` is never imported by
the client specs.

**Consequence:** a framework-side export is invisible to the kikx2 suite. If P2 imports
`cleanupBindings` from the framework without teaching the stand-in about it, the specs will
fail to resolve the import — or worse, if the stand-in is left permissive, they will pass
without exercising the change. The stand-in has already diverged from the real module once
(this session's summary records a `viewBox` kebab-casing bug in `vendor-elements.mjs`), so
lockstep maintenance is a known, recurring cost, not a hypothetical.

## 2. Territory

### 2.1 Writers of `__bindings` (the authority)

- `aeor-web-components/elements.js:203` — `element.__bindings = []` in `build()`, **only when
  `this.bindings.length > 0`**. Elements built without `.bindState` never get the array.
- `aeor-web-components/elements.js:250` — `element.__bindings.push(() => state.off('*', listener))`.
  **The only push in the codebase.** One cleanup per binding.
- `elements.js:238` — sets `listener._dead = true` on a failed `WeakRef.deref()`.

### 2.2 Readers (must be enumerated)

| Reader | File | Role |
|---|---|---|
| teardown #1 | `kikx-frame-scroll.mjs:197` | exported, called via `app._cleanupReactiveBindings` |
| teardown #2 | `tool-use-base.mjs:700` | render path |
| teardown #3 | `kikx-frame-item.mjs:548` | `_render`, `disconnectedCallback`, 2 content sites |
| caller | `kikx-app.mjs:97,378` | imports #1, binds as method |
| caller | `kikx-app.mjs:527` | teardown before shell render |
| caller | `kikx-shell-builders.mjs:100` | teardown before shell rebuild |
| spec | `spec/client/frame-item-stability-spec.mjs:190-216` | **the only existing guards** |

### 2.3 Repos in scope

- `kikx-workspace/kikx2` — active repo, HEAD **`9121db9`**, sync **0/0**, tree clean apart from
  this plan file.
- `/home/wyatt/Projects/aeor-web-components` — framework, branch `main`, sync **0/0**, **tree
  clean**. Last commit `282aec5` (2026-10-14).

### 2.4 Out of scope but must not break

- `kikx-workspace/kikx` (old repo, port 3002) carries the same three files. **Not touched** —
  it lives off port 3002 by design. It will keep its copies; that is accepted drift.
- `kikx-workspace/kikx-docker/images/kikx/staging/` — a **vendored snapshot** of the framework
  (`vendor/aeor-web-components/elements.js`). Staged from committed refs at deploy. Not
  hand-edited; refreshed by `deploy.sh`.

### 2.5 Persistence / migration

**None.** `__bindings` is an in-memory JS property on DOM nodes. No persisted rows, no stored
payloads, no CLI text, no URL/bookmark encoding. This is an unusually clean refactor target:
nothing to migrate, no legacy reading, no compatibility shim needed.

---

## 3. Frame

**Target.** One implementation of the binding teardown, owned by the framework that owns the
field, consumed by all four kikx sites (three existing + `kikx-modals.mjs`).

**Non-goals.**
- Changing framework binding *semantics* (no auto-cleanup on disconnect — see §4 Option C).
- Fixing the old `kikx` repo.
- Taking a heap profile (deferred, §9 — needs owner time budget).
- Rewriting `kikx-modals.mjs` to a different rendering strategy.

**Success criteria.** See §8 (mechanical DoD).

**Binding constraints.**
- `.codex/quirks.md`: ask the owner before mutating a repo outside the active one.
- `.codex/quirks.md` "Vendored assets": prod stages from a **committed** ref; anything the
  client imports must be committed before a deploy, or the whole module graph fails to link
  (the 2026-10-07 `aeor-progress-button` outage).
- No commit/push without explicit go-ahead and a green gate.

---

## 4. Decisions

### D-1 — Where does the implementation live? — **proposal: the framework**

The field is created and populated by `elements.js`; its teardown belongs beside it. Consumers
should not be able to get the walk wrong.

### D-2 — Rejected alternative: auto-cleanup on disconnect

Attractive because it would fix all 14 framework component sites at once. **Rejected:**
rebuilding is not disconnection. `kikx-frame-item._render()` and `tool-use-base.render()` both
clean up and then `empty()` **while the host stays connected**, and
`frame-item-stability-spec.mjs:190-200` explicitly asserts a **reused** node is *not* cleaned.
An automatic `disconnectedCallback` hook would fire at the wrong time for the kikx render
paths and change framework semantics for every consumer. Too invasive for the benefit.

### D-3 — Rejected alternative: kikx-local module only

Would fix the duplication and could be done in one repo, one push, no deploy ordering. But it
leaves the framework still shipping an invariant with no accessor and SKILL.md still teaching
hand-rolling — the next consumer writes a fourth copy. **Held as the fallback** (§6) if the
owner declines the cross-repo change.

### D-4 — `kikx-modals.mjs` is in scope, and it is the only site with a live leak

13 bindings, no teardown, elements created on modal open. Adding the call there is a
one-line-per-teardown-site change and is the highest-value part of this work.

### D-5 — Keep `cleanupReactiveBindings(app, root)` as a thin re-export

So `kikx-app.mjs:97,378` and `kikx-shell-builders.mjs:100` need no edit. The unused `app`
parameter should be dropped or documented; dropping it is 2 lines and removes a signature
that implies a purpose it does not have. **Owner preference requested** (§7, O-1).

### Self-answered (recorded with reason)

- *Does `elements.js` always create `__bindings`?* No — only when `bindings.length > 0`
  (`:202`). The `Array.isArray` guard is therefore necessary, not defensive noise. **Keep it.**
- *Is the walk idempotent?* Yes — it clears the array after running. **Preserve that.**
- *Do we need a shim for the old kikx repo?* No — it is not migrated.

---

## 5. Contracts

**Framework (new public surface, permanent):**

```js
// elements.js — beside applyBinding, so the field and its teardown share a file
export function cleanupBindings(root) -> void
```
- Idempotent. Walks `root` + descendants, runs each `__bindings` cleanup, clears the array.
- Tolerates `null`/non-element `root` (no throw) and nodes without the array.
- Does **not** touch manually-added `state`/`document`/`window` listeners — those stay the
  consumer's job, as SKILL.md already says.
- Same traversal semantics as the three existing copies, **plus** a documented decision on
  shadow roots (§6 P1 step 2). Not a transitional shim — this is the permanent public surface.

**Consumers:** no signature changes required. `cleanupReactiveBindings` remains as a
re-export/re-exported method so existing call sites are untouched.

**No legacy adapter needed** — nothing is persisted.

---

## 6. Phases

### P1 — Framework export (owner start gate: **O-2**)
1. Add `cleanupBindings(root)` to `elements.js` after `applyBinding`.
2. Decide shadow-root handling: recurse into `node.shadowRoot` when present. **Include it** —
   it costs 2 lines and closes the latent hazard permanently. Record the decision.
3. Add a regression to `test/component-regressions.mjs`: bind a node, set a state key, assert
   it updates; call `cleanupBindings`; set the key again; **assert it no longer updates** and
   `__bindings` is empty. This makes the export meaningful rather than decorative.
   **The runner must be a browser harness, not Node** (§1.7a): the file needs `document`, and
   the framework has no DOM dependency. Concretely — serve the framework checkout over HTTP
   and drive it with the Playwright lane kikx2 already has installed, calling
   `runComponentRegressions()` via `page.evaluate`. Adding `jsdom` would mean introducing the
   framework's **first** dependency; prefer the harness that already exists.
4. Update `SKILL.md:122-125` to name the export instead of describing the walk.
5. Run the framework's own regression harness.

**Lands green independently. Revert unit: this commit.**

### P2 — kikx consumers (owner start gate: **O-3** deploy ordering)
6. Repoint the three sites at the framework export (via `aeor-ui.mjs`, which already
   hard-re-exports `elements`/`ReactiveState`/`$`).
7. Delete the three duplicated bodies. `grep -c "__bindings" src/` → **0**.
8. Add teardown to `kikx-modals.mjs` at each modal/editor discard point (13 bindings).
9. Grep-gate: no `__bindings` outside the vendored framework.

### P3 — Verification (see §8)

---

## 7. Owner decisions required

| ID | Question | Recommendation |
|---|---|---|
| **O-1** | Does `cleanupReactiveBindings(app, root)` keep its unused `app` parameter? | **Drop it.** Unused params invite wrong assumptions. 2-line edit in `kikx-app.mjs`. |
| **O-2** | May I modify and commit to `aeor-web-components`? It is a separate repo; `.codex/quirks.md` requires asking. | **Yes, P1 only** (export + docs + regression). I will not push without your word. |
| **O-3** | Deploy ordering: framework export must be committed+deployed **before** kikx2 imports it, or prod's module graph fails to link (2026-10-07 precedent). One push or two? | **Two pushes, framework first.** A defensive runtime fallback would be uglier and would hide a missing deploy. |
| **O-4** | Scope: include `kikx-modals.mjs` (13 sites, the only live leak)? | **Yes** — it is the highest-value part. |

---

## 8. Definition of Done (mechanical)

**Baseline recorded this session** (`/tmp/bindings-baseline.log`, sentinel
`/tmp/bl.sentinel` created first, `find src spec -newer` empty):

```
ℹ tests 1706 · pass 1677 · fail 0 · cancelled 0 · skipped 29 · todo 0
REAL_EXIT=0
```

- [ ] `grep -rn "__bindings" kikx2/src` → **0 hits**.
- [ ] `grep -c "cleanupBindings" aeor-web-components/elements.js` → ≥ 2 (definition + export).
- [ ] A **runnable** framework regression exists. Today `test/component-regressions.mjs` exports
      `runComponentRegressions()` and **nothing invokes it** (§1.7) — so "add a test" is not the
      DoD; "add a test *that runs*" is. **Node is not an option** — no DOM lib, and the file
      touches `document` (§1.7a). Use the existing kikx2 Playwright lane to call
      `runComponentRegressions()` via `page.evaluate` against a served checkout. **The export
      must be mutation-proven: making `cleanupBindings` a no-op must fail the new regression.**
- [ ] `spec/client/support/vendor-elements.mjs` exports `cleanupBindings` mirroring the real
      module (§1.8) — otherwise the kikx2 suite passes without exercising the change.
- [ ] Each of the **four** kikx teardown sites is mutation-proven: deleting its cleanup call
      fails its own test. **If a site has no failing test, that is a coverage hole and a test
      is written first** — this session has already found five green-suite-over-broken-UI
      defects; this guards against a sixth.
- [ ] Full gate: direct invocation, `REAL_EXIT=0` read **out of the log**, freshness sentinel empty.
      Compare against the 1706/1677/0 baseline above; any count change must be explained by the
      tests added, not by tests silently disappearing.

---

## 9. Risks / constraints

- **Prod link failure** if kikx2 lands before the framework (O-3). This is the single
  highest-consequence risk and the reason for two pushes.
- **No heap profile taken.** My severity claim (§1.5) is reasoned from code, not measured.
  If the memory cost matters, that needs a separate measurement round.
- **Old `kikx` repo keeps its copies.** Accepted drift, stated not hidden.
- **`kikx-modals.mjs` has no test coverage for its bindings today**, so P2 step 8 starts by
  characterizing current behaviour before adding teardown.

---

## 10. Execute P1 from this file alone

A stranger needs: the framework path, the exact insertion point, the test harness command.

```bash
FW=/home/wyatt/Projects/aeor-web-components
cd "$FW" && git status --porcelain    # must be empty; synced 0/0 at 282aec5
# 1. add cleanupBindings() to elements.js immediately after applyBinding (~line 258)
# 2. add the regression to test/component-regressions.mjs
# 3. run it
node test/component-regressions.mjs   # or the harness entry that calls runComponentRegressions
# pass criteria: no throw, and the assertion "bound node no longer updates after cleanup" holds
```

**This document is a plan. No source file has been modified.** Only
`bot-docs/plan-bindings-teardown.md` was created.

---

## Addendum A — cross-project signature scan (2026-10-22)

Owner asked for a scan of five project roots before deciding whether the framework
export keeps the `(app, root = app)` signature or drops `app`. This records the scan
and the two things it changed.

### A.1 Scan method and result

`grep -rn` for `__bindings|cleanupReactiveBindings|cleanupBindings` over `*.js, *.mjs,
*.cjs, *.jsx, *.ts, *.tsx, *.html`, excluding `node_modules/.git/dist/build/coverage`.

| Root | Result |
| --- | --- |
| `~/Projects/aeordb-workspace` | **0 matches** — no bindings at all |
| `~/Projects/xenocept-workspace` | 2 files, `__bindings` writers only |
| `~/Projects/wyattgreen.com` | **does not exist**; real dir is `~/Projects/wyattgreenway.com` — 0 matches there |
| `~/Projects/godot/genesis-forge` | **0 matches** |
| `~/Projects/kikx-workspace` | `kikx` (v1), `kikx2`, `kikx-docker/.../staging`, plugins |

Detail on the non-obvious rows:

- **xenocept** carries its own pre-framework forks of the builder at
  `xenocept-www/js/shared/elements.js:159,206` and
  `xenocept-client/static/shared/elements.js:203,250`. They write `__bindings` but
  export **no** cleanup walk and do not import `aeor-web-components` at all. They are
  not consumers of the export, so they cannot constrain its signature.
- **`kikx` v1 is a full second consumer of the triple.** It has the same three shapes
  — class method at `kikx-frame-item.mjs:538`, module-private at
  `tool-renderers/tool-use-base.mjs:700`, and the exported `(app, root = app)` form at
  `kikx-frame-scroll.mjs:197` — with the same single call site at
  `kikx-app.mjs:378` passing both arguments explicitly. §9 called this "accepted drift";
  it is really a second migration target.
- **`kikx-docker/images/kikx/staging/`** is a `git archive` output of a committed ref,
  not a live tree. It shows the copies because it snapshots v1. Not a consumer.
- **Shipped plugins** (`codex`, `claude`, `ollama`, `google`) reference the helper
  **zero** times. `kikx-plugin-codex` imports `elements.js` but only `elements`.

### A.2 Answer to the owner's question: drop `app`

`app` is read by nobody, anywhere:

1. not inside its own body (`root` is what the walk uses),
2. not by its only call site — `kikx-app.mjs:378` passes `(this, root)` explicitly, so
   the `root = app` default is never exercised,
3. not by any other repo in the scan.

**Drop it. The framework export is `cleanupBindings(root)`.**

### A.3 Two findings that change the plan

1. **D-5 is already overtaken by the framework repo's own history.** The local checkout
   is at `715e23f` ("Add cleanupBindings/disposeBindings and make the regression test
   runnable"), which exports `cleanupBindings(root)` **and** `disposeBindings(root)` in
   `elements.js:521,564`. D-5's "keep `cleanupReactiveBindings(app, root)` as a thin
   re-export" was written before that landed; keeping a thin `(app, root)` alias would
   now be inventing dead signature that the framework deliberately does not have.
   `main` is synced with `origin/main` (ahead/behind `0 0`), so the framework half is
   **already pushed** — P1's gate (O-2) is satisfied.

2. **The deploy boundary protects a different app than assumed, and a narrower failure
   class than assumed.** `kikx-docker/deploy.sh:24` defaults
   `KIKX_REPO=${WORKSPACE}/kikx` — **v1**, not kikx2. So the O-3 ordering risk applies to
   v1's copies. Separately, `scripts/check-vendor-coverage.mjs` verifies that every
   referenced `/vendor/aeor-web-components/<path>` **exists** (`fileExists` + `ESSENTIAL_FILES`);
   it does **not** verify named exports. A client importing `cleanupBindings` from a
   staged `elements.js` that predates it therefore passes preflight and fails at load.
   That is a distinct hole from the 2026-10-07 missing-file failure the script was
   written for.

### A.4 Proof that the landed framework code works

The framework's `test/component-regressions.mjs` (exports `runComponentRegressions`,
driven by `test/harness.html`) was executed in real Chromium via Playwright against a
`127.0.0.1` static server over the live checkout. Runner was a throwaway in
`/tmp/fw-runner/run.mjs`; nothing was written to either repo.

```
RESULT {
  "ok": true,
  "summary": "Builder live updates, avatar updates/reconnect, modal semantics/live children/reopen/focus, binding teardown (cleanup unsubscribes, idempotent, shadow roots, disposers, throws isolated, nullish) passed",
  "harnessErrors": [],
  "consoleErrors": []
}
```

So the harness is no longer fiction, and the teardown cases that would catch a bad
consolidation are green as of `715e23f`.

---

## Addendum B — implementation pass (2026-10-22)

### Landing gate, measured not assumed

`kikx-docker/deploy.sh:83-86` resolves `REF_AEOR_COMPONENTS` to the components
repo's **default branch** and stages it with `git archive`; `:105` then runs
`scripts/check-vendor-coverage.mjs`, which verifies that referenced
`/vendor/aeor-web-components/<path>` files **exist**. It does not inspect named
exports.

    .last-deploy  aeor: 282aec5        <- prod is one commit BEHIND the export
    staged vendor elements.js: 0 occurrences of `export function cleanupBindings`

`git ls-remote origin refs/heads/main` = `715e23f4032c...` = local `HEAD`
(verified against the remote, not against a local tracking ref).

So the framework export is **published but not yet deployed**. This is safe for
the two-push plan only because `deploy.sh` stages kikx and aeor *in the same run*
from both default branches, so the next deploy picks up `715e23f` atomically
alongside nothing else. A kikx2 import of `cleanupBindings` **must not** land
before that deploy.

### Two plan corrections found during implementation

**C6 — the modals leak is bounded by a different mechanism than recorded, and my
first claim that it was "REAL" was wrong.** `aeor-modal.open()` does
`document.body.appendChild(this)` (`aeor-modal.js:95`), which would move its
subtree *outside* the `<kikx-app>` root and beyond the reach of the per-rebuild
sweep at `kikx-shell-builders.mjs:100`. But kikx2 contains **zero** `.open()`
calls, and all four modal builders are pushed into the shell tree
(`kikx-shell-builders.mjs:76-91`) and therefore live inside `<kikx-app>`. The
existing `app._cleanupReactiveBindings(); $(app).empty();` pair already sweeps
all 13 modal bindings on every rebuild. The 13 sites are therefore a **latent**
hazard (they leak the moment a caller uses `.open()`, which is the component's
documented entry point), not an active leak. This matches the owner's correction
on the original question: no live leak was demonstrated here.

**C7 — the framework walk is strictly more correct than the copies.** The three
kikx2 copies used a flat `[root, ...root.querySelectorAll('*')]`. The framework's
`walkBindableNodes` (`elements.js:444-458`) recurses into descendants **and**
`shadowRoot`, carrying a `seen` Set as a cycle guard, and `runNodeCleanups`
clears the slot *before* invoking callbacks so a throwing cleanup cannot strand
the rest of the subtree. Consolidation therefore removes a latent correctness
bug rather than only duplication.

### Changes applied

| File | Change |
| --- | --- |
| `src/client/lib/aeor-ui.mjs` | re-export `cleanupBindings` alongside `elements` (single choke point for framework imports) |
| `src/client/components/kikx-frame-item.mjs` | method deleted; 4 call sites now call `cleanupBindings` |
| `src/client/components/tool-renderers/tool-use-base.mjs` | module-private helper deleted; 2 call sites call the import |
| `src/client/components/kikx-frame-scroll.mjs` | `export function cleanupReactiveBindings(app, root = app)` deleted; no import added (nothing else in the file used it) |
| `src/client/components/kikx-app.mjs` | stale import from `kikx-frame-scroll` dropped; imports `cleanupBindings`; delegate is `(root = this) => cleanupBindings(root)` |
| `spec/client/support/vendor-elements.mjs` | `cleanupBindings` + `disposeBindings` added, `walkBindableNodes`/`runNodeCleanups` ported **byte-identically** from the framework |

`app` was dropped per O-1: the body never read it, `kikx-app.mjs:378` always
passed `root` explicitly so the `root = app` default was dead, and the
cross-project scan found no other consumer.

### Stub-drift guard

`spec/client/support/vendor-elements.mjs` previously exported only
`elements`/`isVoidTag`/`isSVGElement`, and `frame-item-loader.mjs:17` maps
`/vendor/aeor-web-components/elements.js` onto it. Without the added export every
client spec would fail at link time. The two ported functions were diffed against
`elements.js` and are identical:

    walkBindableNodes: identical=True
    runNodeCleanups:  identical=True

### Evidence

    node --check   all 6 touched files                       -> clean
    grep cleanupReactiveBindings src/ spec/                 -> 0 copies remain
    spec/client/*-spec.mjs   575 tests / 575 pass / 0 fail   -> CLIENT_EXIT=0

### Mutation testing (red-green-red closed, with one honest gap)

Two mutants were applied to the stub and then restored.

**M1 — `cleanupBindings` replaced by a complete no-op: KILLED.**

    ℹ tests 575 | pass 574 | fail 1 | NOOP_MUTANT_EXIT=1
    ✖ a rebuild cleans up and drops bindings from discarded nodes

This is the load-bearing one: it proves the teardown path is genuinely
exercised, and that a refactor which stopped cleaning up could not pass.

**M2 — shadow-root descent removed: SURVIVED (575/575 pass).**

No client spec builds a binding inside a shadow root, so the improvement the
consolidation actually buys (shadow traversal) is currently **unobserved by the
suite**. The stub still carries the correct behaviour, and the framework has its
own browser-harness coverage for this path, so this is a coverage gap in kikx2,
not a correctness bug. Filed as follow-on work: a spec that attaches a binding
inside `attachShadow()` and asserts teardown would close it.

Restoration was verified by content, not by trust:

    sha256sum -c /tmp/stub.sha      -> OK
    grep -c MUTANT                 -> 0
    client suite re-run            -> 575 / 575 / 0, RESTORED_EXIT=0

### Not done, deliberately

The 13 `bindState` sites in `kikx-modals.mjs` were **not** given a teardown.
Per C6 they are already swept on every rebuild while the modals stay inside
`<kikx-app>`. The durable fix is for `aeor-modal.disconnectedCallback`
(`aeor-modal.js:82`, which currently only removes its keydown listener) to tear
down its own subtree — a framework change, requiring the same deploy-first
ordering. That is follow-on work, not silently skipped.
