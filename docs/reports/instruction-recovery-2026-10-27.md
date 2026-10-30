---
title: Instruction recovery attempt
status: current
doc_type: report
audience: [maintainers, developers]
applies_to: development-v3
last_verified: 2026-10-27
summary: Evidence about instruction delivery and session storage.
---

# Instruction recovery attempt — session `1b8c6c92` — 2026-10-27

## Question
The owner believed instructions intended for this session were delivered into
child session `1b8c6c92-2450-402a-a7d7-23dc0f03d60d` instead. Recover them.

## Answer: not recoverable. No owner-authored text exists there.

All measurements taken 2026-10-27 18:47–18:50Z against the live store.

### 1. Storage topology (corrects a long-standing wrong assumption)
| server | cwd | Postgres DB | `cb551b14` docs |
|---|---|---|---|
| `:3001` (pid 960832) | `kikx2` | `kikx-dev` | **0** |
| `:3002` (pid 1999010) | `kikx` | `kikx-dev2` | **82865** |

`:3001` and `:3002` do **not** share a database. This session and every artifact
about it live in `kikx-dev2`, which is what `:3002` serves and what the owner's
browser writes to. `database-search`/`session-search` read the `:3002` store.

Both DBs use a single `public.documents` table: `path text, body text, raw boolean,
updated_at bigint` (updated_at is **milliseconds**). AeorDB (`:6830`) is also still
configured (`AEORDB_URL`) but the live data is in Postgres.

### 2. User-authored frames in `1b8c6c92`
- 51 `UserMessage`/`UserDraft` frames with `authorType:"user"` — **every one** is an
  `:inherit:` copy from `cb551b14`. None originated in the child session.
- All inherited user frames stop at order **3168422**.
- Native (non-`inherit`) frames in the child session, by type — 192 total:

  | type | n | order range |
  |---|---|---|
  | ShellToolFrame | 92 | 3173727–3181398 |
  | SessionFramesToolFrame | 48 | 5264–3173543 |
  | SessionSearchToolFrame | 22 | 5270–3173537 |
  | ExecStatusToolFrame | 10 | 3175926–3179799 |
  | ReadFileToolFrame | 6 | 3173588–3175547 |
  | ExecReadToolFrame | 6 | 3175928–3176709 |
  | WriteFileToolFrame | 4 | 3179796–3180070 |
  | AgentMessage | 3 | 5258–3173544 |
  | SessionGet / SessionMessage | 2 / 2 | 5259–5263 |
  | **UserMessage** | **2** | 3173487, 3176307 |
  | StoredOutput / Ocr / MessageDone / AgentProgress | 2/2/1/1 | — |

  The only two native `UserMessage` frames are **system-generated**:
  - `3c721b2d` — `authorID:"internal:runtime-recovery"`, "Kikx restarted while a
    command was still running…"
  - `82ab715c` — `authorID:"internal:process-manager"`, an `exec-wake-on-completion`
    continuation for `proc-c17eb9b312eee629`

  Zero owner text.

### 3. Drafts (the only place typed-but-unsent text is stored)
`UserDraft` frames with non-empty `content.text`, searched across the whole store:
- `1b8c6c92`: **none**. Its 4 drafts are empty tombstones (`text:""`,
  `status:"deleted"`, `deletedAt` Oct 24) and all are `:inherit:`.
- Every non-empty draft in the store belongs to other sessions/tests
  (`cb551b14` harness probes, `e8bff6dd`, `190d9b37`).

### 4. Whole-store sweep
Frames with `authorType:"user"` and `createdAt > 1793118239924446` (the child
session's creation) → **3 user messages, all in `cb551b14`**: 3174592 (17:57Z),
3178039 (18:09Z), 3218174 (18:47Z). Nothing in the child session, nothing anywhere else.

## Conclusion
The text was never durably written. Nothing to recover server-side.
Possible remaining copy: **browser `localStorage['kikx.composerDraft.1b8c6c92-…']`**
(`composer-drafts.mjs`). Untested — requires the owner's browser.

## Bug status update
The freeze that swallowed the create **is fixed** at `57b9e66`:
- `src/core/tools/session-tools.mjs:315` now calls
  `ensureSessionEntry(session.id, { loadFrames: false })` — the unbounded
  synchronous parent-frame copy is gone (`:454`, `:476` likewise).
- New `src/core/context/session-fork-source.mjs` adds
  `MAX_FORK_PARENT_FRAMES = 20_000` and **refuses** to fork beyond it with an
  explicit error, instead of hanging.

## Repo sync performed
`kikx2` was 1 commit behind; fast-forwarded `ada4284 → 57b9e66`.
`kikx` (serves `:3002`) was already at `57b9e66`, clean, `0 0` with origin.
All prior UI fixes (`7c73cdb`, `4b4f902`, `fed26ab`, `ada4284`) confirmed ancestors
of `origin/main`.
