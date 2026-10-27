# Owner UI review #2 — the four annotations, and what actually fixed them

Source screenshot: `session-2026-10-27-16-17-29.525.png`, mtime **2026-10-27 09:21:28 -0700**.
Fix commit: **`fed26ab`**, committed **2026-10-27 10:57:12 -0700** — i.e. 1 h 36 min *after*
the screenshot. So all four items were already implemented when the second request arrived;
the job here was verification against committed bytes, not new code.

Verified at HEAD **`d080162`** on `:3001` (pid 960832, cwd `…/kikx-workspace/kikx2`).

## The four annotations

### 1. "Agents and Teams should be grouped with, and have the same styling as, Inbox and Activities"

**Cause.** Every non-chip descriptor rendered as `button.kikx-sign-out-button` — the *same*
class as the footer's Sign out. Agents/Teams were wearing footer-identity styling while
sitting in the view cluster, which is exactly why they read as misplaced controls.

**Fix** (`kikx-sidebar-session-objects.mjs:126-133`): a `group === 'view'` branch renders
`button.kikx-sidebar__view` wrapping `span.kikx-sidebar__view-label`, and the shared rule
lives beside the Inbox/Activities rule in `questions.css` so all four are *one* rule, not two
copies that can drift. `button.textContent` still equals exactly `Agents`/`Teams`, which seven
stagehand specs depend on.

**Proof** (`.gate/reverify-e2e-item1-sidebar.log`, 9/9 pass, real authed DOM):
`font-size 16.25px`, `font-weight 600`, colour `rgb(220,227,234)`, padding `9px/11px` — all
`consistent:true` across all four; all four share nearest common ancestor
`section.kikx-sessions`; all four geometrically on one column (`left:18 width:243`,
`dLeft:0 dWidth:0`); `1b` asserts Agents/Teams no longer carry `kikx-sign-out-button`;
`1g` asserts the footer cluster still does.

### 2. Edit pencil — too large, and "NO WAY to leave edit mode"

This was **two** defects and actually three, all real.

**(a) Pencil size.** The glyph was 27.5px: a `kikx-icon` at `1em` inside a 34px
`kikx-icon-button` inheriting `app.css`'s `calc(22px * 1.25)`. Fixed by scoping a 15px glyph
to the crumb pencil in `topbar-unified.css`.
Proof: `glyphFontSize 15px`, glyph `15×15`, hit target still `26×34` (both asserted).

**(b) Escape / blur / navigate — all dead because focus was never in the field.**
`beginSessionNameEdit` focused `input[name="session-name"]` while the crumb input is built as
`.name('crumb-name')`. Focus never landed, so the input's own `focusout` and `keydown`
handlers could never fire, and `editingSessionNameID` was only ever cleared from inside those
handlers — hence "even navigating around the app won't do it". Fixed with four independent
exits (`kikx-navigation.mjs`): a document-level capture-phase `Escape`; a real focus of the
actual selector; cancel-on-navigation via a `navigationStack` subscription; and a cancel sweep
on render.
Proof (`.gate/reverify-node-eng-item2-proof.log`, 10/10): `Escape` exits with focus nowhere
near the field; a `navigationStack` change clears the edit; the listener backstop clears it;
switching to a view entry clears it; and — the control — a repaint with an *unchanged* stack
keeps the edit open, so this is not "cancel on any render".
Proof (`.gate/reverify-node-eng-item2-browser.log`): `2b(ii)` Escape with focus outside the
field, `2b(c)` click-away, `2b(d)` navigate to another session while editing.

**(c) Cancel *renamed* the session.** Found while fixing (b), and worse than what was
reported: the sequence is `mousedown → input blur → focusout → click`, so an unconditional
blur-commit ran *before* Cancel's own handler, clearing `editingSessionNameID` and PATCHing
the half-typed name. A guard was added that refuses to commit when focus moves to the
editor's own buttons, plus a cancelable-`mousedown` guard for Safari (which does not focus
buttons on click).
Proof, three independent layers:
- `.gate/reverify-e2e-item2-cancel-realclick.log` (7/7) — **real Playwright pointer click** on
  the real authed app: `Cancel MUST NOT PATCH THE SESSION → patchCount:0`; server title
  unchanged; Save issues **exactly one** patch (a double-patch would mean focusout+click both
  committed).
- `.gate/reverify-node-eng-item2-cancel-focusout.log` — `focusout → Cancel does NOT commit`,
  `Cancel click cancels`, `Save click issues EXACTLY ONE PATCH`, and the control
  `focusout to OUTSIDE the editor still commits` so click-away-to-commit still works.
  `Safari: mousedown guard present … commitsWithoutMousedown=1` documents that the mousedown
  path is load-bearing, not decorative.

**Known harness failure, not an app defect.** `.gate/node-eng-item2-browser.mjs` reports
`FAIL ITEM2b(e) a visible Cancel control exists` (`visible:false`) and exits 1. That probe
seeds a fake `SESSION = 'probe-session'` into a synthetic mini-DOM with no real stylesheet, so
the hover-revealed Cancel cannot report `visible:true` there. The real-app probe clicks that
same `button[aria-label^="Cancel rename"]` with a genuine pointer click and passes. I am
recording this rather than editing the probe, because a probe that only passes in a fake DOM
is the weaker artifact.

### 3. Eye filter should be hugged up against Search

**Cause.** The eyeball lived in the trailing `kikx-window__actions`, past the session objects.
**Fix** (`kikx-topbar.mjs`): it is now inside `div.kikx-topbar__search-group` immediately right
of the field — "search things together" is true *structurally* (the group is the common
ancestor), not by eyeballed pixel gaps.
**Proof** (`.gate/reverify-e2e-item3-eye.log`, 5/5): `gap:4`, `verticalCentreDelta:0`,
`domOrder:["search","eye"]`, `eyeInsideActions:false`, `eyeInsideGroup:true`, and it renders at
**root with no session selected** (`selectedSessionID:""`) — the earlier placement only
appeared inside a session.

### 4. "Our 'thinking' brain is BELOW and BEHIND other elements"

**Cause.** `.kikx-thread` had **four** grid tracks for **three** children, so the dock got an
auto-placed row under the composer and the composer covered it.
**Fix** (`topbar-unified.css:427-429`): `.kikx-thread { grid-template-rows: minmax(0,1fr) auto auto }`.
`app.css:435-437` is **untouched** — it still owns the shared 4-track rule used by
`.kikx-workspace`. Cascade verified by load order: all three declarations tie at specificity
`(0,1,0)`; the `topbar-unified.css` one wins by being last in `index.html`.
**Proof** (`.gate/reverify-e2e-item4-measure.log`, 12/12, two viewports):
- `@1280x900` `gridTemplateRows:"643.625px 54px 104px"`, `trackCount:3`, `hasZeroTrack:false`
- `dockBottomOverlapsComposerTopBy:0`, `dockBottom:767 composerTop:767`
- all 5 brain sample points hit `brain=true|composer=false`, `failingPoints:[]`
- `@1280x620` same shape: `363.625px 54px 104px`, overlap 0, 5/5 points correct
- **Control that matters:** re-injecting the 4th track on the same live page reproduces the
  original defect exactly — `697.625px 0px 104px 0px`, `overlap:54`,
  `centreHit:"button.kikx-composer-history-button"`, all 5 points inside the composer. So the
  green is not a blind probe.

## Why it looked unfixed

Nothing was wrong with the app. Three mundane causes:
1. The screenshot predates the fix by 1 h 36 min.
2. Nothing needs building or syncing — `index.html` loads `/client/app.mjs` and
   `/client/styles/*.css` directly; there is no `dist/`, `build/` or `public/`. A browser
   reload is the entire delivery path.
3. `Cache-Control: no-cache` is set on every client module, stylesheet and on `/`, so a
   reload is sufficient and no hard-refresh is needed.

## What this does NOT prove

- **No screenshot/pixel comparison.** Every claim above is geometry, computed style and
  DOM structure. Visual feel — colour harmony, type rendering, whether the aligned crumb
  *looks* right — is unverified.
- **No live streaming agent has ever populated the thinking dock with thinking text.** All
  item-4 geometry comes through the app's own rack mount path; agent-driven *content* was not
  observed.
- **Safari is structurally argued only.** The cancelable-`mousedown` path has no Safari on
  this host; Chromium/Firefox behaviour is what was measured.
- Items 2 and 4 were measured at `1280×900` and `1280×620` only.
