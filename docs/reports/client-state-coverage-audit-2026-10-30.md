---
title: Client state coverage audit, 2026-10-30
status: current
doc_type: report
audience: [owner, client-developers, qa]
applies_to: development-v3
last_verified: 2026-10-30
canonical: false
keywords: [state, coverage, composer, question, expansion, focus, DOM identity, aeor]
---

# Client state coverage audit, 2026-10-30

> **Dated audit evidence.** This records what is actually tested at the
> `95b8deff`/`ea9e8f13` tree. It does not claim exhaustive per-component state
> coverage. The active correction plan remains
> [client targeted-update layer](../plans/client-targeted-update-layer.md).

## Verdict

The state-integrity work is substantially stronger than before, but it is **not
complete coverage of every component**. There is broad coverage of user-authored
state and high-risk frame/thread paths; there is not yet a uniform state-transition
matrix for every editor, picker, popup, grid card, and plugin surface.

## Covered state families

| State family | Coverage | Evidence |
| --- | --- | --- |
| Composer text/draft persistence | Strong unit + browser | `composer-drafts-spec`, `composer-write-behind-spec`, `composer-value-capture-spec`, `composer-state-preservation-puppeteer` |
| Composer focus/caret/value across repaint | Strong browser | `composer-state-preservation-puppeteer` |
| Header search focus/caret | Strong browser | same state-preservation browser test plus search unit specs |
| Question answer drafts | Strong unit/reconnect/storage | `question-draft-preservation`, `question-draft-reconnect`, `question-draft-storage`, `question-drafts` |
| Frame and question expansion | Strong unit/browser | `frame-expansion-persistence`, frame-item stability, question frame/card tests |
| Frame content identity | Strong unit/browser | frame-item stability, page-source, streaming containment, thread display order |
| Raw mode state | Strong browser | `raw-markdown-puppeteer`, `raw-markdown-mode-spec` |
| Quote action | Strong unit + browser | `frame-quote-spec`, `frame-quote-puppeteer` |
| Scroll lock/focus | Targeted | `scroll-lock`, `scroll-lock-paint`, frame-scroll-anchor/sync |
| Runtime event batching/reconnect | Targeted | runtime-events-connection/resync/failure/window-filter, streaming render bounds |
| Topbar preview status | Pilot store tests | `preview-status-store-spec`, topbar tests |
| Form controls inside a full shell repaint | Added generic snapshot + browser | modal account editor in `composer-state-preservation-puppeteer` |
| Display order/tool finalization | Unit + core lifecycle + browser | `thread-display-order`, `thread-display-order-puppeteer`, `tool-lifecycle-spec` |

## Recent state fixes

- Added generic focus/value/checked/caret preservation for focused form controls,
  including controls in modals portaled outside `kikx-app`.
- Removed app-state object identity as a frame-item rebuild trigger. A new
  `_state` wrapper no longer replaces unchanged frame content.
- Existing chat views now use `syncFrames()` on update when their shared
  scrollview is mounted.
- Filter/query re-scoping updates mounted pages in place.
- Quote actions no longer wait on a previous draft-save chain; repeated quotes
  work even when the save fails or stays pending.
- Completed AgentMessages can be promoted to the last loaded page when their
  commit order is newer than the tool tail.
- Tool call frames now persist `content.status` and `state.status` alongside
  `finishedProcessingAt`.

## Known gaps

1. **No exhaustive matrix** for every component. Coverage is strong where the
   tests name the behavior, but not every local component state has a transition
   test.
2. **Shell section migration is incomplete.** `renderAppShell()` still empties
   and rebuilds `kikx-app` for structural and some ordinary paths. Form snapshot
   recovery reduces loss; it does not replace node reuse.
3. **Generic form snapshot is a fallback, not a substitute** for keeping the
   owning control mounted. It restores value/focus after a repaint, but the
   underlying node was still detached.
4. **No component-wide CI gate** asserting “unchanged component keeps identity”
   for all components. Current identity tests are feature-specific.
5. **Agent/team management and several pickers/popups** have targeted tests but
   not a full open/edit/error/stale-response/reconnect matrix.
6. **Plugin view surfaces** are covered for identity/prune/deep-link behavior,
   but not every plugin-provided control’s local state.

## Verification at this audit

- Full suite: **3,139 tests, 3,109 pass, 0 fail, 30 skipped**.
- Targeted state browser lanes: composer/form, quote, display order, search,
  filters, Raw, and mobile passed at the latest check.
- AEOR harness: property store, keyed list, property binding, and scrollview
  `updatePage` passed.

## Next coverage work

- Build a component/state matrix and fill the missing transitions for editors,
  agent/team managers, emoji/history/participants popups, session grid/cards,
  Inbox, OCR, and plugin surfaces.
- Add generic identity/focus/scroll assertions that run for each component
  family, not just individually authored scenarios.
- Finish the shell section registry so form snapshot fallback is needed only for
  genuine structural swaps.
