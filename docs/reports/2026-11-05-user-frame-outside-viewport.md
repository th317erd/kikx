---
title: User message rendered outside the viewport — root cause and fix
status: current
doc_type: report
audience: [maintainers, developers]
applies_to: development-v3
last_verified: 2026-11-05
keywords: [thread layout, css grid, implicit column, viewport, user message]
---

# User message rendered outside the viewport — root cause and fix

Date: 2026-11-05
Reported symptom: the owner's own message rendered with only a sliver of its left
edge visible at the far right of the window, while agent messages looked normal.
No scrollbar appeared and scrolling did not recover it.

This is a **separate defect** from the per-session view-filter leak
(`a76a1ab9`). Neither cause nor fix is shared.

## Measured cause

`.kikx-thread__body` declared only `grid-template-rows`. Its single column was
therefore **implicit** and auto-sized, so it grew to the widest descendant's
min-content, which is far wider than the box while the message scrollview mounts.

Measured chain at first escape (2523px window, `/tmp/kikx-diag/chain-escape.log`):

```
USER FRAME  L=3222 R=3799 W=577  ml=2923.19px
.aeor-scrollview__items      L=299  R=3799 W=3500
.aeor-scrollview__page       L=299  R=3895 W=3596
div.kikx-thread__body        L=281  R=2522 W=2241  sw=3714  gtc=3678px  <== 3678px track in a 2241px box
section.kikx-thread          L=280  R=2523 W=2243  gtc=2241px
main.kikx-main               L=0    R=2523 W=2523
```

The mechanism has three parts:

1. An auto-sized implicit column lets a wide descendant inflate the track
   (3678px of track inside this 2241px box).
2. `.kikx-thread__body` clips (`overflow: hidden`) rather than scrolls, so the
   overflow is unreachable — which is why no scrollbar appeared and scrolling
   never brought the message back. Note the clipper is the **body**, not
   `.kikx-frame-list`: measured in the control arm the list had already been
   stretched to the widened track (`clientWidth = scrollWidth = 3668`,
   overflow 0), so it had nothing of its own left to clip.
3. User messages are right-aligned with `margin-left: auto`
   (`app-thread.css:2-6` `justify-self: end`, `app-composer.css:279-281`
   `margin: 0 0 10px auto`), so they anchor to the **far edge of the widened
   track** — i.e. they ride the overflow. Left-aligned agent messages stay at
   x≈0 and look normal. That is exactly the reported asymmetry.

## It is transient, and that matters

The escape is not a settled state. Sampled per DOM mutation
(`/tmp/kikx-diag/chain-escape.log`):

```
samples=188 escapedSamples=1
t=327ms   left=640  right=819  inside=true
t=1347ms  left=3222 right=3799 inside=FALSE   <-- the escape
t=1360ms  left=1749 right=2326 inside=true
```

Roughly 13ms, during the `aeor-scrollview` mount. Two consequences:

- A settled-state assertion cannot reproduce the defect. Confirmed empirically:
  removing the clamp from an already-settled page leaves the frame inside
  (`chain-both.log`, both arms identical). Any regression test must sample
  **during mount**, not at rest.
- It is a paint, not a persisted state: the frame is briefly off-window while
  the tree is being built, then lands correctly.

## Fix

`src/client/styles/app-base-shell.css`, `.kikx-thread__body`:

```css
grid-template-columns: minmax(0, 1fr);
```

One explicit column. `minmax(0, 1fr)` rather than `1fr` because a bare `1fr`
still has an `auto` minimum and would let a wide child inflate the track again.

### Why one declaration is the whole fix

`.kikx-thread` (the parent of the body) is *also* a rows-only grid, so it looks
like it needs the same clamp. Measured, it does not
(`node_modules/.kx-diag/probe-adjacent-chain.mjs`, 2523px viewport, clamp
removed):

```
section.kikx-thread    worstScroll= 2241 client= 2241 overflow=    0 cols=2241px
.kikx-thread__body     worstScroll= 3714 client= 2241 overflow= 1473 cols=3678px   <== only this widens
.kikx-frame-list       worstScroll= 3668 client= 3668 overflow=    0 cols=none
main.kikx-main         worstScroll= 2523 client= 2523 overflow=    0 cols=280px 2243px
.kikx-shell            worstScroll= 2523 client= 2523 overflow=    0 cols=2523px
```

With the body clamped, every one of those boxes reports
`scrollWidth - clientWidth = 0`. The widening originates only in the body, so
clamping it is sufficient; the parent and the shell never leave their boxes.

## Why it looked like it started with the mobile work

`mobile.css:100` already carries the *identical* declaration, inside
`@media (max-width: 640px)`. So narrow windows were clamped and only the base
(desktop) rule was left implicit — the defect was never visible on a phone and
always present above 640px. The mobile pass did not introduce the bug; it
removed the clamp for every width it did not cover. This is the mechanical
reading of the owner's dating ("right around the time we made updates for
mobile displays"): the work drew attention to grid containment, and the desktop
half of that containment was never written.

## Proof

Paired run, same spec bytes both arms:

| arm | result |
| --- | --- |
| clamp removed (pre-fix) | 2 samples outside, `left=2873 right=3799 window=2523` |
| clamp present (post-fix) | 0 escapes across 188-189 samples, including mount |

The `left` value varies with mount state because the frame rides the widening
track: a separate mutation-sampled probe recorded `left=3222`, which is the
figure quoted in the source comment. The right edge, 3799, is the stable signal.

Source: `/tmp/kikx-diag/bounds-context.log`, `chain-escape.log`,
`/tmp/unfixed-arm.log`, `/tmp/fixed-arm.log`.

Guard: `spec/ui/puppeteer/user-frame-viewport-bounds-puppeteer.mjs`.
It asserts the user frame is inside both the **window** and the thread's visible
box from first paint through a targeted `frame.updated` event, at
2523/1440/960/640px, with a deliberate 3000px child appended to an agent frame.

Two anti-vacuity devices, both of which caught real gaps:

- the sampler must have recorded >= 3 samples and the first must be tagged
  `first-paint`, so "zero escapes out of zero samples" cannot pass;
- a negative control that removes the clamp and **remounts** the thread, so the
  lane proves it is able to fail. An earlier in-place version of this control
  passed both ways and was worthless.

## Two false leads recorded, so they are not re-run

1. **"The window was wider than the screenshot."** An earlier hypothesis held
   that the browser window spanned both 2560px monitors (~3.64k px) while the
   capture covered one, making the sliver an artifact. Arithmetic fit
   (sliver ≈ 3680 − windowWidth). Measured false: the escape reproduces inside a
   single 2523px viewport with `window.innerWidth === 2523`.
2. **"A targeted update applies the offset after first paint."** Measured false.
   The offsets occur during mount, before any update; a targeted
   `frame.updated` leaves the frame inside (`after targeted update` assertion).

## The fix was briefly absent from the repository

Worth recording because the report asserts a fix that, for a short window, was
not in the tree it described.

`cf94a5d4` added the declaration and its comment together (committed 20:36:55).
`161fc573` (System Settings owner corrections, committed 20:44:47, eight minutes
later) touched the same file to add the brand-gear button rules, and its diff
removed this one line while **keeping the explanatory comment**:

```
      clips rather than scrolls. mobile.css already clamps below 640px. */
-  grid-template-columns: minmax(0, 1fr);
   grid-template-rows: minmax(0, 1fr);
```

The cause was mine. `cf94a5d4` committed the clamp, so the tree was clamped at
20:36:55; the line was therefore stripped **again** afterwards and never
restored before the settings work committed eight minutes later. The only reason
this declaration was ever removed is the paired no-clamp control arm for the
bounds measurement, which was interrupted (`/tmp/arm2-scrollview.log`, 20:17:32:
`cancelled 1`, `Promise resolution is still pending but the event loop has
already resolved` — a record of an interruption that proves nothing about the
result). No log of that particular post-commit strip survives, so the causal link
from the interrupted arm to the committed removal is an **inference from
timestamps and motive, not a measured fact**. What is measured is both commit
contents and the eight-minute gap between them.

The result is the worst reading of this report — the comment described a fix the
same rule no longer performed.

The guard spec would have caught it, but nothing was run between `161fc573` and
the next session. That is the actual gap: the spec existed and was not executed
by the change that removed what it guards.

Restored in the commit that follows `161fc573`, with the guard re-run at the
restored bytes first. The lesson generalises to this whole class of measurement:
**never leave the tree in the altered state across an interruption** — restore and
verify the hash inside the same command that performs the experiment, because a
server restart can end a session between two commands.

## Not verified

- The dev server on :3002 was confirmed to **serve** the fixed CSS: 200,
  `md5 f30d14c101fae7c0f51f0ab29ace940a`, 9466 bytes, clamp at line 492,
  byte-identical to the on-disk file. The figures differ from the first
  measurement (8997 bytes, line 468, md5 `2f47ca84`) only because `161fc573`
  added the brand-gear rules above this block; the declaration itself is
  unchanged. Byte identity between served and disk is a statement about the
  static serve path, not about one process, so the listening pid is not quoted
  here. What is **not** verified: the escape was never re-observed in the
  owner's real Chrome on his real session. The reproduction is a Puppeteer
  fixture, and serving the fixed bytes says nothing about that browser.
- The entry animation (`--kikx-frame--entering`) was sampled by the guard, but
  the guard does not separately assert the geometry mid-animation; it asserts
  every mutation sample stays inside, which covers it only as far as mutations
  coincide with the animation.

## Unrelated lane failures, and how that was actually established

The browser lanes have pre-existing failures that are not this clamp. Getting
that attribution right took three attempts, two of which were wrong, so the
method is recorded rather than just the verdict.

`ui:playwright` is 18 registered / 17 pass / 1 fail at `6738eaea`.
`ui:puppeteer` is 43 registered / 42 pass / 1 fail.

The single failure in each lane is in the lazy-paging subsystem:
`thread-scrollview-playwright.mjs:75` ("follows live tail appends", `follow:
false`, ~11.9 s) and `filtered-lazy-scroll-puppeteer.mjs` ("keeps a filtered
frame anchored while lazy pages load above it", ~12.8 s). Both are vertical
scroll-anchoring behaviour while pages insert; neither is width-sensitive, which
is why the clamp was a poor suspect from the start.

Two wrong methods, in order:

1. **Comparing against the `kikx-fix` worktree.** It lacks the clamp, so the
   reasoning went "two clamp-less trees both fail, therefore pre-existing". But a
   different repo with a different commit history is not a baseline — that
   worktree also predates four commits of unrelated shell work.
2. **Running the spec solo.** It passes 3/3 in a clone at `43cc56de` (~5.45 s).
   The failure, however, only ever appeared *inside a lane*. A solo pass does not
   control for the concurrency it failed under, so this also proved nothing.

The third attempt is the one that holds: **the full lane, both arms, in-lane
concurrency**. Two independent baseline setups agree.

| lane | baseline `43cc56de`, clone (no clamp) | HEAD `6738eaea` (clamp) |
| --- | --- | --- |
| `ui:playwright` | FAIL 17/18 — `thread-scrollview-playwright` | FAIL 17/18 — same test |
| `ui:puppeteer` | FAIL 37/40 — `filtered-lazy-scroll`, `frame-quote`, `frame-window` | FAIL 42/43 — `filtered-lazy-scroll` only |

Both failing specs fail at a commit that does not contain the change, in the
same place, with the same signature. `distanceFromBottom` moves (4591 without the
clamp, 5534 with it) because the clamp changes the box's height, but `follow:
false` does not, so the clamp alters the geometry without altering the verdict.

Worth stating plainly rather than smoothing over: baseline is **worse** — it
fails two tests that pass at HEAD (`frame-quote`, `frame-window`). Those two fail
in the same way as the in-place no-clamp arm below, so the likeliest reading is
that both are width-sensitive too and pass once the clamp is present. That is
consistent but not separately bisected, so it is recorded as an observation, not
a claim.

### The paired arms prove the guard fails for the right reason

The same no-clamp state was also exercised by stripping the declaration in place
on the real worktree and running the whole lane, which gives a paired result for
the guard spec itself:

| arm | `ui:puppeteer` | guard spec |
| --- | --- | --- |
| clamp stripped (20:54) | FAIL 40/43 | **FAIL** — `2 of 4 samples were outside (first: {"at":"first-paint","left":2873,"right":3799,"window":2523,"bodyClientWidth":2241,"bodyScrollWidth":3714,"bodyColumns":"3678px"})` |
| clamp present (20:48) | FAIL 41/43 (only unrelated failures) | **PASS** |

That is the regression guard failing on exactly the geometry this report
describes — a `3678px` column inside a `2241px` box, the user frame's right edge
at `3799` on a `2523px` window — and passing when the declaration is restored.
It also reproduces the escape inside the **lane**, not only in an isolated run,
so the guard works under the concurrency it will actually face.

`/tmp/lane-clamp-FULL.log` and `/tmp/lane-noclamp-FULL2.log` are the two arms.
Neither log records the CSS state in its own text; the arm→state mapping comes
from each file's mtime bracketing the strip/restore and from the guard's own
failure message, which prints the computed `bodyColumns`. Where a log does not
self-identify its state that is a real gap in the evidence, and the `43cc56de`
clone arms above exist partly to cover it: there the clamp's absence is a
property of the commit rather than of a hand edit.

Source logs, all identified by path inside the log so an arm cannot be confused
with the other: `/tmp/lane-baseline-playwright.log`, `/tmp/lane-baseline-43cc.log`
(baseline clone paths); `/tmp/lanes-uipuppeteer-full.log`, `/tmp/gate-pw.log`,
`/tmp/s1-pw.log` (HEAD worktree paths); `/tmp/lane-clamp-FULL.log`,
`/tmp/lane-noclamp-FULL2.log` (in-place paired arms).

One reading trap, recorded because it cost two rounds: the lane summary prints
`executed=` as the **pass** count, not the number of tests that ran.
`ui:playwright` shows 18 registered and `executed=17`; nothing was skipped, that
is simply 17 passing. Do not read the gap as an unrun test.
