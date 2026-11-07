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

**Established in a browser holding a stale cached copy (2026-11-07, `cache-repro2`):**
a Chrome profile that had already cached the *old* composer sheet under the bare URL
kept rendering the painted-host artifact after the server's bytes at that same URL
changed to the *new* sheet. The browser never contacted the network for that sheet in
that arm; 35 of 35 CSS requests replayed the earlier arm's cached responses. The
identical new bytes under a stamped URL, in the same profile, fetched fresh and rendered
the fixed control. See [Stale-cache reproduction](#stale-cache-reproduction-2026-11-07)
for the numbers and for why the instrument is trustworthy.

**Not established here:** the *real* kikx3 edge was never caught serving stale bytes to
a real browser. The reproduction models the measured edge behaviour
(`public, max-age=14400` on `.css`, no ETag, `If-Modified-Since` a year ahead still `200`)
against the local origin `:3002`; a model of the lease is not the lease. The lease itself
is measured at the edge, and `?v=<hash>` requests return `cf-cache-status: MISS`, so a
changed stamp genuinely bypasses it. Also not established: kikx3's origin identity, which
remains inference from byte-identical health and 404 bodies at the edge, `:3001` and
`:3002`. The tokens artifact was not re-probed under a stale cache; it shares the
mechanism but only the STOP control was measured this way.

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

## Stale-cache reproduction (2026-11-07)

This closes the question the rest of the document could not answer: not "do the old
bytes produce the artifact" (proved above by supplying them), but "does a browser
holding an *unexpired* copy keep showing the artifact after the origin is fixed".
Probe: `/tmp/cache-repro2.mjs`, output `/tmp/cache-repro2.out.json`.

**Setup.** A local proxy in front of the HEAD-code origin (`:3002`) reproduces the one
header that matters, measured at the Cloudflare edge and nowhere else: `.css` under a
bare URL is served `public, max-age=14400`; everything else stays `no-cache`. Three arms
run in **one** Chrome profile so the cache persists between them, and **no request
interception is used anywhere** — interception disables Chrome's HTTP cache and would
have voided the experiment.

**The variable is the URL, and only the URL.** In arms 2 and 3 the proxy serves
*byte-identical new CSS*. Arm 2 asks for it under the bare URL that arm 1 cached; arm 3
asks under its stamped URL. Whatever differs between arms 2 and 3 is therefore caused by
the cache key and nothing else.

| arm | URL in document | bytes the server would serve | bytes the browser used | source of the sheet | host bg / border | host box vs inner | nested |
|---|---|---|---|---|---|---|---|
| 1 prime | `/client/styles/app-composer.css` | OLD `2467be61` | OLD | network (this arm) | `rgb(185,28,28)` / `2px solid rgb(127,29,29)` | **1280x44** vs 68x35 | **true** |
| 2 stale | `/client/styles/app-composer.css` | **NEW** `d5655bd0` | **OLD** | **cache, earlier arm** | `rgb(185,28,28)` / `2px solid rgb(127,29,29)` | **1280x44** vs 68x35 | **true** |
| 3 control | `/client/styles/app-composer.css?v=cf1c38e92ffc` | NEW `d5655bd0` | NEW | network (this arm) | `rgba(0,0,0,0)` / `0px none` | 88x35 vs 88x35 | false |

**Why the stale arm is a cache hit and not a coincidence.** `request.fromCache()` was
useless here: it returned `null` on every arm, including the control whose stamped URL
cannot have been cached, so a `null` there distinguishes nothing. The instrument used
instead is a per-arm response header. The proxy sets `x-arm: <arm>` on every response,
and Puppeteer exposes response headers for cached responses too. A cache hit therefore
replays the *earlier* arm's name. In arm 2 the composer's response carried
`x-arm: prime` — a header only arm 1 could have produced — with `networkThisArm: false`
and `cacheHitFromOtherArm: true`; all 35 CSS responses in that arm came from the prime
cache. The proxy ledger confirms the serving side independently: it has an entry for arm
1 (OLD, 10467 B) and arm 3 (NEW, 12783 B) and **none for arm 2**, because no request for
the composer sheet reached the proxy in arm 2 at all.

**The negative control inside the same run.** The stale arm's recorded
`staleMd5 = d5655bd00e7c802bbcd1696d309b29fe` is the new sheet: that is exactly what the
proxy would have returned had the browser revalidated. It rendered the old artifact
anyway. Had the browser revalidated, it would have fetched NEW and rendered the fixed
control, as arm 3 did.

**Take 1 failed and is not cited.** `/tmp/cache-repro.out.json` shows the same three-arm
shape, but its only instrumentation was `fromCache`, which read `null` on every arm
including the unstampable control. An instrument that reads the same both when the cache
is used and when it is not proves nothing; the run was discarded and the header
instrument built for take 2. This is the fourth methodology failure in this investigation
and the same lesson as the other three: a control must be able to show that it fired.
