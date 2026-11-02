---
title: 3003 labelled restart and live proof
doc_type: report
status: completed
audience: [developers, operators, qa]
applies_to: development-v3
last_verified: 2026-11-02
keywords: [restart, plugin, reload, proof, discord, client-components]
---

# 3003 labelled restart + live proof — 2026-11-02T16:24Z

Owner instruction this turn: *"Default should be to _restart the service_... 'plugins should work
without a restart' is a constraint... not a mandate to _not restart_."* That retires the open
question about gating a core restart behind the owner, and this record is the result.

## What the restart was for

Three core changes were on disk but not in the running process. 3003's previous process
(pid 1518958) started **Sun Nov 1 17:11**, i.e. it was ~23 hours old and predated all of them:

| Change | Commit | Why a reload could not deliver it |
| --- | --- | --- |
| Namespaced plugin tools (`:` → `__`) | `e2ff7436` | core tool-name mapping |
| Component vocabulary for any app area | `c0740c29` | `src/core/plugins/plugin-registry.mjs` |
| Plugin reload reloads submodules | `72edb359` | `src/core/plugins/plugin-loader.mjs` + new `plugin-module-cache.mjs` |

The third is the one that could never arrive by plugin reload *by construction*: it changes how a
plugin reload works.

## The restart (exactly one, labelled)

    === LABELLED RESTART core c4ded08e — plugin-any-area + reload + namespaced-tools — 2026-11-02T16:24:03Z ===

Run through `/home/wyatt/kikx-3003-up.sh` on the host, which reaps the port holder, starts tmux
`kikx3003`, and replays the captured environment through `env -i`.

| | before | after |
| --- | --- | --- |
| pid | 1518958 | **2299863** |
| started | Nov 1 17:11 | Nov 2 09:24 |
| head | `b79888f6` | **`c4ded08e`** |
| cwd | `…/kikx-workspace/kikx` | same |
| health | ok | `ok:true ready:true` |

Durability: `survived=YES` after the script's 25 s wait, `0` parent-exit events, discord gateway
`ready` once.

## Proof 1 — a plugin reload now reloads the *submodule*

This is the item that was spec-only before. The whole point is that `?t=` on the entry import
re-parses `index.mjs` and nothing else, so a change in a file it statically imports is invisible.

Procedure, and both directions observed:

1. Inserted a marker into the **submodule** — `inbound-router.mjs:114-115`, inside the router
   constructor — not into `index.mjs`, which was never the problem.
2. `POST /api/v1/plugins/reload {"name":"discord"}` → `200`, `{"added":[],"total":9,"failures":[]}`
   Log: `[discord] KIKX-SUBMODULE-RELOAD-PROOF constructor entered (marker-1)`
   **The submodule change was entered.**
3. `git checkout -- inbound-router.mjs`, reloaded again → marker did **not** appear.
   Whole-log count stayed at 1, i.e. the one from step 2.

Same pid 2299863 across all of it. A plugin change reached the running server with **no restart**,
which is the constraint that actually matters; the restart was only ever needed to install the
mechanism.

## Proof 2 — an image-only Discord message is framed instead of dropped

The defect, as previously measured on the old process: an image with no caption was answered with
`[discord] not framed: empty_content_missing_intent`, which blamed the MESSAGE_CONTENT privileged
intent and sent the reader after the wrong cause.

Posted image-only message `1566851196382093494` (attach-proof2.png, 70 bytes, 1×1) to `#miri`:

    discord_message_frame: 1566851196382093494 -> frame 45307fcf-180e-478e-9549-cba43c9ef8db
    original_text:
    [discord:th317erd] [attachment: attach-proof2.png (image/png, 70 bytes, 1x1)
      https://cdn.discordapp.com/attachments/1471361561955143773/1566851196483010681/attach-proof2.png?…]

Caption-first ordering and the URL both survive into the stored frame text.

## Proof 3 — core client-component vocabulary is served by the new process

`/shared/client-component-kinds.mjs` 200 · `/client/state/settings-panel-elements.mjs` 200 ·
`/client/components/kikx-settings-panel.mjs` 200.

`/api/v1/client-components` → 123 descriptors: `frame` 63, `tool` 59, `agent-config-form` 1.
**Zero `settings-panel`** — no producer registers one yet. That is an absent producer, not a drop;
the kind is now mountable and is reported by `listUnmountedComponentKinds()` rather than vanishing.

## Not proven, stated plainly

- **Reconnect doubling was never exercised.** Three plugin loads produced 3 × `gateway ready` and
  **0** × `gateway reconnecting`. Consistent with the fix, but the doubling path never triggered,
  so this log is not evidence for it. The unit proof (negative control: 1 pass / 3 fail) stands.
- **`actorID` / `channelID` in `/status` `recentOutcomes` are always null**, because `handle()`'s
  success return is `{handled, sessionID, frameID, messageID}` and never carries them. The field is
  structurally dead, not merely empty.
- **A real message was lost this turn,** silently — see the dedicated todo. Claim row written,
  frame never written, no log line, and the same payload succeeded two minutes later.
- The pre-existing `thread-scrollview-playwright` failure is unrelated and still there.
