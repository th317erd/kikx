---
title: Discord plugin status
status: current
doc_type: report
audience: [maintainers, owner]
applies_to: development-v3
last_verified: 2026-10-30
summary: The Discord plugin lives in its own kikx-plugin-discord repo. It is reachable from this host only through an sshfs mount of the owner's laptop, with its own suite green (63/63); no live server here loads it, and no real Discord message has ever reached it.
---

# Discord plugin status — measurement, 2026-10-30

Owner question: "Where are we at with the Discord plugin?"

Short answer: **it exists, it is reachable from here, and nothing here runs it.**
`kikx-plugin-discord` is a separate repository. Its files are visible on this
host only because `/home/public/wyatt-laptop` is an **sshfs mount of the owner's
laptop**, not local disk. Its own suite is green. Neither live server on this
host loads it, and no real Discord message has ever reached it.

This report exists in corrected form because its first two versions were each
wrong in a different way, and the corrections are the useful part.

## 1. Correction one: "there is no Discord plugin" was false

The first version claimed no Discord plugin existed anywhere, based on
`git ls-files | grep -i discord` returning 0 in kikx2 and no `*discord*`
directory under `~/Projects`. That reasoning was sound for kikx2 and wrong as a
conclusion:

1. **kikx2 is not the whole product.** The plugin architecture exists precisely
   so that features ship in separate repositories. `kikx-plugin-codex`,
   `kikx-plugin-ollama`, `kikx-plugin-claude` all live beside kikx2. Discord
   follows the same pattern, so a repo-local grep could never have found it.
2. **The evidence was already in the tree.** `docs/plans/plugin-platform-campaign.md`
   carries a section titled "P7 live proof — Discord inbound, measured on a
   running process (2026-10-30)". A grep count from *before* a rebase was
   reported as a fact about the tree *after* it. The line total moving from 34
   to 87 is what caught it.

## 2. Correction two: "not on this host" was false

The second version replaced that error with a narrower one. It stated:

> `find /home -maxdepth 7 -type d -name '*plugin-discord*'` → nothing.

That is **wrong**. The directory exists at depth 5 under `/home`:

```
/home/public/wyatt-laptop/Projects/kikx-workspace/kikx-plugin-discord
```

The same command re-run takes **507 s** and finds it. The path is slow because
`/home/public/wyatt-laptop` is `wyatt-laptop: fuse.sshfs rw,nosuid,nodev`
(`findmnt -T`), a network mount over ssh — so a scan of it is not a scan of the
local disk, and a short-timeout scan of `/home` can return nothing while the
directory is right there.

**The precise claim that survives is narrower than "not on this host":** the
plugin is on the *laptop's* disk, exposed here through sshfs. It is not checked
out into this host's local workspace (`/home/wyatt/Projects/kikx-workspace/` has
no `kikx-plugin-discord`, and that path and the mount are on different devices —
`stat -c %d` gives 66316 vs 85).

## 3. What the plugin actually is

Measured at `00af1d6` (2026-10-30 15:57:41 +0000, author `Kikx Agent
<agent@kikx.local>`), tree clean, `master...origin/master` in sync, 13 commits:

| Check | Result |
| --- | --- |
| Local HEAD vs `origin/master` (`git@github.com:th317erd/kikx-plugin-discord.git`) | **identical** — `00af1d6` both |
| Commit count | 13 |
| Entry point | `index.mjs` (24,008 B) |
| Gateway | `gateway.mjs` (15,993 B) |
| Inbound router | `inbound-router.mjs` (8,057 B) |
| SQL migrations | 4 — channel-session, message-frame, edit-audit, inbound-capability |
| Spec files | 6 |
| Declared dependencies | **none** |
| Manifest | `kikx-plugin.json` v0.1.0, `kikxVersion: ">=0.1.0"` |
| README / docs in repo | **none** |

## 4. Its own suite, run by me

Not delegated, not quoted from a plan — executed in the plugin checkout:

```
node --test --test-timeout=60000 'spec/**/*-spec.mjs'
→ 63 tests / 63 pass / 0 fail / 0 skipped / 0 todo, DISCORD_SUITE_EXIT=0
```

`grep -c '^not ok'` → **0**; no file in the checkout was modified during the run
(`find . -newermt @START` → empty). Duration 178 ms, so this is a unit-level
suite: it does not open a real connection to Discord.

The specs cover: unauthorized `MESSAGE_CREATE` not framed, the bot not framing
its own messages, revoke-tool registration, scoped revoke removing the grant and
the gate then refusing, scoped revoke leaving a broader grant alone and saying
so, `allScopes` revoking the broader grant and reporting verified, a
no-match revoke reported as a no-op rather than success, refusal of actors
outside the Discord namespace, refusal of actions the plugin does not manage,
and unscoped-revoke targeting the null scope exactly.

The suite output logs `[discord] gateway ready as miri`, i.e. the tests drive the
gateway lifecycle with a **stubbed** transport.

## 5. What kikx2 itself provides

At the current HEAD, excluding this report and `old-app/`: 10 files mention
Discord, none implement it. They are reserved credential paths
(`KIKX_DISCORD_PUBLIC_KEY_PATH`, `KIKX_DISCORD_BOT_TOKEN_PATH`), a
shutdown-ordering comment, `'discord.send'` as an arbitrary action name in the
generic `PluginAuthority` specs, and prose. **Zero documents** are stored at
either credential path in either database.

`src/core/plugins/plugin-loader.mjs:60` parses `kikxVersion` from
`kikx-plugin.json`, so the plugin's manifest shape is genuinely accepted by the
loader. The platform contract is green independently: `spec/plugins` **77/77**.

## 6. What is NOT proven — the important part

- **No real Discord message has ever reached this code.** The gateway reached
  READY with the real Miri token and the fatal-close latch is proven against
  Discord's own `4004`, but no `MESSAGE_CREATE` has been delivered into a Kikx
  session. That needs a token plus the Message Content intent.
- **No live server on this host loads it.** From `/proc/<pid>/environ` on the
  listening processes: `:3001` (pid 2922968, cwd `kikx2`) and `:3002`
  (pid 3978592, cwd `kikx`) both set `KIKX_PLUGIN_PATHS` to
  `…/plugins/ocr : kikx-plugin-codex : kikx-plugin-claude : kikx-plugin-ollama`.
  Discord is in neither list. The containerised processes (`:3099`, and three
  `/app` workers) use `/opt/plugins/…` with the same four and no Discord.
- **The §P7 live-inbound proof is not mine and I have not reproduced it.** It is
  a recorded measurement by whoever landed it. I verified it exists and matches
  the plugin's described behaviour; I did not re-run it.

## 7. Reference implementation, not reusable

`/home/wyatt/Projects/miri` has its own working Discord integration
(`src/ingest/discord.js`, `src/integrations/discord/`, four test files) using an
outbound Gateway with per-identity bindings and `GUILD_MESSAGES` +
`MESSAGE_CONTENT`. It is Miri's feature, shares no code with the Kikx plugin,
and is not a drop-in — useful only as prior art.

## 8. Open question for the owner

Two separate decisions, and neither is mine to take:

1. **Should the plugin run here at all?** It is reachable at the sshfs path
   today, so pointing `KIKX_PLUGIN_PATHS` at it is possible without a clone. A
   local clone would be faster and independent of the laptop being awake.
   Either way it needs a server restart to take effect, and `:3002` is the
   owner's live checkout.
2. **Live inbound needs credentials**: a bot token and the Message Content
   intent, which do not exist on this host yet.
