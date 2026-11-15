# All-repo git sync — measured state, 2026-11-15

Owner asked: "Let's please sync with git for all kikx repos, including plugins and docker."

This records what was measured, what was changed, and what could not be synced. Every
number here came from a command on the host named, not from memory.

## What "sync" turned out to require

There are **11 kikx git repos across two hosts**, not one:

- wyatt-desktop `/home/wyatt/Projects/kikx-workspace`: kikx, kikx2, kikx3, kikx-docker,
  kikx-plugin-{claude,codex,google,miri,ollama,puppeteer}
- wyatt-laptop `~/Projects/kikx-workspace`: the same set **plus kikx-plugin-discord**,
  which does not exist on the desktop at all.

So "sync all repos" could not be done on one machine. A repo can also be *in sync with
itself* and still differ from the other host, which is why the table below has two halves.

## Actions taken

| Action | Repo | Result |
|---|---|---|
| Fast-forward 186 commits | desktop `kikx3` | `37f51baa` → `cb9e64f0` |
| Add missing `origin` remote + fetch | desktop `kikx-plugin-miri` | remote `git@github.com:th317erd/kikx-plugin-miri.git` |
| Fast-forward 14 commits | desktop `kikx-plugin-miri` | `6ea3a85` → `4c226af`; sql set now 001/002/003, matching production |
| Set upstream | desktop `kikx-plugin-miri` | `master` → `origin/master` |
| Push 1 commit | laptop `kikx-plugin-discord` `master` | `1d17bf8` → `287724c` (fast-forward) |
| Bundle transfer + fast-forward | desktop `kikx-plugin-puppeteer` | `ac22e47` → `52103c9` |

### The miri correction

An earlier report (and session memory) claimed desktop `kikx-plugin-miri` was a
**divergent fork** whose history GitHub did not contain. That was **wrong**.

The repo had no `origin` remote at all, so the object `4c226af` had never been fetched.
Absence of a local object is not divergence. Once the remote was added:

```
$ git merge-base --is-ancestor 6ea3a85390e7 origin/master   ->  YES
$ git rev-list --left-right --count master...origin/master  ->  0   14
```

Zero ahead, 14 behind. A plain fast-forward, not a merge or a reset.

This matters because the failed `9310da89` deploy was diagnosed partly on that false
premise. The real defect was that the build staged **stale plugin content** from a
checkout that had never been fetched from upstream. The cause is the stale checkout,
not a competing fork.

## Final measured state

Desktop, upstream-tracked repos:

```
kikx2                  cb9e64f0  IN_SYNC
kikx3                  cb9e64f0  IN_SYNC
kikx-docker            8ab41f9  IN_SYNC
kikx-plugin-claude     d5d7a92  IN_SYNC
kikx-plugin-codex      6a2247d  IN_SYNC
kikx-plugin-miri       4c226af  IN_SYNC   (after adding origin)
kikx-plugin-ollama     dca2f5c  IN_SYNC
```

Laptop: every upstream-tracked repo IN_SYNC, including `kikx-plugin-discord`, whose
feature branch and `master` both now match the remote.

## What could NOT be synced, and why

**`kikx-plugin-google` and `kikx-plugin-puppeteer` have no remote on either host.**
`git ls-remote` on GitHub returns `Repository not found` for both, so there is no
upstream to sync to.

`gh` cannot create them either — its stored token is invalid:

```
X Failed to log in to github.com account th317erd (default)
  - The token in default is invalid.
```

Both were made **byte-identical across the two hosts** instead, verified by comparing
tree hashes rather than by trusting a file copy:

```
kikx-plugin-puppeteer  IDENTICAL  54dc17ec7e533c0a7b016ce92d52d667b64ba3a9
kikx-plugin-google     IDENTICAL  138141e9f467793192129a30ccb90e43b09f5bf8
```

Puppeteer's desktop copy was at the root commit with the laptop one commit ahead; the
laptop's commit was transferred as a bundle and fast-forwarded, then the temporary
bundle ref was deleted. Google was already identical.

## Deliberately left alone

- **desktop `kikx`** — another actor's lane (owner's standing rule: work only in
  `kikx2`). It is 2 behind with 3 untracked spec files that changed *during* this
  survey (`plugin-npm-browse-`, `plugin-settings-manage-`, `plugin-signature-required-`
  playwright specs), which is positive evidence a process is actively working there.
  Pulling under a live writer risks a conflicted half-state; left untouched.
- **laptop `kikx`** — 2 untracked scratch files (`.miri-post-once.mjs`, `public/`).
  Committed content is in sync; untracked files are the other actor's.
- **laptop `kikx-plugin-discord`** — 1 untracked doc (`docs/dogfood-3003-liveness-20261104.md`).
  Not mine to commit.

## Verification method

Divergence was measured with `rev-list --count <upstream>..HEAD` and
`rev-list --count HEAD..<upstream>` after a real `git fetch`, not against a cached
remote ref. A stale `origin/main` earlier in this work produced a false "in sync".

One intermediate table in this session was itself wrong: `rev-list --left-right --count`
emits a **tab**, and `echo $var` collapsed both numbers into one field, labelling every
clean repo `DIVERGED a0 0/b0 0`. Re-measured with the two counts taken separately.

## Follow-ups that need the owner

1. **Create `kikx-plugin-google` and `kikx-plugin-puppeteer` on GitHub** (or restore a
   valid `gh` token), then each host can push. Until then those two plugins exist only
   as two local copies kept identical by hand — one lost disk loses them.
2. **desktop `kikx` lane** — whoever owns it should commit its 3 untracked specs and
   pull its 2 commits.
3. `kikx3` now runs image `84db46ee` while `origin/main` has 3 further commits
   (`3e7d3628` docs, `6d1ede5e` thread scroll fix, `b7182216` thread test migration).
   Two are docs-only; the thread fix is real source. Redeploy if that fix should ship.
