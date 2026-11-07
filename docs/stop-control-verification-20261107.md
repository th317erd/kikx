# STOP control verification: the "button inside a button" artifact

> **Status: current** — dated maintainer evidence, 2026-11-07. Companion to
> [stale-stylesheet fix audit](./stale-stylesheet-fix-20261107.md), which covers the
> delivery mechanism (serve-time URL stamping) and the second artifact (the tokens
> glyph). This document covers **only** the STOP control, in more detail than the
> audit's summary table, because it is the artifact the owner sent a screenshot of.

## What the owner reported

On the kikx3/Avatar instance, after the last publish, the composer's STOP control
rendered as **a red button containing a smaller dark STOP button**. The screenshot
is `/home/public/wyatt-desktop/Pictures/Screenshots/session-2026-11-07-01-06-34.277.png`
(962x539). The red boxes drawn on it are the owner's annotations, not UI.

## What is actually being claimed

Not "the CSS is different" (that is a diff), and not "the new CSS looks right in
isolation" (that is a guess). The claim under test is exactly:

> With markup and mount code held constant, the **pre-deploy** stylesheet bytes make
> the STOP host element paint a red background and a 2px border around the vendor
> component's own inner button — a host strictly larger than its child, with the child
> visibly nested inside it — while the **current** bytes leave the host transparent,
> borderless and exactly coincident with its child.

The artifact is a **geometry** claim. A background colour alone would not be "a button
inside a button"; a host box strictly larger than the inner box, with the host painted,
is.

## Markup fidelity: the probe mounts the real control

The probe does not invent a button. It builds the same element `buildStopControl`
builds (`src/client/components/kikx-shell-builders.mjs`):

```js
const el = document.createElement('aeor-confirm-button');
el.setAttribute('label', 'STOP');
el.setAttribute('duration', '500');
el.classList.add('kikx-stop-button');
```

which is verbatim the component branch of the real builder. The real builder's
alternative branch (a plain `<button class="kikx-stop-button">`) exists only for
spec harnesses that load no `/vendor` components; in the browser the vendor element
is registered, so the component branch is the one the owner's browser took. The probe
asserts the same precondition — `customElements.get('aeor-confirm-button')` — and
reports it as `vendorReady: true` in every arm, so an arm that silently fell back to
the plain-button branch could not be mistaken for a component measurement.

The inner node measured is `.aeor-confirm-btn` with `<button>` as fallback, i.e. the
vendor component's own button, not a node the probe created.

## The measurement

Same page, same DOM, same mount code, same viewport (1280x900), same request URL. The
**only** variable is the stylesheet bytes served for `app-composer.css`.

| arm | served bytes | host bg | host border | host min-height | host box | inner box | inner bg |
|---|---|---|---|---|---|---|---|
| NEW (live) | `?v=cf1c38e92ffc`, 12783 B | `rgba(0,0,0,0)` | `0px none` | `auto` | 88x35 | 88x35 | `rgb(74,15,15)` |
| OLD (`dce21c05`) | 10467 B | `rgb(185,28,28)` | `2px solid rgb(127,29,29)` | `44px` | **1280x44** | 68x35 | `rgb(33,38,45)` |

| arm | `hostPainted` | `hostWrapsInner` | `nestedVisible` |
|---|---|---|---|
| NEW | false | false | **false** |
| OLD | true | true | **true** |

The OLD row is the owner's screenshot reproduced numerically: a **full-width
1280x44** red band, with a **68x35** dark `#21262d` button sitting inside it. The host
is 1212 px wider and 9 px taller than its child. That is the "button inside a button".

## Why the OLD arm is a control and not a second guess

Two failure modes would make this table meaningless, and both are excluded by
construction:

1. **The arms measuring each other.** Each arm prints the URL it actually served
   (`app-composer.css?v=cf1c38e92ffc` for NEW, the bare URL with injected bytes for
   OLD) and the byte length. A run in which the injection silently failed would show
   the live URL in both arms.
2. **The fixture not being the old file.** The OLD bytes are `/tmp/oldcss/app-composer.css`,
   md5 `2467be615e788f53c7921fffda770d70`. That md5 equals
   `git show dce21c05:src/client/styles/app-composer.css` byte-for-byte, verified by
   piping the git object through `md5sum` — not copied by hand, not recalled.

The mechanism, read from the old bytes: `.kikx-stop-button` in that sheet declared
`border: 2px solid #7f1d1d; background: #b91c1c; min-height: 44px` **unscoped**, so it
matched the `<aeor-confirm-button>` *host* as well as the fallback plain button. The
host painted, the vendor component's own inner button painted itself on top in its own
dark colour, and the host's `min-height` plus the band layout stretched it full width.
The current sheet adds `:not(aeor-confirm-button)` — **0** occurrences in the old bytes,
**4** in the current ones (lines 174, 189, 190, 196).

## Three methodology failures worth recording

Each of these would have produced a confident, wrong "verified".

1. **Cold-browser URL stripping.** Attempt 1 removed `?v=` in a fresh browser and
   compared. Invalid: a cold browser refetches current CSS from the edge, so both arms
   were guaranteed identical regardless of the fix. It was briefly reported as a control
   before being caught.
2. **Live CSSOM mutation.** Attempt 2 swapped rules in `document.styleSheets`. It
   silently no-opped: `app-composer.css` arrives via `@import` and never appears in
   `document.styleSheets`, so the "old" arm re-measured the "new" arm. Caught only
   because the probe emitted a `sheet: false` marker. This is also why
   `/tmp/stop-two-arm.out.json` must not be cited: its OLD arm injected the pre-fix
   *rule* into the live sheet rather than serving the old *sheet*, so it understated the
   artifact, and its `guardCount: 0` is the same `@import` instrumentation blind spot.
3. **Injection without proof of firing.** The final probe swaps at the network layer
   (`request.respond`) and asserts the interception fired (`sheet: ["INTERCEPTED ..."]`
   in the OLD arm). A control that cannot show it fired is not a control.

## What this establishes, and what it does not

**Established at the byte and geometry level:** the pre-deploy composer stylesheet
makes the real STOP control render as a painted host wrapping a smaller inner button,
and the current stylesheet does not. The fix is the `:not(aeor-confirm-button)`
scoping, present in current bytes and absent in old ones.

**Established at the public boundary:** the live edge serves the current
`app-composer.css` (`?v=cf1c38e92ffc`, 12783 B, md5 `d5655bd00e7c802bbcd1696d309b29fe`,
identical to disk) and the current `app-base-shell.css` (`?v=98a3fa1cea81`, 9707 B,
md5 `360109a4e9f0a64b47b61d51a7d7e963`, identical to disk); a cold authenticated
browser against `https://kikx3.taraani.org` made **35 CSS requests, 35 stamped, 0
unstamped, 0 non-200, 0 page errors**.

**Not established here:** no browser was observed holding a *real, unexpired* four-hour
edge lease showing the artifact. The reproduction *supplies* the old bytes. The lease
mechanism that makes staleness possible is separately measured (no ETag, `max-age=14400`,
an `If-Modified-Since` a year in the future still returns `200`, not `304`), and
`?v=<hash>` requests return `cf-cache-status: MISS`, so a changed stamp genuinely
bypasses the lease. Also not established: kikx3's origin identity, which remains
inference from byte-identical health and 404 bodies at the edge, `:3001` and `:3002`.

The STOP control mounts only while a generation is active, so a cold render with no
running agents cannot measure it in situ; `stopFound: false` in the cold-render probe is
the absence of the control, not the absence of the defect. That is why this document
mounts the element explicitly rather than waiting for a generation to be running.

## Artifacts

- Old bytes: `/tmp/oldcss/app-composer.css` (10467 B, md5 `2467be615e788f53c7921fffda770d70`)
  and `/tmp/oldcss/app-base-shell.css` (7798 B, md5 `17d73d3805fb23ce16da40de5e6545b4`),
  both verified equal to `git show dce21c05:`.
- Network-layer probe: `/tmp/probe-stop-net.mjs`.
- Cold public render: `/tmp/probe-public-render.mjs`, screenshot `/tmp/public-cold.png`.
- Fix commits: `8f1c066f` (scoping), shipped to production in `aad7743c`.
