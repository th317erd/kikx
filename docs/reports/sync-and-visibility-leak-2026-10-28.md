# Sync + verification, and a leak found in the just-shipped visibility fix

Date: 2026-10-28T05:44Z
Repo: `/home/wyatt/Projects/kikx-workspace/kikx2`

## 1. Sync

| Step | Result |
|---|---|
| `git status --porcelain` at start | 0 lines (clean) |
| `git fetch` → incoming | 3 commits behind (`f8b14122`, `6043c25c`, `5106499e`) |
| `git merge --ff-only origin/main` | fast-forward, no conflicts |
| After | HEAD `e348263e`, `origin/main...HEAD` = `0 0`, `dirty=0` |

The two child deliverables were already committed and pushed by the workers:
`be2575f5` (coordination wake visibility) and `33b91dd0` (Activities → statusbar).

## 2. Gate on the synced tree

`node --test 'spec/**/*-spec.mjs'` → `.gate/sync-verify.log`
`EXIT=0`, tests 2772 / pass 2743 / fail 0 / skipped 29,
`find src spec -newermt @START` printed nothing.

## 3. Deployment gap found and closed

`:3001` (pid 2977309) started **17:33:59**; `be2575f5` landed **18:02:03** and
`33b91dd0` at **18:07:16**. Client files are read from disk per request, so the
UI was live (verified: 200s on the new `.mjs`/`.css`). But `be2575f5` also
changes `src/core/aeordb/frame-store-normalizers.mjs`, a **server-side** preview
gate, and that code was frozen in the running process. The feature was
half-deployed on `:3001` until restarted.

Restarted `kikx-dev-run.service` twice (once before the fix, once after).
`:3002` was **read only** — never restarted, never edited (pid 3666107, cwd
`.../kikx`, started 22:34:41).

## 4. The leak: a denylist that failed open

`src/shared/coordination-visibility.mjs` decided which hidden frames become
visible to a person. Its author rule was a **denylist** of 11 names.

- `internal:<name>` authorIDs in `src/`: **36**
- named in the denylist: **11**
- therefore failing **open**: **25**

Two of the 25 were already live in `kikx-dev2`:

| authorID | frames | text |
|---|---|---|
| `internal:pending-tool-recovery` | 23 | `Kikx resumed pending tool call(s) after a restart. - exec: success — {…raw tool output JSON…}` |
| `internal:question-deadline` | 1 | `Question <id> reaches its default-answer deadline.` |

Both are `hidden:true`, carry a `targetAgentID`, and carry `content.text` —
every gate the predicate checked. Only the author rule could refuse them.

**Measured with the production predicate, not by reading code:**

- before fix: `isCoordinationWakeFrame` → **24 of 24 admitted**
- after fix: **0 of 24 admitted**

## 5. The fix

Denylist → allowlist. `SURFACED_WAKE_AUTHORS` holds exactly
`internal:session-invite`, which is the only writer that builds prose FOR A
PERSON about who invited whom (`inviteWakeText`,
`src/core/tools/session-invite-wake.mjs:12-16`) and the only caller of
`wakeAgentInSession` that passes an authorID (`:25-28`). Unknown authors are now
refused, so a future internal writer cannot leak by default.
`NEVER_SURFACED_AUTHORS` keeps every named bookkeeping author with its reason
and acts as a second belt.

## 6. Negative control — the feature still works

The fix would be worthless if it simply refused everything.

- real `internal:session-invite` frames in the store: 12 rows, 11 parse as JSON
- after fix: **2 admitted**, with correct parsed fields, e.g.
  invitee `Kikx-Runtime-Eng`, inviter `Zav`,
  title `Prong C: coordinator scope across the session tree + cross-session halt`
- the other 9 are `hidden:false` — ordinary owner/agent messages that were
  already visible through the non-wake branch, correctly untouched
- `AgentMessage` frames with a `targetAgentID`: **11, all `hidden:false`** — the
  "Zav messaging this bot" half of the complaint already renders normally and
  needed no change

## 7. Gate and push

- gate `EXIT=0`, **2774 tests / 2745 pass / 0 fail / 29 skipped**,
  concurrent-write check empty
- commit **`e348263e`** `fix(visibility): refuse unknown internal authors instead of admitting them`
  (+110/−17 across 2 files)
- push `PUSH_EXIT=0`, `5106499e..e348263e`, then `0 0`, `dirty=0`

## 8. Known-open and not verified

- `questions.css` = 1037 lines, `app.css` = 4031 lines — both past the 800-line
  hard limit in `AGENTS.md`. Pre-existing; not touched here.
- No real-browser DOM assertion was produced for the coordination card this
  turn. Mini-dom has no layout engine or CSS cascade, so a green suite proves
  the predicate, not that the card looks right. The predicate is now proven
  against real stored frames, which is the part that could not be faked.
- An actual invite during a live turn was not observed end-to-end; the two
  admitted frames are historical.
