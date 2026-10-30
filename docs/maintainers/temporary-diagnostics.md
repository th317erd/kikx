# REMOVE LATER — temporary diagnostics registry

> **Current maintainer register.** Entries describe temporary instrumentation still believed to be present. Verify the named source before removing anything, and delete an entry when its instrumentation is removed.

This is the index of temporary/debug instrumentation that is intentionally
being kept for now. Add an entry before landing any debug recorder, probe, or
one-off instrumentation. Remove the entry when the instrumentation is removed.

## Active entries

### 1. Scroll debug logger

- **Status:** KEEP FOR NOW (owner decision, 2026-10-22). Remove only after the
  intermittent scroll jump-back has been reproduced and fixed with confidence.
- **Files:**
  - `src/client/lib/scroll-debug-logger.mjs`
  - import + `installScrollDebugLogger()` call in
    `src/client/components/kikx-app.mjs`
  - `Ctrl+Shift+L` copy shortcut and `announceStatus()` helper in
    `src/client/components/kikx-app.mjs`
- **Behavior:** auto-enabled on `127.0.0.1`/`localhost` (or `?scrolllog=1`
  elsewhere); 1,200-entry in-memory ring of scroll events, programmatic
  `scrollTop` writes with stacks, `scrollTo`/`scrollBy`/`scrollIntoView`,
  wheel/key/pointer/touch input, focus, hash rewrites, frame-list DOM
  mutations, and lock/anchor/window state.
- **Access:** `window.kikxScrollLog.dump()`, `.copy()`,
  `.copyToClipboard()`, `.download()`, `.clear()`; `Ctrl+Shift+L` copies JSON
  and announces it.
- **Removal checklist:**
  1. Delete `src/client/lib/scroll-debug-logger.mjs`.
  2. Remove its import/call from `kikx-app.mjs`.
  3. Remove the `Ctrl+Shift+L` branch and `announceStatus()` from
     `kikx-app.mjs`.
  4. Remove this entry.
- **Do not remove:** the permanent anchor/lock logic and specs
  (`frame-scroll-anchor.mjs`, `kikx-frame-scroll-lock.mjs`,
  `kikx-scroll-lock.mjs`, `frame-scroll-constants.mjs`) unless a later change
  replaces that architecture.

## Rules

- Debug code must stay isolated behind the logger/flag where possible.
- Record owner, date, purpose, files, and removal checklist.
- Search the repo for `REMOVE_LATER` before shipping cleanup.
