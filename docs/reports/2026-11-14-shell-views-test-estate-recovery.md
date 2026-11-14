---
title: Test-estate recovery — from 0/28 infra-dead to a single gated blocker
status: current
doc_type: report
audience: [maintainers, developers]
applies_to: development-v3
---

# Shell Views test estate: recovery, isolation, and the one-command snapshot

Measured and fixed 2026-11-14. Stagehand began the day at **0/28** (every
test dying at load) and the estate ends at the definitive one-command
snapshot: unit PASS, playwright 18/18 PASS, puppeteer 61/61 PASS, and
stagehand 23/28 with **exactly the design-A five** as the only reds in the
entire estate (`node scripts/run-test-lanes.mjs --all`).

## The roots, by measurement

1. **Stagehand was infra-dead, not broken.** `resolveStagehandOpenAIAPIKey`
   fetched from AeorDB `:6830` (retired by owner ruling) and threw
   ECONNREFUSED at load — all 28 died before their bodies ran. Fix: keyless
   Ollama mode in the loader — `ollama/<model>` short-circuit, catch-and-
   degrade on the dead resolver, env-key honored first when present. Owner
   ruled the default after side-by-side controls: **DeepSeek 4.1 Flash
   (11/28) over MiMo (7/28)**, zero empty responses, `KIKX_STAGEHAND_MODEL`
   overrides.
2. **The fixture's unsorted frames inverted window bounds** (`oldestOrder: 2
   / newestOrder: 1`): the page-source filter required `order >= 2 AND
   <= 1` — impossible — so an empty thread rendered over a full store.
   `StagehandFrameRuntime` now sorts oldest-first at all four sites
   (production page-index contract).
3. **The expander raced two things**: the async frame list (open-before-
   render) and the inventory repaint (re-closes details). It now waits for
   frames, then loops until the full expected selector set is mounted —
   and clicks headers like a human, because tool frames start
   `kikx-frame--minimized` and only the real click path clears that class
   synchronously (raw `details.open` left 0x0 cards where visibility-aware
   waits correctly refused).
4. **Playwright hung to a 300s SIGKILL** — three waits, three roots:
   rail retargets (`role=tab`, aria-tolerant Inbox, badge-chip selectors),
   `.env.dev` granted per-spawn to `ui:playwright` BY NAME (fixture plugins
   were signature-refused → descriptors never arrived), and the P3a badge
   staleness — fixed in-place with `repaintRailUnreadBadge` because a full
   rebuild on answer is forbidden (`question-draft-preservation-spec`: it
   wipes drafts). Both pins green together.
5. **Shared-store pollution chain.** The theme test wrote purple/green into
   the shared dev Postgres (lane inherits `.env.dev`; fixture accounts share
   the id `stagehand-test-user`), shifting a sibling spec's accent-contrast
   baseline (2.86:1 vs 4.06:1). Fixed structurally: `startStagehandUIServer`
   gained `isolatedProperties` (an `:memory:` store through the designed
   `options.propertiesStore` seam) plus a one-time erase. The seam itself
   had a product bug: injection registered only the store while HTTP routes
   talk to the **facade** (P1 seam predating the P2 facade) → 503. Fixed in
   `properties-boot` (`ensurePropertiesAside`, both paths) with a fast unit
   pin proving `facade.read('core, …)` on a pre-seeded row.
6. **The live-parity gate was history-dependent**: `version === 1` only
   passed because each run reached its own delete (measured `4 !== 1` after
   accumulation; soft-delete bumps by design). Now asserts the real
   contract: positive integer versions, exact +1 increments, faithful
   roundtrip, cleared value — verified green twice consecutively.

## Ruled out, by measurement

- Expansion "ephemeral across repaints": the persist probe showed forced
  render keeps `open / custom / minimized` intact — `frameExpansionStore`
  was healthy; the earlier claim was wrong and is retracted.
- Layout geometry: the rail rides the shell grid (`display: contents`),
  rows `auto 1fr auto`, surface `grid-row 1/-1` — measured correct while
  the 3066 placeholder-height placement (below) was the real anchor bug.

## The remaining blocker (owner-gated: design A)

Anchors/history/window-cap/color-anchor/phantom-burst trace to one chain:
bottom placement ran against the scrollview's **estimated placeholder
height** (3500 − 434 = the measured pinned scrollTop 3066), real heights
arrived later (`sh` 3500 → 7231), the paged scrollview mounts
`follow: false`, and the scroll-event recompute flipped
`_frameListAnchoredToBottom` false — consuming the one-shot force flag.
Design: a provisional-bottom latch in `kikx-frame-scroll` +
`kikx-chat-scrollview`, snap on first `scrollview-page-loaded` when no
gesture window is active (gesture supremacy preserved), plus the window
clamp (no 200-item cap exists anywhere today). Evidence package and writer
map (13 flag sites) live in `.pi/HANDOFF.md`.

## Gates at close

unit 3,673/0/32 · playwright 18/18 · puppeteer 61/61 · stagehand 23/28 ·
cloud smoke (text/PDF/fallback) · live parity green ×2 · sweeper validated
(1,046 fresh / 0 stale) · classifier 6/6 · `:3002` healthy · trees clean.
