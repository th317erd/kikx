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

## Not verified

- The live dev server was confirmed to **serve** the fixed CSS
  (`/client/styles/app-base-shell.css`, 200, 8997 bytes, clamp at line 468,
  md5 `2f47ca84a522998eb0834fdc378271b4`, byte-identical to disk). The check was
  reproduced across a server restart, so it is a statement about the working
  tree and the static serve path rather than about one process; the concrete
  pid is deliberately not recorded here because it is not durable. What is
  **not** verified: the escape was never re-observed in the owner's real Chrome
  on his real session. The reproduction is a Puppeteer fixture.
- The entry animation (`--kikx-frame--entering`) was sampled by the guard, but
  the guard does not separately assert the geometry mid-animation; it asserts
  every mutation sample stays inside, which covers it only as far as mutations
  coincide with the animation.
