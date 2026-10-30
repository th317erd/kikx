# Browser-lane control: the 4 Playwright failures predate the emoji work

Measured 2026-10-30 01:46-01:49 UTC. Two trees, same specs, same CHROME_BIN.

CHROME_BIN=/home/wyatt/.cache/puppeteer/chrome/linux-146.0.7680.153/chrome-linux64/chrome

## Tree A — kikx2 @ 0ec4d8c6 (HEAD, with emoji + plugin commits)
answer-feedback-playwright          tests 2 / pass 0 / fail 2   (/tmp/iso-kikx2-answer-feedback-playwright.log)
inbox-draft-preservation-playwright tests 2 / pass 1 / fail 1   (/tmp/iso-kikx2-inbox-draft-preservation-playwright.log)
thinking-rack-playwright            tests 1 / pass 0 / fail 1   (/tmp/iso-kikx2-thinking-rack-playwright.log)

## Tree B — worktree @ 276e88c0 (parent of b836fa26; NO emoji files)
answer-feedback-playwright          tests 2 / pass 0 / fail 2   (/tmp/ctrl-answer-feedback-playwright.log)
inbox-draft-preservation-playwright tests 2 / pass 1 / fail 1   (/tmp/ctrl-inbox-draft-preservation-playwright.log)
thinking-rack-playwright            tests 1 / pass 0 / fail 1   (/tmp/ctrl-thinking-rack-playwright.log)

Identical failure identity in both trees:
  answer-feedback :153 'the Answer control visibly changes while a send is in flight'
                    page.waitForFunction Timeout 5000ms (data-answer-state="busy")
  answer-feedback :259 'a failed answer reports the error and keeps the typed text'
                    page.waitForFunction Timeout 10000ms (data-answer-state="error")
  inbox-draft     :165 'answering one question keeps the unsent answer typed into another'
                    page.waitForFunction Timeout 10000ms (card q-draft-a not removed)
  thinking-rack   :92  AssertionError 'one panel per thinking agent' 0 !== 1

CONCLUSION: all four failures are PRE-EXISTING at 276e88c0, i.e. they predate
b836fa26 (emoji), ebbac6a5 (plugin mounts) and 8296ecad (CommandRegistry).
The emoji work is not the cause.

## INVALID FIRST ATTEMPT — recorded so it is not repeated
The first control run at 276e88c0 reported "tests 1 / pass 0 / fail 1" for all
three specs and looked like confirmation. It was worthless: the fresh
`git worktree add` has no node_modules, so each spec died at import with
  Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'playwright'
and node:test counted the module load failure as a failed test. A red result for
the wrong reason is not a control. Fixed by
  ln -sfn .../kikx2/node_modules /tmp/kikx-preemoji/node_modules
and re-running; only then did the failure *names* become comparable.

## Emoji specs in the same lane run (all PASS, real Chromium)
  ✔ arrow keys drive the emoji highlight inside the picker scroll port, and Enter posts nothing
  ✔ the composer emoji typeahead opens on a real colon, filters, and inserts by key and by mouse
  ✔ arrow keys move the highlight and keep it inside the popup, and 12:30 stays shut
Lane totals: tests 17 / pass 13 / fail 4 / skipped 0, PW_EXIT=1, 0 concurrent writes
(/tmp/pw-lane.log, START=1793324805).

## Why this went unnoticed
package.json `test` = 'spec/**/*-spec.mjs'; the lane is 'spec/ui/playwright/*-playwright.mjs'.
Different suffixes, so `npm test` never collects a single Playwright spec. Every
"full suite green" figure for this repo has been structurally blind to this lane.
Already documented in docs/history/incidents/2026-10-18-browser-gate.md; never fixed.
