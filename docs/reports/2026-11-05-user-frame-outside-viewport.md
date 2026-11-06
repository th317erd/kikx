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
- `ui:stagehand` **never ran** as part of this work, and could not run here. The
  lane has no usable model credential: `stagehand-test-utils.mjs` falls back to
  `.env.dev`'s `AEORDB_ROOT_KEY` when no env var is set, and AeorDB (listening
  on 6833, not the 6830 that file names) rejects that key with `HTTP 401`.
  Measured, not assumed: `node scripts/run-test-lanes.mjs ui:stagehand` -> FAIL,
  28 registered / 28 fail / **0 skipped**, every failure an `AeorDB HTTP 401`,
  and none of them mentioning CSS, the thread body or a viewport. The lane fails
  **closed** — the credential gate throws before `t.skip` is ever reached — so a
  missing key cannot be mistaken for a green run. It is still an unexecuted
  browser lane, not a passing one, and no stagehand spec covers this geometry.

## The same fix on the instance behind :3001 (owner-authorized, 2026-11-06)

This section previously read "This fix does not reach the instance on `:3001`" and
concluded that applying it was the owner's call. The owner then authorized it
explicitly -- *"I don't remember ever telling you that you can not touch 3001...
in fact, it is the opposite. You own 3001."* -- so the clamp is now in `kikx2`
too. The superseded conclusion is recorded at the end of this section.

**Before** (measured 2026-11-05, read-only):

- `kikx2` at `a76a1ab9`, `src/client/styles/app-base-shell.css` 8337 bytes, md5
  `34b67cfd9056edbda25598593e5ac34b` -- byte-identical to the pre-fix `kikx`
  file, not merely similar to it.
- Its `.kikx-thread__body` block (line 457) declared `grid-template-rows` only.
- `:3001` served it with no thread-body column clamp.

**After** (measured 2026-11-06):

- The same one-declaration change is in the working tree: 8337 -> 8997 bytes
  (+660, 9 insertions, 1 file), md5 `b5d6725060e9a0326df8b1983b673c7f`, clamp at
  line 469.
- `:3001` serves 8997 bytes with `Content-Length: 8997` and md5
  `b5d67250...`; `cmp` of the served bytes against the file is IDENTICAL.
  **The server was not restarted.** It re-reads the file per request -- proven by
  the served byte count moving with the file while `:3001`'s pid stayed 34034.
- Order of operations: `--check` and `--dry-run` reported `clamp: ABSENT`,
  `anchor: ok`, with the tree byte-identical afterwards; `--apply` reported
  `PATCHED`; a second `--apply` reported `NO-OP (already correct)` at the same
  md5, so the edit is idempotent and cannot double-insert.

**Browser measurement, in Chrome against `:3001` itself**
(`/tmp/k2-clamp-probe2.mjs`). No authenticated thread mounts at `/` without a
session, so this measures a `.kikx-thread__body` stand-in element inside the real
cascade: the class matches, so the served rule applies to it, but it is a
stand-in and **not** a mounted conversation.

| arm | resolved `grid-template-columns` | host `scrollWidth` |
| --- | --- | --- |
| as served | `2487px` | 3018 |
| control: inline `none` | **`3000px`** | **3036** |
| restored | `2487px` | 3018 |
| control: inline `minmax(0, 1fr)` | `2487px` | 3018 |

Widths at a 2523px viewport with a 3000px child. Verdict
`PROBE_MEASURES_THE_CLAMP`: the control widens the track by 513px, restoring
returns the measurement exactly, and an inline copy of the served clamp
reproduces the served result. The probe is therefore measuring this declaration
and not something else.

The **first** version of this probe was invalid and is not evidence. Its control
walked `document.styleSheets` for a `.kikx-thread__body` rule to delete and found
none (`CONTROL_DECLS_REMOVED 0`), because the rule lives in a sheet reached only
through `app.css`'s `@import` and the walk did not recurse into
`CSSImportRule.styleSheet`. Both arms then measured an unchanged element and the
run reported `CONTROL_SENSITIVE false`. The rewrite's stylesheet diagnostic shows
the rule at `@import .kikx-thread__body` with `gtc: minmax(0px, 1fr)`, which is
exactly what the first walk missed.

**Left uncommitted, deliberately.** `kikx2` is on `main` tracking `origin/main`
and 14 commits behind the remote's other work; this file is its only local
change. Committing there would either create a divergent local `main` or force a
rebase, and neither was asked for. The owner asked for the bug to be fixed on
the instance being browsed, which an uncommitted edit achieves because `:3001`
reads from disk per request.

**Recovering the change if it is ever lost.** The edit is uncommitted
working-tree state, so `git checkout -- src/client/styles/app-base-shell.css` in
`kikx2` would revert it silently. A patch of exactly this change is kept outside
`/tmp` at `../kikx2-thread-body-clamp.patch` (md5
`465bd32698918910b8938e3d1ccdb0e5`), verified to recover the live bytes: applied
to the pristine `a76a1ab9` blob (md5 `34b67cfd9056edbda25598593e5ac34b`) it
yields `b5d6725060e9a0326df8b1983b673c7f`, byte-identical to what `:3001`
serves (`cmp` -> `RECOVERY_REPRODUCES_LIVE_BYTES`). An earlier turn claimed this
recovery script was kept at `/tmp/k2-clamp-patch.py`; that file does not exist
and the report never cited it, so the claim was wrong on both counts. The patch
above replaces it, and is stored in the workspace rather than a temporary
directory.

*Superseded:* the former text said `kikx2` "has never had this clamp, so if
`:3001` is the instance being browsed, the escape is still live there", and that
applying it "changes a running server that may be in use. That is the owner's
call, not an inference to act on." Its six measurements were accurate for
2026-11-05 and are preserved above under **Before**; only the conclusion was
overtaken, by authorization rather than by error.


## Unrelated lane failures, and how that was actually established

The browser lanes have failures that are not this clamp — proven pre-existing
for the two lazy-paging ones, and not shown to be pre-existing for the third
(see the correction below). Getting that attribution right took four attempts,
three of which were wrong, so the method is recorded rather than just the
verdict.

`ui:playwright` was 18 registered / 17 pass / 1 fail at `6738eaea`.
`ui:puppeteer` was 43 registered / 42 pass / 1 fail at `6738eaea`.

The persistent failure in both lanes is in the lazy-paging subsystem:
`thread-scrollview-playwright.mjs:75` ("follows live tail appends", `follow:
false`, ~11.9 s) and `filtered-lazy-scroll-puppeteer.mjs` ("keeps a filtered
frame anchored while lazy pages load above it", ~12.8 s). Both are vertical
scroll-anchoring behaviour while pages insert; neither asserts frame width,
which is why the clamp was a poor suspect from the start.

**Correction, measured later.** The failure *count* is not stable, so "the
single failure in each lane" was too strong. A fresh full lane at `9b7c4752`
returned FAIL 41/43 with **two** failures: `filtered-lazy-scroll` again, and
`frame-bottom-scroll-puppeteer.mjs` ("keeps the last card border inside the
scrolled thread", `the last border is clipped by 777.38px`, 4573 ms). The
second is a *geometry* assertion, so any implication that no geometry check
fails in-lane does not hold.

The first draft of this paragraph claimed that failure "flips only under lane
concurrency, on both sides of the change". The logs refute it, so it is
corrected here rather than quietly deleted:

| in-lane run | `frame-bottom-scroll` |
| --- | --- |
| baseline `43cc56de`, no clamp | pass, 4828 ms |
| no-clamp arm (43 registered) | pass, 5734 ms |
| clamp arm | pass, 4476 ms |
| `6738eaea`, clamp | pass, 4984 ms |
| `9b7c4752`, clamp | **fail**, 4573 ms |

It passed in-lane four times, on both sides of the clamp, including both
no-clamp arms. So the clamp is not its cause — and, just as importantly,
"lane concurrency" is not a *demonstrated* cause either: this is one failing
sample out of five. The failing run was not slower than the passing runs
(4573 ms against 4476–5734 ms), so a timing argument cannot separate them; it
only shows the spec is heavily contended in-lane. It also passes 2/2 solo
(1171 ms, 1065 ms) at the failing HEAD.

No thread-geometry CSS differs across the range that contains the failure:
`app-base-shell.css`, `app-thread.css`, `app-composer.css` and `mobile.css` are
byte-identical between `6738eaea` and `9b7c4752`; only `app-views.css` changed,
and it styles the settings views. That rules out a thread-layout change as the
cause without establishing what the cause is.

**Unverified: the mechanism.** The two assertions in that spec are mutually
inconsistent — `remaining <= 1` passed while the last card's bottom sat 777 px
below the list's bottom — which reads as a stale or partial layout snapshot
rather than a narrow box. That is an inference from one failing sample, not a
measurement, and it is not enough to call the test flaky or the product wrong.

Two wrong methods, in order:

1. **Comparing against the `kikx-fix` worktree.** It lacks the clamp, so the
   reasoning went "two clamp-less trees both fail, therefore pre-existing". But a
   different repo with a different commit history is not a baseline — that
   worktree also predates four commits of unrelated shell work.
2. **Running the spec solo.** An earlier version of this section claimed it
   "passes 3/3 in a clone at `43cc56de` (~5.45 s)". Re-measured, that is false,
   and the correction is worth keeping because it removes an argument rather
   than adding one. Three solo runs on each side, same spec bytes:

   | arm | run 1 | run 2 | run 3 |
   | --- | --- | --- | --- |
   | no clamp, clone `43cc56de` | fail 10490 ms | fail 10408 ms | fail 10456 ms |
   | clamp, HEAD `634ca0b3` | fail 10481 ms | fail 10443 ms | pass 1546 ms |

   So solo is **unstable in both directions, on both sides of the clamp**. The
   passing run took 1546 ms; every failing run took ~10.4 s, which reads like a
   timeout boundary under machine contention rather than a geometry effect —
   that is an inference from the durations, not a measurement, and this session
   was running other browser work throughout. The sibling test passed in all
   six runs (1154–1440 ms).

   The conclusion the item was making survives, but for a stronger reason than
   the one originally written: a solo run does not merely fail to control for
   in-lane concurrency, it does not reliably reproduce the **pass** it was
   being used to cite. Solo cannot separate clamp from no-clamp, so it is not
   evidence either way.

The third attempt is the one that holds: **the full lane, both arms, in-lane
concurrency**. Two independent baseline setups agree.

| lane | baseline `43cc56de`, clone (no clamp) | HEAD `6738eaea` (clamp) |
| --- | --- | --- |
| `ui:playwright` | FAIL 17/18 — `thread-scrollview-playwright` | FAIL 17/18 — same test |
| `ui:puppeteer` | FAIL 37/40 — `filtered-lazy-scroll`, `frame-quote`, `frame-window` | FAIL 42/43 — `filtered-lazy-scroll` only; also `frame-bottom-scroll` at `9b7c4752` |

Both failing specs fail at a commit that does not contain the change, in the
same place, with the same signature. `distanceFromBottom` moves (4591 without the
clamp, 5534 with it) because the clamp changes the box's height, but `follow:
false` does not, so the clamp alters the geometry without altering the verdict.

Worth stating plainly rather than smoothing over: baseline is **worse** — at
`43cc56de` it also fails `frame-quote` and `frame-window`, both of which pass at
HEAD. The two are not alike, though, and the paired arms separate them:

- `frame-window` fails in the in-place no-clamp arm at `854e4d89` as well
  (14162 ms) and passes with the clamp present (arm A, see below). That is a
  measured flip with the clamp as the only difference.
- `frame-quote` fails **only** at `43cc56de`. It passes in both arms at
  `854e4d89` — clamp present *and* clamp stripped — so the clamp is not what
  fixes it. Whatever changed between `43cc56de` and `854e4d89` to make it pass
  was not this declaration, and it has not been bisected. Recorded as an
  unresolved observation, not attributed to this change.

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

The 20:54 no-clamp log at that path was overwritten by a 21:19 re-run when the
state-recording pair below was measured. Its original bytes survive at
`/tmp/lane-noclamp-FULL2-2054-prior.log`, and the two copies agree in substance —
FAIL 40/43, the same three failing tests, and the same guard geometry — so the
table above is checkable from either file, but the survivor is the one that
matches the 20:54 mtime.

#### Re-measured with state recorded inside the log (21:22)

That gap was then closed by re-running the same pair with the CSS state written
into each log header instead of inferred from mtimes. Both arms ran the whole
`ui:puppeteer` lane in a detached worktree at `/tmp/kikx-arms-854e` on the same
commit, `854e4d89`, so the live checkout could not be stranded stripped however
the run ended. Exactly one declaration differs between the two arms.

| arm | recorded state | `ui:puppeteer` | guard spec |
| --- | --- | --- | --- |
| A — clamp present | `CLAMP_DECLS_IN_FILE=1`, md5 `f30d14c1…`, 9466 B | FAIL 40/41 — `filtered-lazy-scroll` only | **PASS** (9270 ms) |
| B — clamp stripped | `CLAMP_DECLS_IN_FILE=0`, md5 `fa4d0aad…`, 9425 B | FAIL 38/41 — `filtered-lazy-scroll`, `frame-window`, and the guard | **FAIL** (6171 ms) |

Arm B reproduces the escape with the same numbers as the 20:54 arm, independently
of it: `2 of 4 samples were outside (first: {"at":"first-paint","left":2873,
"right":3799,"window":2523,"bodyClientWidth":2241,"bodyScrollWidth":3714,
"bodyColumns":"3678px"})`. The two files are 41 bytes apart and nothing else
changed, so the declaration is the only variable.

This also settles a hedge made earlier in this report. `frame-window` — "the
initial thread window bounded and reveals older frames on a real scroll" —
passes in arm A and fails in arm B at `frame-window-puppeteer.mjs:284` (*"a real
wheel gesture moves the viewport to the top; the bottom pin is only broken by
real input"*). It was previously recorded as "consistent but not separately
bisected"; with the clamp as the only difference, it is now a measured flip.

`filtered-lazy-scroll` fails in **both** arms (10958 ms and 13055 ms). That is
the clearest statement available that it is independent of this change, and it
belongs in the lane tables as a pre-existing failure rather than as a
consequence of the clamp.

Restoring the worktree is self-verifying and was checked afterwards: md5 back to
`f30d14c1…`, `WT_STATUS_AFTER=[]`, and the live tree unmoved at `40a7cec2` with a
clean status. Provenance: `/tmp/armsA-clamp-854e.log`,
`/tmp/armsB-noclamp-854e.log`. The strip script asserted exactly one matching
declaration before removing it, so a no-op edit is ruled out.

Source logs, all identified by path inside the log so an arm cannot be confused
with the other: `/tmp/lane-baseline-playwright.log`, `/tmp/lane-baseline-43cc.log`
(baseline clone paths); `/tmp/lanes-uipuppeteer-full.log`, `/tmp/gate-pw.log`,
`/tmp/s1-pw.log` (HEAD worktree paths); `/tmp/lane-clamp-FULL.log`,
`/tmp/lane-noclamp-FULL2.log` (in-place paired arms).

One reading trap, recorded because it cost two rounds: the lane summary prints
`executed=` as the **pass** count, not the number of tests that ran.
`ui:playwright` shows 18 registered and `executed=17`; nothing was skipped, that
is simply 17 passing. Do not read the gap as an unrun test.
