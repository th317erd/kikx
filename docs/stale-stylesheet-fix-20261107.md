# Stale-stylesheet fix: audit, verification, and what remains

> **Status: current** — dated maintainer evidence for the stale-stylesheet fix (commit `cd9a2f52`). No newer stylesheet incident supersedes it.

Commit `cd9a2f52`, pushed to `origin/main` (`f4ed4927..cd9a2f52`).
Author of the interrupted work: the previous session, whose response was cut off
mid-stream. This report corrects the record of that turn and states what is proven.

## The reported artifacts

Owner saw, on the kikx3/Avatar instance only, after the last publish:

1. the STOP control rendered as a red button **containing** a smaller dark STOP button
2. the tokens SVG glyph **stacked above** `597,397,047` instead of inline

Both are one defect: the browser received the pre-deploy stylesheets.

## Root cause (measured, with a negative control)

The deploy replaced the *content* behind stylesheet URLs without changing the URLs.
`index.html` linked `/client/styles/app.css` unstamped, and that file `@import`s ten
others. Cloudflare rewrites the origin's `Cache-Control: no-cache` to
`max-age=14400`, **strips the ETag** and stamps its own `Last-Modified`, so a client
cannot revalidate early even if it wants to. An `If-Modified-Since` a year in the
future returns `200`, not `304`.

kikx3 is the only instance behind Cloudflare, which is why only it showed the bug.

The old rules, verbatim from the `dce21c05` bytes:

- `app-composer.css` — `.kikx-stop-button` sets `border:2px solid #7f1d1d` and
  `background:#b91c1c` **unscoped**, so it also matches the real
  `<aeor-confirm-button>` host and paints red around the component's own inner
  button. That is the literal "button inside a button". `:not(aeor-confirm-button)`
  appears **0 times** in the old sheet and **4 times** in the current one.
- `app-base-shell.css` — `.kikx-statusbar__tokens` declares **no `display`**, so it
  stays block and the `display:block` svg sits on its own line above the number.
  Current declares `display:inline-flex; align-items:center; gap:6px`.

The image content was never the defect: both `__tokens` and
`kikx-composer__actions`/`kikx-stop-button` exist at the deployed tag `f3595e59`.

## The fix

`src/server/asset-stamping.mjs` (385 lines) + a 3-line dispatch in
`static-files.mjs`. Serve-time only; nothing on disk is rewritten, so
`stylesheet-links-spec.mjs` and `thread-dock-grid-spec.mjs` still resolve plain
hrefs against the working tree.

- `index.html` links each sheet as `/x.css?v=<hash>`
- each served sheet rewrites its own `@import` specifiers

Both layers are required. Stamping only the document leaves the ten imported
sheets unversioned, which is precisely the layer that went stale.

A sheet's version is the hash of its **rendered** text, not its own bytes.
`app.css` is a stub meaning only its ten children; across the deploy that shipped
the stale composer it was byte-identical while two children changed. Hashing the
parent would have shipped an unchanged version for a changed document.

## Verification

| check | result |
|---|---|
| `spec/server/*` | **247 pass, 0 fail, 2 skipped** (was 245/1/2) |
| `spec/server/asset-stamping-spec.mjs` | 8/8 |
| `stylesheet-links-spec` + `thread-dock-grid-spec` | 22/22 |
| real Chrome against `:3002` | 35 CSS requests, **35 stamped, 0 unversioned, 0 non-200** |
| all 10 `app.css` `@import` targets | 200, byte-identical to disk |
| all 12 vendor sheets incl. `aeor-confirm-button.css` | 200, stamped |
| propagation | child-only edit moved parent version `6815b99d3abf` → `954d4073d849` |
| 20 sequential `GET /` | identical, ~4 ms |
| `HEAD` stamped HTML | 200, `Content-Length` 2718 matches body |

**Negative control.** Same request on `:3001` (old checkout, `kikx2`) versus
`:3002` (new checkout) gives 7 stamped / **3 unstamped** / 0 vendor versus
10 / **0 unstamped** / 12 vendor. The code is what differs; the fixture is not.

**Correction to the previous turn's own record.** That turn claimed the tree had a
dangling `serveStampedHTML` and a `ReferenceError` on `/`. Neither was true when I
measured: the function is named `serveStampedFile` and is defined. A stale
pre-compaction summary nearly caused me to "revert to backup" work that had in fact
been finished.

**One test was wrong, and I fixed the test, not the feature.** It asserted
`app-composer.css` appears in `index.html`'s stylesheet list — impossible by design,
since that sheet only arrives via `@import` and contains zero `@import` itself. It
now checks `statusbar-stats.css` (directly linked, import-free), and I added a test
that follows `app.css`'s stamped `app-composer.css` specifier to the real bytes —
which is the case that actually regressed.

## Reproduced at the public boundary (2026-11-07, after deploy)

Both artifacts were reproduced in a real Chrome against `https://kikx3.taraani.org`
with a **discriminating control**: same page, same DOM, same mount code, same URL —
only the served stylesheet bytes differ (pre-deploy `dce21c05` bytes injected with
`request.respond`; everything else live from the edge).

**STOP control** — a real `<aeor-confirm-button class="kikx-stop-button">` mounted in
a real `.kikx-composer__actions` band:

| arm | host bg | host border | host box | inner bg | inner box | nested |
|---|---|---|---|---|---|---|
| NEW | `rgba(0,0,0,0)` | `0px none` | 88x35 | `rgb(74,15,15)` | 88x35 | **false** |
| OLD | `rgb(185,28,28)` | `2px solid rgb(127,29,29)` | **1280x44** | `rgb(33,38,45)` | 68x35 | **true** |

The OLD row is the owner's artifact: a full-width red band with a small grey
(`#21262d`) STOP button sitting inside it — literally a button in a button.

**Tokens cell** — the real `.kikx-statusbar__tokens`:

| arm | display | cell h | icon y | value y | sameRow | stacked |
|---|---|---|---|---|---|---|
| NEW | `flex` | 24 | 878 | 874 | **true** | **false** |
| OLD | `block` | **41** | 859 | **878** | **false** | **true** |

The OLD row is the owner's artifact: icon on its own line above the count.

Old bytes used are the pre-deploy `dce21c05` sheets, preserved at `/tmp/oldcss/`:
`app-composer.css` 10467 B md5 `2467be615e788f53c7921fffda770d70`,
`app-base-shell.css` 7798 B md5 `17d73d3805fb23ce16da40de5e6545b4`.

### Probe methodology, including two failures worth recording

Attempt 1 stripped `?v=` in a cold browser. Useless: a cold browser simply re-fetches
the *current* CSS from the edge, so both arms were guaranteed identical. It proved
nothing, and it was briefly reported as a control before being caught.

Attempt 2 mutated the live CSSOM to swap the rules. It silently no-opped — the
`document.styleSheets` lookup returned nothing for the `@import`ed sheet, so the
"old" arm re-measured the "new" arm. Caught only because the probe emitted a
`sheet: false` marker.

Attempt 3 (the table above) swaps at the **network layer** with `request.respond`
and asserts the interception actually fired (`sheet: ["INTERCEPTED …"]` in the OLD
arm). A control that cannot show it fired is not a control.

## What is NOT verified

- This is not an *in-situ* capture: no browser was observed holding a real expired
  four-hour lease. The reproduction supplies the stale bytes rather than waiting for
  the cache to hand them over. The lease mechanism itself is separately measured
  (no ETag, `max-age=14400`, `If-Modified-Since` a year ahead still returns 200).
- **Origin identity unverified.** Health and 404 bodies were byte-identical from
  edge, `:3001` and `:3002` — non-discriminating. "kikx3's origin is the `kikx2`
  checkout" remains inference.
- The `.js` module path remains uncovered — see the scope gap below.

## Deliberate scope gap

Client `.mjs` modules return `cf-cache-status: DYNAMIC` with `no-cache` and are never
cached, so they are not stamped — a stamp there would only churn the import graph.
Vendored `aeor-web-components` **`.js`** modules *are* edge-cached, so they remain a
residual skew risk; versioning them means rewriting every `import` specifier in
`aeor-ui.mjs` and inside the vendor tree. Separate change, not attempted here.

This gap has already been observed in the wild and is recorded in
`docs/deploy-3098-runbook-20261031.md:38` ("Second defect: module URLs are not
cache-busted … Not fixed; needs a decision"): the edge served a cached
`cf-cache-status: HIT` **404** for `/vendor/.../aeor-scrollview.css` while the
origin returned 200. The CSS half of that defect is now closed; the `.js` half
is not. Re-measured 2026-11-07: `elements.js`, `reactive-state.js` and
`components/aeor-confirm-button.js` all return 200 with
`cache-control: max-age=14400`, while `/client/lib/aeor-ui.mjs` returns
`no-cache` / `cf-cache-status: DYNAMIC`.

### Full request sweep: what else the edge caches unstamped

Every request the authenticated page makes was classified by (a) did the response
carry a positive `max-age` (i.e. the Cloudflare rewrite applies) and (b) is the URL
content-stamped. Result: 16 edge-cached, unstamped URLs remain.

| kind | count | examples |
|---|---|---|
| vendor `.js` | 14 | `elements.js`, `reconcile.js`, `components/aeor-confirm-button.js` |
| vendor `.woff2` fonts | 4 declared / 2 loaded | `Inter-Regular`, `Inter-Medium`, `Inter-Bold`, `JetBrainsMono-Regular` |

The fonts are a new finding, not in the runbook. All four are declared via
`@font-face { src: url("../fonts/...") }` inside
`/vendor/aeor-web-components/styles/globals.css`. That sheet *is* stamped
(`?v=0a6bfe7fd607`), but `stampAssetText` rewrites link `href`s and `@import`
specifiers only — it leaves `url()` payloads inside a sheet untouched, so all
four font URLs ship unversioned. Measured directly: each returns 200 with
`cache-control: max-age=14400`. The count is 4 declared versus 2 actually
fetched, because only Regular and Bold are used by the current UI — the other
two would join the same leak the moment a rule references them.

Everything else is clean:

- **`.css`** — all stamped, including 12 vendored sheets.
- **`.mjs` and `/shared`** — `no-cache` / `cf-cache-status: DYNAMIC`; the edge
  does not cache them, so a stamp would only churn the module graph. Excluding them
  is correct.
- **Icons** — inlined into `src/client/lib/icons.mjs` (generated from
  `src/client/assets/icons/*.svg`); the page fetches no icon URLs at all.
- **Service worker** — none exists in the tree, so there is no second cache layer
  below the browser HTTP cache.

Severity of the two remaining classes, honestly: a stale `.js` component can pair
with current CSS and mis-render (the runbook's observed HIT-404 is this class), and
a stale font renders wrong glyph metrics. Both are latent, unlike the CSS case,
which was live. Neither was attempted here.

## Deploying

`kikx-docker/deploy.sh` builds locally, saves the previous tag for
`./rollback.sh`, runs a boot smoke and rolls back automatically on failure.

Deployed 2026-11-07T04:14:13Z as `aad7743c` (previous `f3595e59`); container
`kikx/kikx:aad7743c` healthy on `wyatt-laptop`.

The useful property: because the fix changes the URL, deploying it **bypasses the
owner's stale cache immediately** — `app.css?v=<newhash>` is a URL their browser has
never seen. No cache purge and no hard reload needed.

Rollback path if the probe above ever fails: `./rollback.sh` on `wyatt-laptop`,
target `f3595e59`.
