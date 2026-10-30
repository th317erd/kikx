---
title: Browser-lane decision
status: current
doc_type: report
audience: [maintainers, developers]
applies_to: development-v3
---
# Browser test lane: which one to keep

**Date:** 2026-10-30
**Question (owner):** "Let's please use only one... whichever works the best for tests (Puppeteer or Stagehand)"
**Recommendation:** **Playwright** as the sole long-term lane. Do **not** delete Puppeteer yet — port its 16 unique specs first. Drop Stagehand.

---

## 1. Measured state, all three lanes, same host, same HEAD

| Lane | Specs | Tests | Deps | Runs here? | Latest result |
|---|---|---|---|---|---|
| `ui:playwright` | 13 | 18 | `playwright` only | **Yes** | **18/18 pass, EXIT=0** (5 of 6 runs); 17/18 once |
| `ui:puppeteer` | 17 | 20 | `puppeteer-core` only | **Yes** | **20/20 pass, EXIT=0** (2 consecutive) |
| `ui:stagehand` | 26 | 28 | `@browserbasehq/stagehand` | **No** | **never executed on this host** |

Import counts are exclusive — `grep -ho "from '...'"` yields exactly one browser
package per lane (`playwright`, `puppeteer-core`, `@browserbasehq/stagehand`), so
there is no hidden cross-dependency between them.

### Why Stagehand is disqualified on evidence, not preference

All 26 Stagehand specs gate on `loadStagehandOpenAIAPIKey()`. `OPENAI_API_KEY` is
unset and AereoDB on `:6830` is not listening, so **every spec skips** and the lane
exits **0 having asserted nothing**. That is the "PASS having executed zero tests"
defect in its purest form: it reports success by doing no work. It also drives a
real browser through a paid model, so it is slow and non-deterministic even when
it can run. It is the one lane with **zero** measurements behind it.

## 2. The two viable lanes barely overlap

Only **one** spec name is common to both lanes: `thinking-rack`. The globs are
disjoint (`*-playwright.mjs` vs `*-puppeteer.mjs`), so `npm test` never sees either.

- Playwright-only: 12 specs — `aeor-framework`, `agent-view`, `answer-feedback`,
  `emoji-picker`, `emoji-picker-keys`, `inbox-draft-preservation`,
  `inbox-frame-visual-parity`, `inbox-question`, `plugin-main-app`,
  `plugin-view-focus`, `team-manager`, `thread-scrollview`
- Puppeteer-only: 16 specs — `agent-progress-full-text`, `commit-runtime-event`,
  `composer-state-preservation`, `coordination-wake`, `deleted-sessions`,
  `empty-thread-recovery`, `frame-bottom-scroll`, `frame-filter-popup`,
  `frame-window`, `hidden-frame-filter`, `mention-message`, `mobile-layout`,
  `raw-markdown`, `todo-card-load`, `tool-output-overflow`, `user-message-markdown`

**This is why "just delete the lane you like less" is the wrong move.** Choosing
Playwright and deleting Puppeteer today would drop 16 specs — thread rendering,
frame windowing, mobile layout, tool cards, markdown — to zero coverage. The
recommendation is therefore *port, then remove*, not *switch*.

## 3. Why Playwright wins the port target

- **18 tests today vs 20, but a narrower failure surface.** Playwright's 18 tests
  were green in 5 of 6 recorded full runs; the single red run failed one spec
  (`aeor-framework`, see §6). Puppeteer was red in **every** full run for the whole
  of this session until its specs were repaired, going 13/18 → 20/20.
- **One dependency.** Playwright bundles its own browser. Puppeteer needs
  `puppeteer-core` plus a system Chrome at `/opt/google/chrome/chrome`
  (`findChromeExecutable()` reads `KIKX_STAGEHAND_CHROME_PATH`, `CHROME_PATH`, then
  system paths — `CHROME_BIN` is inert), so it breaks on any host without Chrome
  and every spec `t.skip()`s. Playwright here still drives system Chrome, so this
  is a smaller advantage than it first appears: **both lanes skip when Chrome is
  absent.**
- Playwright's auto-waiting assertions are structurally less prone to the failure
  class that dominated this triage (§4).
- Already the default in `npm test` (`DEFAULT_LANE_NAMES = ['unit','ui:playwright']`).
- **Fairness note:** Playwright's specs mostly assert visibility, text and
  navigation. Ten of Puppeteer's 17 specs assert computed style or geometry
  (`getComputedStyle`, `getBoundingClientRect`), which is why Puppeteer absorbed
  almost all the breakage. That is a difference in what the lanes *test*, not proof
  that one tool is better. Both drive the same Chrome 155.

## 4. The failure class — one disease, in both lanes

Every failure triaged this session was **the spec acted before the product's
asynchronous path completed**, or asserted a value the product no longer produces.

| Spec | Real cause | Evidence |
|---|---|---|
| `agent-progress-full-text` | asserted `rgb()` strings against `oklch()`+`color-mix()`, which Chrome 155 serialises as `color(srgb …)`; and asserted a lilac paint the mood band overrides | negative control forced `frameMoodBand` → `''`, went red |
| `frame-window` | hard-coded `<= 80` from `24b0065e`; the cap is now 120 | `git log -S` on the literal |
| `tool-output-overflow` | measured a `display:none` subtree (`clientWidth 0`, `scrollWidth 0`), so `0 > 0` could never hold | before/after reveal: 836 vs 2043 |
| `todo-card-load` | dispatched its reveal against an empty NodeList before mount | 15013 ms → 6 ms with a mount wait |
| `frame-bottom-scroll` | measured `scrollHeight - scrollTop - clientHeight` in the same tick as the rAF-eased `_scrollFramesToBottom` | 400 ms wait flipped it green |
| `commit-runtime-event` | scrolled with a synthetic `new Event('scroll')`, which the product **cannot** distinguish from its own programmatic placement | see §5 |

## 5. `commit-runtime-event`: a product-honest explanation

`onFrameListScroll()` (`src/client/components/kikx-frame-scroll.mjs:789-791`):

```js
let programmatic = Date.now() < (app._ignoreFrameScrollUntil || 0);
```

When `programmatic` is true, the handler skips the entire break-the-pin branch. The
window is opened by an initial bottom placement (`:171`, `+1000 ms`) and refreshed
on every step of the bottom-follow loop (`:691`, `:721`, `+220 ms`).

A synthetic `new Event('scroll')` sets neither `_ignoreFrameScrollUntil = 0` nor
`_frameListUserGestureUntil`; only real input does
(`_onFrameListUserInterrupt`: `wheel` / `touchmove` / `keydown`, `:551-580`).
So a fake scroll during that window is discarded and the viewport is re-placed at
the bottom.

**This is not a user-facing bug.** Measured three ways in one browser:

| Trial | What happened | scrollTop after 500 ms |
|---|---|---|
| A: synthetic event, immediately after connect | yanked back to bottom in 50 ms | 3196 (bottom) |
| B: **real wheel**, same instant | **held** — ignore window cleared to 0 | 1996 |
| C: synthetic event after 1500 ms settle | stays at top | **0** |

A human scrolling up is respected (B). The old spec was measuring its own fake
input (A). Fixed by scrolling with `page.mouse.wheel()` and waiting for arrival,
which is also what a user actually does.

## 6. `aeor-framework`: one known intermittent, in a sibling repo

`.gate/zav-pl-head.log` records `ZAV_PL_HEAD_EXIT=1` — Playwright 17/18 — with:

```
AssertionError: component regressions failed: Error: updatePage did not apply
the changed item
  at assert (test/behaviour/scrollview.mjs:8:25)
```

**Correction to an earlier draft of this report:** Playwright has *not* "never been
red on this host". It was red once, on this spec.

What the failure actually is:

- The check lives in a **different repo**, `/home/wyatt/Projects/aeor-web-components`
  (override: `AEOR_WEB_COMPONENTS_DIR`). `kikx2` serves it over a throwaway HTTP
  port and drives it with `playwright`. Nothing under `kikx2/test/` is involved,
  which is why grepping this checkout for the file returns nothing.
- `updatePage()` (`components/aeor-scrollview.js:293-309`) ends in
  `this._scheduleRender()` — rendering is **deferred** — while the framework's own
  test asserts `textContent.includes('updated')` after a bare `await wait(0)`.
  That is the same class of race as §4, now inside the framework's suite.
- Reproduced rate: **1 red in ~6 full runs**. Five consecutive isolated runs of
  just this spec were 5/5 green (`.gate/det-aeor-1..5.log`), so it needs a loaded
  box to surface, not an isolated one. 47 stale Chrome processes were resident on
  this host during the red run.
- Framework `src/` and `test/` trees were **clean** at the time — this is committed
  framework code, not a dirty working tree.

So: real, intermittent, and **not fixable from inside `kikx2`**. The honest options
are to raise the framework's wait to a `waitFor`-style poll, or to accept and track
it. Either way it is upstream of this repo.

## 7. What is proven vs not

**Proven**
- Playwright 18/18 EXIT=0 and Puppeteer 20/20 EXIT=0 at HEAD `8722b4e1`,
  sequentially, no Chrome contention.
- Per-spec negative controls for every spec changed, each going red at the original
  assertion and green after the fix.
- No `src/` file was modified by any test fix. `git diff --stat` touches specs and
  docs only.
- The lane gate is honest: `scripts/run-test-lanes.mjs` reports PASS/FAIL/EMPTY with
  executed counts and exits non-zero if any selected lane fails, so a lane that
  asserts nothing can no longer read as green.

**Not proven / open**
- **Long-run determinism for either lane.** Both have now shown a membership flip
  at least once. Single green runs are not a stability claim.
- `aeor-framework`'s intermittent (§6), which lives upstream.
- The 16 Puppeteer-only specs have not been ported. Until they are, Puppeteer is
  load-bearing and must stay.
- Stagehand's 28 tests have never run here; whether they pass is unknown, not green.

## 8. Recommendation

1. **Keep both lanes for now.** Both are green; deletion costs 16 specs of coverage.
2. **Drop Stagehand.** It cannot run on this host, and when it cannot run it
   silently reports pass. If it is kept, its specs must fail loudly when the key is
   missing rather than skip.
3. **Port the 16 Puppeteer-only specs to Playwright**, highest-value first:
   `frame-window`, `frame-bottom-scroll`, `tool-output-overflow`,
   `frame-filter-popup`, `hidden-frame-filter`, `mobile-layout`,
   `agent-progress-full-text`, `commit-runtime-event`.
   Port the *assertion*, not the tool. Carry the async-ordering lessons with them.
4. **Remove the Puppeteer lane only after** its unique specs are ported and green —
   and note the owner added two of those specs himself on 2026-10-30
   (`hidden-frame-filter` in `81c6f2f8`, `raw-markdown` in `d0b32190`), so this is
   live work, not dead weight.
5. **Track the `aeor` intermittent upstream.** It is the only red Playwright has
   produced, and it is in the framework repo's own suite, not in a `kikx2` spec.
