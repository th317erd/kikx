# Codex Instructions

## !!!MANDATORY FIRST ACTION!!!

**STOP. Before responding to the user, ask yourself: "Do I have the contents of `~/.codex/startup.md` in my current context?"**

If NO -> Use the Read tool to read `~/.codex/startup.md` RIGHT NOW, before doing anything else.
If YES -> Proceed normally.

This applies after every `/compact`, session start, or context reset. The file contains critical workflow rules and preferences.

---

## Client / DOM work: read the framework skill first

This client is built on the **AEOR HTML framework**, vendored at
`/vendor/aeor-web-components/` and re-exported through `src/client/lib/aeor-ui.mjs`
(`elements`, `ReactiveState`, `$`). Read the skill before writing or changing
client DOM code:

- Skill: `~/.bot-common/codex/skills/aeor-web-components/SKILL.md`
  (registered for Codex, Pi and Claude; the canonical checkout is
  `~/Projects/aeor-web-components`)
- Companion reference (per-control APIs, lifecycle caveats):
  `bot-docs/docs/framework-skill-reference.md` beside that `SKILL.md`
- Orientation: `IMPLEMENTATION-GUIDE.md` in the same checkout — it contains stale
  claims, so **source wins**.

The skill exists because hand-rolling this framework silently breaks it. The
rules that have actually bitten this project:

- `tag(children)` finalizes immediately. `tag()(children)` is not callable, and a
  DSL builder's `.value` resolves to another builder — call `.build(document)` to
  get a real node whose `.value` reflects user input.
- Boolean `false` renders as the text `false` in children; use
  `condition ? child : null`, never `condition && child`.
- Event names lowercase only the first character after `on` (`.onKeydown`).
  There is no generic `.attr(name, value)`; `.readonly('')` and `.tabindex('0')`
  are HTML names without the hyphen, while `.ariaLabel()` is camel-cased.
- Static `.textContent('x')` is an attribute chain, not a text setter. Use a
  child, or `.textContent.bindState(...)` on a dedicated leaf.
- `ReactiveState` notifies on **top-level assignment only** (`Object.is`). Nested
  mutation and `array.push()` do not notify — replace the object/array.
- Bindings allocate listeners. When disposing or rebuilding a subtree, call each
  `__bindings` cleanup for the root and descendants and clear the arrays; also
  unregister manual state/document/window listeners. Rebuilding a live control
  just to change its text re-runs its lifecycle.
- For lists, do keyed updates or rebuild while restoring focus. This is not a
  virtual DOM.

A rebuild that destroys and recreates a subtree is exactly how an in-progress
answer got wiped on reconnect: the DOM value died with the node. State that a
user typed belongs outside the node, or the node must not be rebuilt.

Each agent registration is a directory holding a single relative symlink,
`SKILL.md -> ../../../../Projects/aeor-web-components/SKILL.md`. Keep it relative:
an absolute `/home/<user>/...` target breaks on every host whose home path
differs. The Codex registration is tracked in the `~/.bot-common` repo, so it
travels; `~/.pi` is not a repo and must be recreated per host. Note also that
`grep -r` does not follow symlinked directories — use `ls` or `grep -R` when
checking whether a skill is registered.

---

## Code quality: source file line limits

Keep code DRY and manageable. Source file length is a refactoring signal:

- **500 lines is a soft limit** — a strong hint that the file should be split or
  simplified. Prefer refactoring before crossing it.
- **800 lines is a hard limit** — at this point refactoring is **mandatory**
  before adding more code. Extract cohesive modules; do not let a file grow past it.

These limits apply to hand-written source (not generated files, lockfiles, or
data/fixture files). Split by responsibility, not line count alone, and keep
existing tests passing across the refactor.

Current known offender to address: `src/client/components/kikx-app.mjs`.
