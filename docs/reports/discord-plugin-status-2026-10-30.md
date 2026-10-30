---
title: Discord plugin status
status: current
doc_type: report
audience: [maintainers, owner]
applies_to: development-v3
last_verified: 2026-10-30
summary: The Discord plugin lives in its own kikx-plugin-discord repo, not in kikx2, and is not on this host. Its inbound path is system-proven; no real Discord message has ever reached it, and no live server loads it.
---

# Discord plugin status — measurement, 2026-10-30

Owner question: "Where are we at with the Discord plugin?"

Short answer: **it exists, and it is not here.** The Discord plugin is a separate
repository (`kikx-plugin-discord`), not code inside kikx2. It is not checked out
on this host, and neither live server loads it. Its inbound chain is proven at
the system boundary against a locally-booted process; the one thing that has
never happened is a real Discord message arriving.

This report exists because a first draft of it was **wrong**, and the correction
is the useful part.

## 1. Correction: "there is no Discord plugin" was false

The first version of this report claimed no Discord plugin existed anywhere,
based on `git ls-files | grep -i discord` returning 0 in kikx2 and no directory
named `*discord*` under `~/Projects`. That reasoning was sound for kikx2 and
wrong as a conclusion, for two reasons worth recording:

1. **kikx2 is not the whole product.** The plugin architecture exists precisely
   so that features ship in separate repositories. `kikx-plugin-codex`,
   `kikx-plugin-ollama`, `kikx-plugin-claude` all live beside kikx2. Discord
   follows the same pattern, so a repo-local grep could never have found it.
2. **The evidence was already in the tree, and I had not read far enough.**
   `docs/plans/plugin-platform-campaign.md:1051` carries a section titled "P7
   live proof — Discord inbound, measured on a running process (2026-10-30)".
   My first grep reported "the campaign mentions Discord once (line 83)". That
   count came from a grep run **before** the rebase, when line 1051 did not yet
   exist locally; the section arrived in `4b37ebb5`, one of eleven commits that
   landed upstream while I was measuring. The stale-tree number was reported as
   a current fact. It should have been re-measured after the rebase, and it was
   not until the line count visibly disagreed (34 → 87).

The lesson is narrow and mechanical: a grep count from before a rebase is not a
measurement of the tree after it. The total moving from 34 to 87 lines is what
caught it.

## 2. What is true in kikx2

Measured at `90129ea9` (rebased onto `4b37ebb5`), clean tree, excluding this
report and the `old-app/` archive:

| Check | Result |
| --- | --- |
| Files named `*discord*` in kikx2 | **1** — this report |
| Files mentioning Discord | **10** |
| Lines mentioning Discord | **40** |
| `KIKX_DISCORD_*` consumers outside `config/` | **0** |
| Plugins in `kikx2/plugins/` | `ocr`, `todo-focus-index` — no Discord |

The references are: reserved credential paths
(`src/core/config/config-paths.mjs:62-66`, `KIKX_DISCORD_PUBLIC_KEY_PATH` and
`KIKX_DISCORD_BOT_TOKEN_PATH`, introduced by `bdf6ec79`), re-exported at
`src/core/config/index.mjs:49-50`; a shutdown-ordering comment at
`src/server/index.mjs:91`; `'discord.send'` as an arbitrary action name in the
generic `PluginAuthority` specs; and prose in the campaign plan and the emoji
report. **Zero documents** are stored at either credential path in either
database (`select count(*) ... where path ilike '%discord%'` → 0 on `kikx-dev`
and `kikx-dev2`).

So kikx2 provides the config seam the plugin consumes, and nothing else.

## 3. What is true about the plugin itself

`kikx-plugin-discord` is not present on this host:

- `find /home -maxdepth 7 -type d -name '*plugin-discord*'` → nothing.
- `~/Projects/kikx-workspace/` contains only `claude`, `codex`, `google`,
  `miri`, `ollama`, `puppeteer` plugin checkouts (plus `kikx`, `kikx2`,
  `kikx-docker`, `test-bed`).
- Its only mention in kikx2 is the campaign plan, at `00af1d6` and §P7.

Per §P7 of the campaign plan, the following was **measured on a process booted
from this tree on `:3019`**, with a self-generated Ed25519 keypair and no bot
token:

- unsigned POST → `401 invalid request signature / missing signature headers`
- signed PING → `200 {"type":1}`
- signed interaction from an actor with no grant → `202 not framed:
  not_authorized`, **and zero rows written** to `discord_message_frame`
  (deny-by-default denies before any write)
- grant via the plugin's own `discord:policy_grant` tool → `granted:true`,
  `verified:true`
- same signed interaction again → `202 {sessionID, frameID}`
- the `discord_channel_session` row created by the **production auto-bind path**,
  not by the test
- the session API on that process returns
  `UserMessage "[discord:e2e-prober] e2e inbound proof e2e-after-grant"`
- replaying the message id → `202 not framed: duplicate` (dedupe holds)
- deleting the grant → `202 not framed: not_authorized` again

`00af1d6` closed a real gap found during that work: there was a
`discord:policy_grant` tool and no revoke tool, so a capability could only be
withdrawn by hand-written SQL. `discord:policy_revoke` now reports the effect
rather than the intent — a scoped revoke that leaves a broader grant in place
returns `revoked:false` with `stillAllowed:true` and says to repeat with
`allScopes:true`.

## 4. What is NOT proven, and it is the important part

- **No real Discord message has ever reached this code.** The gateway reached
  READY with the real Miri token, and the fatal-close latch is proven against
  Discord's own `4004`, but no `MESSAGE_CREATE` has been delivered into a Kikx
  session. §P7 states this needs a token in the `3003` container plus the
  Message Content intent.
- **No live server here loads the plugin.** Measured from `/proc/<pid>/environ`
  on the listening processes: `:3001` (pid 2922968, cwd `kikx2`) and `:3002`
  (pid 3978592, cwd `kikx`) both set `KIKX_PLUGIN_PATHS` to
  `…/plugins/ocr : kikx-plugin-codex : kikx-plugin-claude : kikx-plugin-ollama`.
  Discord is in neither list. So on this host the plugin is present in no
  running process at all.
- **The §P7 proof is not mine and I did not reproduce it.** It is a recorded
  measurement by whoever landed `4b37ebb5`; I verified it exists, matches the
  plugin's described behaviour, and names its own limits. I have not re-run it,
  and cannot until the plugin repo is on this host.

## 5. The one thing I verified independently

Running the platform the plugin depends on, at the current HEAD, with unpiped
exit codes:

- `node --test 'spec/plugins/*-spec.mjs'` → **77 tests / 77 pass / 0 fail /
  0 skipped**, `PLUGIN_EXIT=0` (`/tmp/plugin-lane2.out`).
- `src/core/plugins/` — 25 modules, 6,270 lines.
- Documentation invariants: 6/6, `DOC_EXIT=0`.

The substrate is real and green. That says nothing about the Discord plugin's
own suite, which is in a repository I cannot see from here.

## 6. Reference implementation, not reusable

`/home/wyatt/Projects/miri` has its own working Discord integration
(`src/ingest/discord.js`, `src/integrations/discord/`,
`docs/discord-gateway.md`, four test files) using an outbound bot Gateway with
per-identity bindings and `GUILD_MESSAGES` + `MESSAGE_CONTENT` intents. It is
Miri's feature, shares no code with the Kikx plugin, and is not a drop-in. It is
useful only as prior art — notably, the campaign record says the Kikx gateway
was driven with the real Miri token.

## 7. Open question for the owner

To see this plugin run on this host, `kikx-plugin-discord` has to be cloned into
`~/Projects/kikx-workspace/` and added to `KIKX_PLUGIN_PATHS`. That is a decision
for the owner, not something to do speculatively — and the live-inbound path
additionally needs a bot token and the Message Content intent, which does not
exist here yet.
