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

## 12. Implementation status (2026-09-29)

P1-P4 delivered:
- `kikx-chat-view` (composable, `full`/`mini` modes) — full mode preserves the
  existing `.kikx-frame-list`/`.kikx-frame-stream`/`kikx-frame-item` DOM contract.
- `kikx-session-card` + `kikx-session-grid` + `chat-view-model.mjs` (pure view logic).
- Work area defaults to the **grid**; the sidebar remains an **empty shell**.
  A card or new session opens the full thread; back button returns to the grid;
  deep-link `?view=thread`.
- Preview data loaded in one bulk `POST /api/v1/sessions/previews` (chunked,
  bounded), patched per-card from runtime SSE (debounced), not refetched wholesale.
- Live SSE preview patch only applies while in grid view; selected session uses
  the full thread.

Verification:
- Unit 388/388; Stagehand 19/19; Puppeteer 1/1; Playwright 1/1.
- Live Brave E2E (debug port 9222): 22 real session cards with previews; expand
  a card to a 257-frame chat and back to the grid; zero console errors.

Notes / follow-ups:
- Transition (card->full scale/crossfade) is currently a view swap, not an animated
  shared-element transition; a later pass can animate it. Canvas full-redraw was
  rejected; HTML chosen (a content-visibility + contain card keeps offscreen cost low).
- Sidebar repurposing remains open by owner request (empty shell for now).
- No canvas/WebGL is used.

## 13. Navigation stack for recursive maximize/minimize (2026-09-29)

Owner ruling: maximize/minimize must work on a **DOM stack** because it is
recursive — sessions have sub-sessions that can themselves be maximized and
minimized. The flat `workspaceView: 'grid'|'thread'` boolean is replaced.

Model:
- `navigationStack: Entry[]`, root = `[{ kind: 'grid', parentSessionID: null }]`.
- Entry kinds:
  - `{ kind: 'grid', parentSessionID }` — cards for direct children of that
    session (root grid: `parentSessionID: null`).
  - `{ kind: 'thread', sessionID }` — a maximized session chat.
- Maximize a card: push `{ kind: 'thread', sessionID }`.
- Drill into sub-sessions: push `{ kind: 'grid', parentSessionID: sessionID }`.
- Minimize / Back: pop; at depth 1 the back control is hidden.
- Each entry renders its own DOM level; the shared-element hero morph runs
  between the popped/ pushed levels. Recursion = stack depth.

Data: session manifests carry `parentSessionID`/`generation`; `session-tools`
already sets `parentSessionID` on child sessions. Grid levels filter sessions by
`parentSessionID`.

Blast radius: `kikx-state.mjs` (replace workspaceView with the stack), `kikx-app.mjs`
(render by top entry; push/pop), the 2 Stagehand tests that read `workspaceView`.
The transition infra, hero naming, chat-view/card/grid components are unchanged.

Open decision (owner): what triggers drilling into sub-sessions?
Option A: parent cards show a "N sub-sessions" affordance; thread header shows a
  "Sub-sessions" button.
Option B: thread view embeds an inline mini-grid of its children.
Option C: both.
Recommendation: A first (smallest, explicit), B later.

## 14. Unified window-manager view + clickable messages (owner decisions 2026-09-29)

Owner design (recorded):
- Sub-sessions are a **normal message type**. Spawned sub-session frames render as a
  **live mini card in the chat stream**, in a user or agent bubble depending on who
  created it. Clicking enters the sub-session.
- A **"Show sub-sessions" toggle** hides ALL non-sub-session messages, so the parent
  chat collapses down to a grid of its sub-sessions. Grid view == "chat with everything
  but sub-sessions hidden." One view, one filter.
- **Unified single-screen window manager**: a session is maximized *over* the one under
  it; a "Close" button in the upper-right minimizes. Breadcrumb lives in the existing
  topbar.
- **All chat messages are clickable** with a special action: tools show run/output/result;
  user/agent messages show details (exact time, context); plugin frames can have custom
  actions. Sub-session cards are just one such type whose action is "enter session".
- Naming by scope: top-level = "Project", child = "Session", grandchild+ = "Sub-Session".
  System treats them identically; only user-facing labels differ.
- Empty card = "+ Add <scope noun>".
- Sub-session previews: **bulk fetch up front**, then **listen to SSE** for updates.
- Collapsed/grid mode shows what fits; **lazy-load older** as the user scrolls (sub-session
  history is bounded in practice, not loaded whole).
- Navigation is a **DOM stack** (session depth); recursion = stack depth.

### Technical gap found (must resolve before sub-session cards work)
The created child's ID is currently only inside the tool result frame's `preview` JSON
string (`content.preview` -> parsed `session.id`). That is too fragile to build a
first-class "enter" action on. Proposal: when a tool result creates/references a session,
stamp an explicit first-class reference on the result frame, e.g.
`content.references: { sessionID, parentSessionID }` (generic, not session-create specific),
so any tool/plugin can declare "clicking me opens session X." This also serves the broader
"all messages are clickable with a special action" model.

### Proposed first slice (v1)
1. Server: stamp `content.references.sessionID` (+ parent) on tool results that created a
   session (starting with session-create). Backfill not required; new frames gain it.
2. Client: sub-session frame renderer -> live mini card (reuse kikx-session-card mini mode),
   click = enter (stack push + hero morph).
3. State: replace `workspaceView` boolean with `navigationStack: [{ sessionID, collapsed }]`.
4. Header: breadcrumb (topbar) + Close (minimize) + "Show sub-sessions" toggle (collapsed).
5. Child previews: bulk by parentSessionID up front, patch via SSE.
6. Lazy-load older frames on scroll-up (harden the chat view if needed).
