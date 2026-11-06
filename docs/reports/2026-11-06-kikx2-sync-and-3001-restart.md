# kikx2 git sync and :3001 restart

**Date:** 2026-11-06
**Requested by:** owner — "Please sync with git, and restart 3001."
**Status:** `current` — both actions performed and measured.

---

## Outcome

| Item | Result |
| --- | --- |
| `kikx` | `abc49680` — already level with `origin/main` (`0 0`), clean |
| `kikx2` | `a76a1ab9` → **`abc49680`**, clean, `0 0` |
| `kikx-fix` (worktree) | `2c8268f6` — already **fully merged** into `origin/main`; no action needed |
| `kikx-dev-run.service` | restarted; `ActiveState=active`, `SubState=running`, `NRestarts=0`, `Result=success` |
| `:3001` listener | pid `34034` → **`2449711`** (wrapper `34020` → `2449700`) |
| served `app-base-shell.css` | 8997 B `b5d67250…` → **9466 B `f30d14c1…`**, `cmp` identical to disk |
| clamp at served line | 469 (stale patched copy) → **492** (upstream) |

## Why `kikx2` needed care, and why the reset was lossless

`kikx2` was not merely behind. It carried three separate states:

1. **25 commits behind** `origin/main`.
2. **1 commit ahead** — `a76a1ab9 fix(filters): scope view filters per session, persisted in localStorage`.
3. **An uncommitted modification** to `src/client/styles/app-base-shell.css` (8997 B, `b5d67250…`).

A naive `git pull` would have refused or, worse, a `checkout` would have silently
discarded the working-tree edit. Both were measured before any write.

**The local commit is a strict subset of upstream.** `git diff --numstat a76a1ab9 origin/main`
restricted to the seven files that commit touched returns only:

```
47  0  docs/reports/2026-11-05-per-session-view-filters.md
23  0  src/client/state/session-view-filters.mjs
```

Two files, `+70` insertions, **zero deletions**. Upstream contains everything
`a76a1ab9` introduced, in an evolved form. Note also that
`git merge-base --is-ancestor a76a1ab9 origin/main` is **false** — the commit
was cherry-picked or rebased upstream, not merged, so ancestry alone would have
misreported this. Content comparison is the evidence; ancestry is not.

**The uncommitted edit is fully superseded.** `git diff a76a1ab9 -- src/client/styles/app-base-shell.css`
shows its only hunk is the eight-line comment plus `grid-template-columns: minmax(0, 1fr)`
inserted after `grid-template-rows`. Upstream `origin/main` already has that
declaration at line 492 (blob md5 `f30d14c1…`, 9466 B). The working-tree file was
the same clamp applied to an older base, so its contribution is zero.

Recovery paths created before the reset:

- branch `backup/pre-sync-a76a1ab9` → `a76a1ab9`
- `/tmp/k2-dirty-8997-b5d67250.css` → the exact discarded working-tree bytes, md5 verified `b5d67250…`

## Restart method, and the trap avoided

`:3001` is supervised by the **transient** systemd unit `kikx-dev-run.service`
(`FragmentPath=/run/user/1000/systemd/transient/kikx-dev-run.service`,
`Transient=yes`, `RemainAfterExit=no`, `Restart=on-failure`). Its `ExecStart` is
`node scripts/start-kikx-dev.mjs`, which spawns `node src/server/index.mjs` as a
child (pid `34034`, the actual listener).

`systemctl --user restart` was used, **not** `stop` + `start`. A transient unit
with `RemainAfterExit=no` can lose its definition when stopped, and there is no
fragment file to recreate it from. `restart` re-executes the unit in place and
preserves it — confirmed afterwards: `FragmentPath` still resolves and
`systemctl --user cat` still prints the full unit.

No manual `kill` of pid `34034` was used. Killing the child alone would have made
the wrapper exit and systemd treat it as a failure under `Restart=on-failure`.

The pid appearing to change between observations (`2449147` → `2449711`) during
the first reads was the superseded child draining, not a crash loop:
`NRestarts=0`, `Result=success`, and the journal shows exactly one
`Stopped` / `Started` pair followed by `Kikx listening on http://127.0.0.1:3001`.

## Served-bytes verification

```
$ curl -s http://127.0.0.1:3001/client/styles/app-base-shell.css
css -> 200  bytes=9466
f30d14c101fae7c0f51f0ab29ace940a  /tmp/served-3001-after.css   (served)
f30d14c101fae7c0f51f0ab29ace940a  kikx2/src/client/styles/app-base-shell.css  (disk)
cmp → IDENTICAL
clamp at served line 492
```

Process identity established by `readlink /proc/<pid>/cwd` →
`/home/wyatt/Projects/kikx-workspace/kikx2`, not by port number alone.

## Browser verification, with negative control

Headless Chrome (`/opt/google/chrome/chrome`), viewport 2523×900 — the window
width at which the original escape was measured.

| Step | `.kikx-thread__body` computed `grid-template-columns` |
| --- | --- |
| as served | `2487px` |
| negative control: `grid-template-columns: none !important` | **`3000px`** |
| restored | `2487px` |

The 3000px child is a deliberate over-wide probe div; with the clamp absent it
widens the implicit track to 3000px, and with the clamp present the track stays
at the 2487px box width. The control is what makes the `2487px` reading
meaningful — a probe that returned `2487px` both ways would prove nothing.

Page boot: `httpStatus 200`, `title "Kikx"`, `<kikx-app>` present,
`pageErrors: []`, `errorCount: 0`, 21 stylesheets parsed.

### A defect in my first probe, corrected

`hasAppBaseShell: false` in the boot check is **not** a missing stylesheet. The
sheet is pulled in via `@import` from a parent stylesheet, so no `<link href>`
contains `app-base-shell`. Walking import rules did not surface a match either,
because `@import`ed rules are only reachable through `sheet.cssRules` with CORS
allowing it. The computed-style measurement above is the authoritative check;
the rule-text scan is not.

## What is NOT verified

- **The escape was never re-observed in the owner's real Chrome on a real
  session.** Every measurement here is a headless Puppeteer fixture. Byte
  identity proves the serve path; it says nothing about the owner's browser.
- The browser probe measures a `.kikx-thread__body` **stand-in** appended to the
  real cascade, not a mounted conversation thread. No session is authenticated
  at `/`, so a real thread could not be mounted.
- `filtered-lazy-scroll` and related lane-concurrency failures are unaffected by
  this work; they were attributed separately and remain lane-level observations.

## Environment notes

- `kikx2` uses `ORG_AEOR_KIKX_DATABASE_DRIVER=postgresql` against `127.0.0.1:5434`,
  **not** AeorDB. AeorDB on `:6833` is listening but irrelevant to this instance.
- Plugins are refused at load with `signature:no-configured-key` (ocr,
  todo-focus-index, codex, claude, ollama). Pre-existing, not caused by this
  restart, and the server starts regardless.

## Reproduce

```sh
# sync
cd /home/wyatt/Projects/kikx-workspace/kikx2
git fetch origin && git status --porcelain && git rev-list --left-right --count origin/main...HEAD

# restart (transient unit — restart, never stop)
systemctl --user restart kikx-dev-run.service
systemctl --user show kikx-dev-run.service -p ActiveState,SubState,NRestarts,Result

# verify served bytes
P=$(ss -ltnp | grep ':3001' | grep -oP 'pid=\K[0-9]+' | head -1)
readlink /proc/$P/cwd
curl -s http://127.0.0.1:3001/client/styles/app-base-shell.css | md5sum   # f30d14c1…
```
