# Codex Instructions

## !!!MANDATORY FIRST ACTION!!!

**STOP. Before responding to the user, ask yourself: "Do I have the contents of `~/.codex/startup.md` in my current context?"**

If NO -> Use the Read tool to read `~/.codex/startup.md` RIGHT NOW, before doing anything else.
If YES -> Proceed normally.

This applies after every `/compact`, session start, or context reset. The file contains critical workflow rules and preferences.

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
