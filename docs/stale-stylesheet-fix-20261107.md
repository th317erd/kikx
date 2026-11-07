# Stale-stylesheet fix: audit, verification, and what remains

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

## What is NOT verified

- The artifacts were **not** reproduced from a genuinely stale browser cache. Proven:
  old bytes + a selector conflict that paints the host + a cache mechanism that
  permits it + the new code removing the channel. That is a strong chain, not an
  in-situ capture.
- **Origin identity unverified.** Health and 404 bodies were byte-identical from
  edge, `:3001` and `:3002` — non-discriminating. "kikx3's origin is the `kikx2`
  checkout" remains inference.
- Nothing is deployed. `:3002` is the only server running this commit.

## Deliberate scope gap

Client `.mjs` modules return `cf-cache-status: DYNAMIC` with `no-cache` and are never
cached, so they are not stamped — a stamp there would only churn the import graph.
Vendored `aeor-web-components` **`.js`** modules *are* edge-cached, so they remain a
residual skew risk; versioning them means rewriting every `import` specifier in
`aeor-ui.mjs` and inside the vendor tree. Separate change, not attempted here.

## Deploying

`kikx-docker/deploy.sh` builds locally, saves the previous tag for
`./rollback.sh`, runs a boot smoke and rolls back automatically on failure.

The useful property: because the fix changes the URL, deploying it **bypasses the
owner's stale cache immediately** — `app.css?v=<newhash>` is a URL their browser has
never seen. No cache purge and no hard reload needed.

Not deployed, because a production deploy is an owner decision.
