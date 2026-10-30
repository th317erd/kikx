# Owner UI review — 2026-10-27, answered against measurements

> **Active dated review — not established behavior.** Open and unverified findings below require confirmation against the current UI before implementation or closure.

Source: annotated screenshot `session-2026-10-27-04-43-05.158.png`, read by `bot-ocr`.
All claims below are from tool frames gathered 2026-10-27T04:50–04:52Z, at HEAD `47ebeda`.

## Environment correction (owner is right, prior memory was wrong)

`:3002` is **not** a forbidden clone. Measured:

| Port | PID | cwd |
|---|---|---|
| 3002 | 916413 | `/home/wyatt/Projects/kikx-workspace/kikx` — the kikx bot's own checkout |
| 3001 | 3834062 | `/home/wyatt/Projects/kikx-workspace/kikx2` |

Both share origin `https://github.com/th317erd/kikx`. Both are at `47ebeda`, both clean,
both `git rev-list --left-right --count origin/main...HEAD` = `0 0`.
`diff -rq src/` between the two checkouts: **empty**. There is nothing to sync.

There is likewise **no build step**: `package.json:12` is `"start": "node src/server/index.mjs"`,
`index.html` links `/client/styles/*.css` and `/client/app.mjs` directly, and `dist/ build/ public/`
do not exist. Client and CSS edits are live on browser reload.

## Defect 1 — duplicate toolbar: ALREADY FIXED, screenshot predates the fix

Owner annotation: *"Remove duplicate functionality… you added the new UI elements, but you
forgot to remove the old."*

Timeline (authoritative):

- screenshot mtime — `2026-10-26T21:45:02-07:00`
- `bed0eb3 fix(topbar): delete buildWindowHeader, the second toolbar` — committed `21:49:22`
- `:3002` process start — `21:50:08`

So the screenshot is **4 minutes older than the fix** and 5 minutes older than the restart.
The owner was looking at a pre-fix render.

Structural proof the duplicate is gone:
`grep -rn "class('kikx-window__header'" src/client/` → **0 hits**. The only emitter of that
class in the client is `kikx-topbar.mjs:311` `header.class('kikx-topbar kikx-window__header')`.
`bed0eb3` removed both the `buildWindowHeader` definition and its two call sites
(the root `'Projects'` header and the nested session header).

Owed: a browser reload. No code.

## Defect 2 — breadcrumb alignment: OPEN, dispatched to Prong A

Owner: *"Breadcrumb should move to the right, to line up with the right side of the sidebar."*

Why it is not a `padding-left`: `.kikx-main` (`app.css:179`) is
`grid-template-columns: minmax(220px, 280px) minmax(360px, 1fr)`. The sidebar's right edge is a
**fluid** track, so any constant offset drifts. Below `900px` (`app.css:2309-2312`) the layout
stacks to one column and the alignment must revert.

Prescribed fix: give the bar the *same* grid tracks as `.kikx-main`, brand in `grid-column: 1`,
and the lead/search/actions wrapped in one `.kikx-topbar__rest` at `grid-column: 2`.
All additive in `styles/topbar-unified.css`; `app.css` untouched (4035 L, 5x the 800-line hard cap).

## Defect 3 — Agents/Teams placement: OPEN, dispatched to Prong A

Owner: *"Agents and Teams should go up into the 'Session View' items."*

Today all five descriptors render as one footer cluster
(`kikx-shell-builders.mjs:259` → `buildSidebarSessionObjects`), pinned to the bottom by
`margin-top: auto` (`topbar-unified.css:187`). Descriptors are built in
`kikx-sidebar-session-objects.mjs:buildSessionObjectItems`.

Prescribed fix: add a `group` field (`'view'` for agents+teams, `'footer'` for
account-chip/account/sign-out), render the `'view'` cluster under
`buildActivitiesSidebarEntry(app)`, leave the rest at the foot. Keep the class
`kikx-session-objects` on **both** clusters (seven stagehand specs select it) and route
**both** through Prong B's `filterSessionObjectItems` so the ownership seam is not bypassed.
Label text stays literal — `clickButtonByText(page, 'Teams'|'Agents')` depends on it.

## State of the three prongs at dispatch time

| Prong | Session | msgCount | Status |
|---|---|---|---|
| A | `60e952cb` | 392 | assigned defects 2+3 |
| B | `37856013` | 307 | rulings issued; no reply yet |
| C | `d87b91c9` | 447 | rulings issued; no reply yet |

No reply from B or C at `04:52Z`. Their message counts are non-zero, so they have been active;
their answers are not in this session yet.

## Not yet verified

- No browser assertion that the *signed-in* app renders exactly one `.kikx-window__header`.
  `web-fetch` of `127.0.0.1:3002` returns the auth shell only ("K / Kikx / Agent runner"), which
  contains no header, so that probe proves nothing either way. The zero-emitter grep is the
  current evidence; a signed-in DOM count is still owed.
- Defects 2 and 3 are prescribed, not implemented. Nothing has been committed for them.
