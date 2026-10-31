# 3098 deploy — runbook + state (written 2026-10-31T02:42Z, corrected 03:44Z)

If you are reading this after a container restart, the swap below succeeded and
you are running the NEW image. Verify before claiming anything.

## What was deployed
- kikx core: **`87a8e628`** (origin/main at build time) — contains the search/filter
  fixes (`189a491b` filter paged threads locally, `b7264d18` preserve search focus)
  and `81c6f2f8` (Hidden filter reveals hidden + deleted frames).
  CORRECTION (03:44Z): this line previously said `8309689c`. That was wrong. The
  image tag, the running container and `.last-deploy` all say `87a8e628`.
  `8309689c` was a docs-only ancestor superseded before the build.
- vendor aeor-web-components: `43f0234` (origin/main) — REQUIRED, see below.
- deploy log: `/home/wyatt/kikx-deploy-20261031T024134Z.log`
- verify: `/home/wyatt/kikx-deploy-verify-20261031T024134Z.txt` (`DEPLOY_RC=0`)
- Rollback target recorded by `.last-deploy`: `7d484126`.

NOTE (03:44Z): `origin/main` has since advanced to **`be0ff409`**
("fix(ui): keep the quote quick action reachable in its gutter"). That commit
touches only `src/client/styles/app.css` and adds
`spec/ui/puppeteer/frame-quote-puppeteer.mjs` — no search/filter code. So the
running image is not missing any search/filter fix, but it is one commit behind
main for a CSS/quote-action change. Re-deploy when convenient, not urgently.

## The blocking defect that was found (not a code bug in Kikx)
`src/client/lib/aeor-ui.mjs` statically imports
`/vendor/aeor-web-components/property-store.js` and `reconcile.js`.
The dev server serves that path from `KIKX_AEOR_WEB_COMPONENTS_ROOT`
(default `/home/wyatt/Projects/aeor-web-components`), whose checkout was at
`cc8c2e0` and contained neither file. Result: `kikx-app.mjs` failed to import and
the whole client never booted in a fresh tab:
`[kikx] client boot failed TypeError: Failed to fetch dynamically imported module`.
Fix applied: fast-forwarded that checkout to `origin/main` = `43f0234`. The client
then booted and rendered frames (verified: 2 `kikx-frame-item` nodes).
The deploy stages vendor from `origin/main` too, and `scripts/check-vendor-coverage.mjs`
guards the same class of break at build time.

## Second defect: module URLs are not cache-busted
`index.html` cache-busts its stylesheets (`?v=20261030-1`) but module imports carry
no version token, so the Cloudflare edge serves stale module URLs for
`cache-control: max-age=14400` across a deploy. Observed: `/vendor/.../aeor-scrollview.css`
returned a cached `cf-cache-status: HIT` **404** while the origin returned 200, and a
cache-busted URL returned 200. Not fixed; needs a decision (see report).

## 3003 dev instance — how to run it correctly (learned the hard way)
`scripts/parent-exit-monitor.mjs` records `process.ppid` ONCE at startup and shuts
Kikx down as soon as `currentParentPID !== parentPID`. Launching from a shell that
then exits reparents the process and kills the server, even though nothing is wrong.
Symptom in the log: `Dev stack parent NNNN exited; current parent is 1. Shutting down child processes.`
Correct launch: inside a long-lived tmux session, via
- `/home/wyatt/kikx-3003-run.sh`  (replays the captured env: `env -i` with NUL-split args)
- `/home/wyatt/kikx-3003-up.sh`   (starts it in tmux `kikx3003`, reaps the old port holder,
  and re-checks health after a 25 s durability window)
Captured environment: `/home/wyatt/miri-3003-env.bin` (NUL-delimited, mode 600).
Env is replayed rather than sourced because Kikx's loader is additive, so process env
wins over `.env.dev`; sourcing would drop secrets that only ever existed at launch.

## How to check what a server is ACTUALLY serving
Do not hash `/src/client/...` — both instances answer that path with a JSON 404
(`{"error":{"message":"Not Found"}}`), which hashes identically everywhere and
looks like a match. The page loads `/client/app.mjs`; the served modules live under
`/client/...`. Use:

    curl -s http://127.0.0.1:3003/client/lib/frame-filters.mjs | sha256sum
    sha256sum src/client/lib/frame-filters.mjs

Measured 03:44Z, all three identical (`89b8960e4ee078a6…`):
`/client/lib/frame-filters.mjs`, `/client/components/kikx-data.mjs`,
`/client/components/kikx-navigation.mjs` — 3003, 3098 and local `87a8e628`.
Negative control: the served `frame-filters.mjs` contains zero occurrences of
`fuzzyTokenMatches` (the pre-fix fuzzy matcher).

## Search/filter verification (browser level, 03:43Z)
Ran the repo's own puppeteer specs against the deployed commit:
- `spec/ui/puppeteer/hidden-frame-filter-puppeteer.mjs` → 2/2 pass
  (Hidden gate reveals hidden+deleted; search filters a fresh paged thread
  without a whole-session scan)
- `spec/ui/puppeteer/frame-filter-popup-puppeteer.mjs` → 1/1 pass
- **Negative control, same spec, pre-fix tree `189a491b^` (`863c2920`)**:
  Hidden test passes, search test **fails** (`TimeoutError` waiting for the
  filtered result at spec line 119). So the search pass is caused by the fix,
  not by a test that would pass either way.

## State at write time
- 3003: running, healthy, serving `87a8e628` bytes. Magic-link TTL
  now 86400 because the launcher loads `.env.dev` on start.
- 3098: image `kikx/kikx:87a8e628` (id `310dcd5ce36d`), container up and healthy,
  host port 3098, started 2026-10-31T02:42:36Z.
