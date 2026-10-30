---
title: Composer emoji typeahead
status: current
doc_type: report
audience: [maintainers, developers]
applies_to: development-v3
last_verified: 2026-10-30
summary: Delivery record for the Slack/Discord-style `:` emoji selector in the composer.
---

# Composer emoji typeahead — delivery record (2026-10-30)

Owner request (todo `c37d4def`, raised 2026-10-30): *"Slack/Discord-style emoji
selector. When I type `:` and keep typing, filter to emojis, and allow me to
select them with the mouse or keyboard."*

Status: **implemented; unit-proven and browser-proven.** Re-verified by
Kikx-Node-Eng at HEAD `1a3f7281`, which is *not* the `108e41c7` quoted in the
assignment — the tree had moved, and the four "another lane" dirty files named in
the brief are not present. Trust the measurements below.

## What landed

| File | Lines | Role |
| --- | --- | --- |
| `src/client/components/emoji-data.mjs` | new (267) | **117-entry** vendored set; search, popular set, span detection, insertion maths |
| `src/client/components/kikx-emoji-picker.mjs` | new (311) | `<kikx-emoji-picker>` custom element, listbox |
| `src/client/components/composer-emoji.mjs` | new (68) | keydown + input bridge, no DOM of its own |
| `src/client/styles/emoji-picker.css` | new (78) | own sheet, linked from `index.html:24` |
| `src/client/components/kikx-composer.mjs` | +9 | `syncDraft` updates the picker; `onComposerKeydown` delegates first |
| `src/client/components/kikx-shell-builders.mjs` | +14 | mounts the picker inside the composer form |
| `src/client/index.html` | +1 | stylesheet link |

`src/client/styles/app.css` is **untouched** (4121 lines, over the 800 hard cap;
nothing was added to it). `git diff --stat` on tracked files reports exactly
3 files / 24 insertions.

Specs: `spec/client/emoji-data-spec.mjs` (123 L), `spec/client/emoji-picker-spec.mjs`
(429 L, 38 assertions across two files), and the browser lane
`spec/ui/playwright/emoji-picker-playwright.mjs` (193 L).

## Token-detection rule (documented as required)

Scan backward from the caret over `[A-Za-z0-9_+\-]`. The token opens only if the
character that stops the scan is a `:` **and** that colon is at index 0 or is
preceded by whitespace or one of `( [ {`. Implemented once, in
`findActiveEmojiQuery` (`emoji-data.mjs:213-243`), and exercised by the picker:

| Input | Result | Why |
| --- | --- | --- |
| `:smile` at caret 6 | opens, query `smile` | colon at index 0 |
| `hi :fire` | opens, query `fire` | colon preceded by a space |
| `:` alone | **opens**, popular set | owner asked for this literally |
| `http://example.com` | closed | colon preceded by `p` |
| `12:30` | closed | colon preceded by `2` |
| `foo:bar` | closed | colon preceded by `o` |
| `:smile is done` (caret at end) | closed | no token at the caret |

## Design decisions, and why

- **No dependency.** `package.json` declares exactly one runtime dependency (`pg`).
  The set is hand-written cover for what a chat composer actually uses; a
  generated multi-thousand-entry dataset would be unreviewable and would blow the
  module size cap.
- **The caret is an argument, not a property read.** mini-dom has no selection
  model (`KeyboardEvent`, `setSelectionRange`, `selectionStart` are all absent
  from `spec/client/support/mini-dom.mjs`). `update(value, caret)` makes the
  logic testable and keeps the browser read in one place
  (`composer-emoji.mjs:57-60`).
- **Insertion is synchronous.** `replaceComposerText` (`composer-drafts.mjs:344`)
  awaits `flushComposerDraft`, so it cannot be used per keystroke. `_commitText`
  writes `value`, calls `setSelectionRange` inside a `try`, then reuses
  `app._syncDraft({ target })` so the draft controller, local persistence and the
  300 ms typing idle window behave exactly as typing does.
- **Inside the composer form.** `.kikx-composer` is already `position:relative`
  (`app.css:1998`), so the popup anchors without touching the shared
  `.kikx-composer__input-row` grid. An earlier draft added
  `position:relative` to that input row, which would have re-anchored the
  message-history popover too; it was removed and the browser lane still proves
  the popup renders above the composer.

## Corrections made in this pass

Three requirements were **not** met by the code that was already in the tree.
All three are now implemented and pinned:

1. **A bare `:` did not open the picker.** `searchEmoji('')` returned `[]`, so
   typing `:` rendered nothing — contradicting the owner's literal ask. Added
   `suggestEmoji()` + `POPULAR_EMOJI` (`emoji-data.mjs:246-267`). `searchEmoji`
   deliberately stays blank-in/blank-out, because it is also the shortcode-search
   surface where "no query" must not mean "match everything".
2. **Arrow movement did not scroll the highlighted row into view.** Added
   `_paintSelection({ scroll: true })` → `scrollIntoView({ block: 'nearest' })`,
   plus `scroll-margin-block` so the active row never parks against the padding
   edge. The result cap went 8 → 12: with 8 the whole list fit in the 320px box
   and scrolling was structurally untestable. Arrow movement now repaints in
   place instead of re-rendering, so the scroll offset survives the move.
3. **No `aria-expanded` / `aria-activedescendant`.** The listbox pattern puts
   state on the element holding focus, so both are mirrored onto the textarea
   (`aria-controls`, `aria-autocomplete="list"` as well) and cleared on close.

## The four traps this lane has, all pinned by test

1. **Enter must not submit.** `onComposerKeydown` reaches
   `event.target.form.requestSubmit()`. The picker claims Enter/Tab first
   (`kikx-composer.mjs:92-95`). Test: *"Enter with the picker open inserts the emoji
   and does NOT submit the form"*, paired with *"Enter with the picker CLOSED still
   submits"* so the guard cannot be satisfied by breaking normal sending.
2. **ArrowUp/ArrowDown already mean "message history".** The picker claims both
   and calls `stopPropagation`. Tests: *"…claimed while open, so message history
   does not fire"* and *"arrows do nothing at all once the picker is closed"*.
3. **A reflected attribute in the constructor kills the element.** `hidden` is
   reflected and the custom-element spec forbids attributes during construction,
   so setting it in the constructor makes `createElement` return an **un-upgraded
   `HTMLUnknownElement`**: `configure?.()` then no-ops and the picker is dead in
   Chromium while unit specs still pass, because mini-dom returns a plain element
   for unknown tags. `_build()` reflects `hidden` after upgrade instead.
4. **A click must not double-insert.** `mousedown` is claimed so focus stays in
   the textarea; the trailing browser `click` runs after `close()` and must be a
   no-op. Test: *"mousedown fires before click, and the click must not double-insert"*.

## Evidence — measured at HEAD `1a3f7281`

- **Unit lane**, `node --test spec/client/emoji-data-spec.mjs spec/client/emoji-picker-spec.mjs`:
  `UNIT_EXIT=0`, **tests 38 / pass 38 / fail 0 / skipped 0**.
- **Browser lane**, run directly in real Chromium:
  `✔ the composer emoji typeahead opens on a real colon, filters, and inserts by key and by mouse`,
  **tests 1 / pass 1 / fail 0**, `PW_EXIT=0`, ~3.6 s. Run **directly**, never via
  `npm run test:ui:playwright` — that wrapper does an AeorDB token exchange that
  fails 401 on the dead `:6830` and exits 2 before Chromium starts.
- Exit codes above were read from the process, never through a pipe.

## Failures I made and corrected

- Asserted that `aria-activedescendant` follows the highlight using the query
  `:tad`, which matches exactly one emoji, so `moveSelection(1)` correctly wrapped
  back to index 0. The test was wrong, not the code; it now uses `:a`.
- A `write-file` call with `startCharacter` **overwrote** the whole spec instead
  of replacing a range. Restored from the read buffer and re-ran green. Worth
  remembering: `write-file` does not do partial edits.
- An earlier revision of this file asserted the picker was "delivered" while the
  bare-colon, scroll-into-view and aria requirements were unimplemented. Those
  claims were intent, not measurement.

## Remaining, stated plainly

- **Nothing about caret *placement* is proven in the unit lane.** The unit spec's
  `selectionStart` is the harness's own field: it proves the picker *writes* a
  caret, not that a browser *places* one. Only the Playwright spec asserts the
  real thing, and it does.
- **Scroll-into-view is proven twice, differently.** The unit spec asserts the
  `scrollIntoView` *call* and its `block:'nearest'` option; mini-dom has no layout,
  so it cannot prove the row became visible. The browser spec covers the real
  geometry for filtering, caret and insertion, but does **not** currently assert
  scroll offset after arrow movement.
- **No mutation run on this lane.** The two structural defects above were found by
  reading and by a failing assertion, not by a deliberate mutant.
- **`disconnectedCallback` unregistration is untested.** The shell is rebuilt per
  render; teardown clears `app._emojiPicker` and removes the outside-click
  listener, but nothing asserts it.
- **The 117-entry set is a coverage choice, not a standard.** It is not the
  Unicode emoji list; shortcodes follow GitHub/Slack conventions where they exist.

## Verification addendum — Zav re-measured at HEAD `276e88c0` (2026-10-30)

The sections above were written against `1a3f7281` and several of their
numbers are now **stale**. This addendum supersedes them; where the two
disagree, this section is the measured one.

**Why the earlier browser evidence could not be reused.** The certifying
browser log at the time (`.gate/zav-emoji-pw2.log`, 18:14) predates the last
edit to `src/client/components/kikx-emoji-picker.mjs` (18:22:39), so it
described an older file. The pass was re-run rather than re-quoted.

**Re-measured, on the exact bytes that were committed:**

| Claim | Earlier text | Measured now |
| --- | --- | --- |
| `git diff --stat` | 3 files / 24 insertions | **4 files / 25 insertions** |
| `emoji-data.mjs` | 267 L | **269 L** |
| `kikx-emoji-picker.mjs` | 311 L | **323 L** |
| `emoji-picker.css` | 78 L | **73 L** |
| `emoji-picker-spec.mjs` | 429 L | **450 L** |
| Unit lane | 38 / 38, `UNIT_EXIT=0` | **38 / 38, `UNIT_EXIT=0`** (re-run, `/tmp/emoji-unit.log`) |
| Browser lane | 1 / 1, `PW_EXIT=0` | **1 / 1, `PW_EXIT=0`**, 3.7 s (`/tmp/emoji-pw-now.log`) |
| Full suite | 2932 / 2903 / 0 / 29 at `1a3f7281` | **2959 / 2930 / 0 / 29, `GATE_EXIT=0`, `HEAD=276e88c0`, `DIRTY_AT_START=12`** |

Both re-runs were bracketed by a `find src spec -newermt @START` check that
printed **nothing**, so neither number describes a tree under concurrent edit.

Full-suite command and artifact: `proc-2bb554faad9eb34e`, `/tmp/gate-full-276e88c0.log`,
with `grep -c "selectCompactor\|compactor"` = 20 confirming the compactor lanes
were collected in the same run.

**The four traps in "The four traps this lane has" were re-read in source, not
taken on trust** — `KikxEmojiPicker.constructor` (`kikx-emoji-picker.mjs:20-37`)
sets only `this._open = false` and carries the comment explaining why `hidden`
must not be set there; the reflection happens in `_build()` at `:201`
(`this.hidden = !this._open`). The mount site is
`kikx-shell-builders.mjs:483-484`, inside the composer form, with
`configure?.()` retained exactly as the history popover does it.

**Still true and still unproven after this pass** (unchanged, not improved by
re-running):

- Caret *placement* remains browser-only. The unit spec's `selectionStart` is
  the harness's own field.
- Scroll-into-view geometry is not asserted by the browser spec; mini-dom has
  no layout, so only the *call* is proven there.
- No mutation run was performed on this lane. The two structural defects were
  found by reading and by a failing assertion, not by a deliberate mutant.
- `disconnectedCallback` unregistration (teardown clears `app._emojiPicker` and
  the outside-click listener) has no assertion.
