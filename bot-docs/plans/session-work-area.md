# Plan: Session Work Area — HTML Mini Cards + Bulk Previews (Task 2)

Status: ACTIVE — engine decided (HTML); next is P0b
Date: 2026-09-29
Owner intent source: "Kikx Project" session `51b8d96b…` (Task 2) + 2026-09-29 pivot
Supersedes earlier canvas-first framing in this file.

## 1. Goal

Replace the sidebar with a grid of **session mini-cards** that can smoothly expand into
the existing full-screen chat. Cards ultimately mirror projects, sessions and
sub-sessions (via the existing session parent/child). Cards must stay fluid with many
on screen (test target 30) and update in real time.

Engine: **HTML**, one component in two modes (`mini` | `full`), not canvas.

## 2. Owner intent (chronological)

- Extract the chat view into a composable component (original Task 2).
- Miniature mode: composer collapses, font shrinks, view becomes a card.
- Replace sidebar with a grid of session cards, grouped into Projects.
- Pivot explored: canvas/WebGL work area (fluid, animated, 12–30 live cards).
- After measurement: **commit to HTML** for now; pivot later only if real issues appear.
- Sidebar ruling (2026-09-29): a sidebar **is still wanted**; keep it as an **empty
  shell** for now and repurpose it later. Do not delete the sidebar region in P0b/P1;
  leave a placeholder container.

## 3. Territory (observed)

- Chat UI is DOM: `src/client/components/kikx-app.mjs` (1818 lines) renders
  `.kikx-shell` → `.kikx-sessions` sidebar + `.kikx-thread` body; per-frame rendering in
  `kikx-frame-item.mjs` (140 lines); styles in `src/client/styles/app.css` (1145).
- Browser-safe projection: `src/shared/frame-manager/frame-manager.mjs` exports
  `FrameManager`, `projectFrameMessages`, `upsertFrameMessages`, `countMessageFrames`.
- Large frame vocabulary: ~40 tool frame types + `UserMessage`, `AgentMessage`,
  `AgentMessageDelta`, `AgentThinking`, `BeginTyping`/`EndTyping`, `CommandResult`,
  `MessageDone`, `AgentProgress`, `CompactionFrame`; 4 DOM tool renderers in
  `src/client/components/tool-renderers/`.
- Frontend quirks: vanilla standards, custom elements, **no Shadow DOM, no frameworks/
  libraries/bundlers/build step**, `.mjs` + import maps; semantic HTML/ARIA; WCAG 2.1 AA;
  gate motion on `prefers-reduced-motion`.
- Browser test infra: Playwright + Puppeteer + Stagehand (Stagehand is the required UI
  coverage for UI updates).
- AeorDB: bulk `POST /files/fetch` (≤10,000 paths); directory listing supports
  `depth`/`glob`/`limit`. Frames at predictable paths
  `sessions/{id}/interactions/{iid}/frames/{order}-{Type}-{id}.json`.
- Current session list `GET /api/v1/sessions` returns manifests incl. `messageCount`.

## 4. Engine decision — HTML (owner ruling 2026-09-29)

Rationale (architecture, not just fps):
- HTML reuses the whole render stack (frame item, markdown, ~40 tool renderers, events,
  selection, ARIA). Canvas would rebuild all of it (text layout, hit-testing, a11y
  mirror, every tool renderer) for no gain.
- The browser gives free culling via `content-visibility: auto` + `contain: content` —
  exactly the per-card dirty tracking + offscreen caching canvas required.
- The hybrid crossfade collapses: mini and full are the **same HTML node in two modes**,
  so mini↔full is that node scaling, with text selectable throughout.
- Canvas was rejected by measurement (see §6), not hand-waving; artifacts kept.

Full-screen chat stays exactly as it is today; only the sidebar becomes a grid.

## 5. Contracts

- **One component, two modes.** A single custom element renders `mini` or `full`. Full
  mode is the current chat markup; mini mode is a bounded preview (no composer, smaller
  type, card chrome). Transition = scale the same node, not a second render path.
- **Input = preview data**, not full sessions: `{ sessionMeta, recentHeads }` from P0b.
  Mini renderer consumes only that; full-screen lazy-loads the real session on demand.
- **Culling**: grid cards use `content-visibility: auto` + `contain: content`; offscreen
  cards cost ~nothing.
- **Live updates**: subscribe to runtime SSE; patch only the changed card (append head,
  drop overflow) rather than refetching.
- **Accessibility**: semantic HTML, real text/roles, keyboard focus; motion gated on
  `prefers-reduced-motion`.
- **Module shape**: new vanilla `.mjs` custom elements under `src/client/` (no Shadow
  DOM), imported via the existing import map.

## 6. P0 spike — engine measurement (CLOSED)

Built a throwaway spike (`spec/ui/spike/canvas-cards/`) comparing Canvas2D vs HTML mini
cards, 30 cards, 10Hz **synchronized random updates across all cards**.

First harness was invalid (both modes reported the vsync cap, 16.67ms). Corrected to
time actual work. Then measured in the **real running Umbrafox** via UmbraLink
(input/diagnostics only — the page self-reports to a local collector; no nav/exec
channel exists yet), on **dual 2560x1440 @ 120Hz** → real budget **8.33ms**.

| Scenario | work avg | work p95 | frame p95 | @120Hz |
|---|---|---|---|---|
| canvas / light | 9.6ms | 12ms | 9.08ms | over budget |
| canvas / heavy | 31ms | 37ms | 33.3ms | ~30fps hitch |
| html / light | 0.425ms | 1ms | 9.1ms | within |
| html / heavy | 0.45ms | 1ms | 9.08ms | within |

Conclusions:
- Naive full-redraw canvas is **not viable at 120Hz**; dirty tracking + offscreen caches
  would be mandatory.
- HTML's *JS* cost is tiny, but its paint/layout is **still unmeasured** (Long Animation
  Frame observer returned 0 samples even in Umbrafox). The cross-engine verdict remains
  inconclusive by perf alone; HTML wins on architecture.
- Raw capture: `spec/ui/spike/canvas-cards/spike-results-umbrafox.json`.

Headroom caveat: before declaring 30 live cards "solved", measure HTML's real cost
including paint at 30 **preview-sized** cards. This is confirmation, not canvas
re-evaluation.

## 7. P0b — bulk preview / thumbnail system (NEXT)

Problem: 30+ cards must not each fully load a session. Current
`AeorDBFrameStore.listFrames()` lists **all** frames, bulk-fetches every body, joins
commits; `FrameRuntime.ensureSessionEntry()` hydrates a whole `FrameEngine` per session.

Verified AeorDB facts (live probe + source, 2026-09-29):
- Directory listings are **basename-sorted** (`btree` by child name; `sort_rebuilt_children`
  sorts by name). Frame filenames are zero-padded `order` prefixes, so **listing order ==
  frame `order`**, globally, across interaction subdirectories.
- `listDirectory` returns `{ items, limit, offset, total }`; `offset=total-K` yields the
  true tail (verified: last-5 returned the newest frames). Offsets beyond total return [].
- `POST /files/fetch` bulk-reads bodies by path (≤10,000).
- `query`/`search` need a registered index and are not used here.

Contract (final):
- **One bulk request**: `POST /api/v1/sessions/previews { sessionIDs, previewCount }`
  → `{ data: { previews: [ { sessionID, session, heads, truncated, error } ] } }`.
- Per session, in `AeorDBFrameStore.listSessionPreviews`:
  1. List once with `limit=1` to read `total` (paths only, cheap).
  2. List `limit=rawLimit, offset=max(0,total-rawLimit)` where
     `rawLimit = min(MAX_PREVIEW_RAW, previewCount * PREVIEW_RAW_EXPANSION)`.
  3. Bulk-fetch only those tail frame bodies.
  4. `projectFrameMessages(tail)` → keep visible thread heads → take last `previewCount`.
- Manifests fetched in one bulk `POST /files/fetch` for all requested IDs.
- No `FrameEngine` hydration, no full-history fetch.
- Bounds: `previewCount` default 5, max 20; `rawLimit` max 400; max sessionIDs per
  request 100. Missing/corrupt tail degrades that session to `{ heads: [], error }`.
- Client loader + SSE patching of individual card previews.

Cost: per request ≈ N×(2 path listings) + 1 bulk manifest fetch + 1 bulk tail fetch.
Bodies loaded are O(N·K), not O(total frames).

## 8. Phases

- **P0** canvas-vs-html spike — DONE/CLOSED (HTML chosen).
- **P0b** bulk preview endpoint + client preview loader — NEXT.
- **P1** single HTML chat component with `mini`/`full` modes.
- **P2** mini card chrome + mini↔full scale transition.
- **P3** grid of cards + full-screen transition; live SSE patching; 30-card target.
- **P4** integration (owner-gated): replace sidebar with grid; Projects via session
  parent/child; full-screen chat stays HTML.

## 9. Verification spine

- P0b: unit specs for preview bounds/degradation; server route test proving one request
  returns bounded previews for many sessions; a large-session fixture proves it does not
  load full history.
- P1/P2: unit specs for mode rendering + state→view mapping; Stagehand test proving a
  card renders preview content and expands to full and back.
- P3: Stagehand test for grid render + card→full→mini transition + SSE update; run the
  Umbrafox harness for a real 30-card, 120Hz paint-inclusive measurement.
- Perf gates recorded as numbers, not impressions.

## 10. Risks

- **Preview data correctness/bounds** — the crux; must be capped and degrade gracefully.
- **SSE patching complexity** across many cards.
- **Transition smoothness** at 120Hz on the real display (must re-measure, not assume).
- **Scope**: full Projects/work-area redesign is a campaign; land P0b + P1 first.

## 11. Spike artifacts / environment notes

- Throwaway spike retained as evidence: `spec/ui/spike/canvas-cards/` (page, renderers,
  model, puppeteer harness, collector, Umbrafox results). Not part of the build path.
- UmbraLink client: `spec/ui/spike/umbralink/umbralink-client.mjs`.
- Env: wyatt-desktop is the local host; dual 2560x1440 @ 120Hz. UmbraLink has no
  navigation/JS-exec command in this build (`umbrafox.gfx.snapshot` also absent); the
  page self-reports and the URL is handed to the running Umbrafox via the CLI.
