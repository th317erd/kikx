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
**Recommendation:** **Playwright** as the sole lane. Do **not** delete Puppeteer yet — port its 16 unique specs first. Drop Stagehand.

---

## 1. Measured state, all three lanes, same host, same HEAD

| Lane | Specs | Tests | Deps | Runs here? | Last result |
|---|---|---|---|---|---|
| `ui:playwright` | 13 | 18 | `playwright` only | **Yes** | **18/18 pass, EXIT=0** |
| `ui:puppeteer` | 17 | 20 | `puppeteer-core` only | **Yes** | **20/20 pass, EXIT=0** |
| `ui:stagehand` | 26 | 28 | `@browserbasehq/stagehand` | **No** | **never executed on this host** |

Import counts are exclusive — `grep -ho "from '...'"` yields exactly one package per
lane, so there is no hidden cross-dependency between them.

### Why Stagehand is disqualified on evidence, not preference

All 26 Stagehand specs gate on `loadStagehandOpenAIAPIKey()`. `OPENAI_API_KEY` is
unset and AeoroDB on `:6830` is not listening, so **every spec skips** and the lane
exits **0 having asserted nothing**. That is the "PASS having executed zero tests"
defect in its purest form: it reports success by doing no work. It also drives a
real browser through a paid model, so it is slow and non-deterministic even when
it can run. It is the one lane with **zero** measurements behind it.

## 2. The two viable lanes barely overlap

Only **one** spec name is common to both lanes: `thinking-rack`.

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

- Only lane that has never been red on this host.
- One dependency (`playwright`), which bundles its own browser; Puppeteer needs
  `puppeteer-core` **plus** a system Chrome at `/opt/google/chrome/chrome`
  (`findChromeExecutable()`), so it breaks on any host without Chrome.
- Playwright's `expect().toPass()` / auto-waiting assertions are structurally less
  prone to the failure class that has dominated this triage (below).
- Already the default in `npm test` (`DEFAULT_LANE_NAMES = ['unit','ui:playwright']`).

## 4. The Puppeteer failure class — now fully explained

Every Puppeteer failure triaged this session was **one disease**: the spec read
state before the product's asynchronous path had completed.

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

## 6. What is proven vs not

**Proven**
- Playwright 18/18 and Puppeteer 20/20 at HEAD, sequentially, no Chrome contention.
- Per-spec negative controls for every spec changed, each going red at the original
  assertion and green after the fix.
- No `src/` file was modified by any test fix. `git diff --stat` touches specs only.

**Not proven / open**
- Determinism across many repeats. The lane flipped failure *membership* twice
  earlier, so single green runs are not a stability claim.
- The 16 Puppeteer-only specs have not been ported. Until they are, Puppeteer is
  load-bearing and must stay.
- Stagehand's 28 tests have never run here; whether they pass is unknown, not green.

## 7. Recommendation

1. **Keep both lanes for now.** Both are green; deletion costs 16 specs of coverage.
2. **Drop Stagehand.** It cannot run on this host, and when it cannot run it
   silently reports pass. If it is kept, its specs must fail loudly when the key is
   missing rather than skip.
3. **Port the 16 Puppeteer-only specs to Playwright**, highest-value first:
   `frame-window`, `frame-bottom-scroll`, `tool-output-overflow`,
   `frame-filter-popup`, `hidden-frame-filter`, `mobile-layout`,
   `agent-progress-full-text`, `commit-runtime-event`.
4. **Remove the Puppeteer lane only after** its unique specs are ported and green —
   and note the owner added two of those specs himself on 2026-10-30
   (`hidden-frame-filter` in `81c6f2f8`, `raw-markdown` in `d0b32190`), so this is
   live work, not dead weight.
