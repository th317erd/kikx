# Discord message card — live proof on 3098 (2026-11-02)

Status: **completed** — proven on the wire and in a real browser against the live origin. The
owner's ask — that an inbound `DiscordFrame` say "Discord Message", show who sent
it, and show the message — is satisfied on `kikx.taraani.org`.

Commits: core `f004d2e8` (kikx `main`), plugin `d9128e0` (`master`). Both pushed;
`git rev-list --left-right --count origin/<branch>...HEAD` = `0 0` for both, trees
clean.

## The serving process, named

| Fact | Value |
|---|---|
| Container | `kikx` |
| Image | `kikx/kikx:f004d2e8` |
| Container pid | `3050951` |
| Started | `2026-11-02T22:33:58Z` |
| Restart count | `0` |
| Health | `healthy` |
| Host port | `3098` (`kikx.taraani.org`) |
| Plugin pin used | `KIKX_PLUGIN_DISCORD_REF=d9128e0` |

A source file or pid does not by itself say which server answered a URL, so the
checks below were all taken through `https://kikx.taraani.org`, the public name
for that port.

## What was measured

| Check | Result |
|---|---|
| Plugin client dir in the container | **both** `discord-message-card.mjs` (8723 b) and `discord-send-card.mjs` (9307 b) |
| `…/api/plugins/discord/client/discord-message-card.mjs` | **200**, 8723 b (was **404** before this deploy) |
| `/api/v1/client-components` | 124 descriptors; `frameType:'DiscordFrame'`, `label:'Discord Message'`, `icon:'chat'`, `tagName:'kikx-discord-message-card'` (was **absent**, count 0) |
| Byte identity | repo file = wire = container, all sha256 `d441c8a5…c565` |
| Gateway | `gateway ready as Miri` ×1, `reconnecting` ×0; the container's own netns holds `ESTAB` to `162.159.133.234/134.234:443` |
| Persisted frames | 3 × `DiscordFrame` in 3098's DB, session `aaa31337-…`; newest is the owner's `1566935464332501102` |

### The card, rendered from the wire-served module

The real persisted frame body was fed to the module the server actually returns,
inside a headless browser on the real origin:

```
Discord Message · th317erd · #1471361561955143773
Hello! Are you getting this message Miri?
message 1566935464332501102
```

`describeDiscordMessage()` output, from the same frame:
`{ author: "th317erd", channel: "1471361561955143773", channelKnown: true,
messageID: "1566935464332501102", body: "Hello! Are you getting this message
Miri?", media: [] }`. The `[discord:<name>] ` prefix is stripped; it does not
leak into the body.

### Integration through the real component

`<kikx-frame-item>` was imported from the live origin, given the live descriptor
map from `/api/v1/client-components` and the real frame, in **both** modes:
expanded and compact. Both produced the header chip `Discord Message` plus a
mounted `<kikx-discord-message-card>` carrying author and body.

## The controls

A green render is not evidence on its own, so each claim was made falsifiable:

1. **Previous deploy, same command, wrong answer.** The deploy before this one
   pinned `KIKX_PLUGIN_DISCORD_REF=c0eabb3` (the cutover-era commit) and reported
   full success — boot smoke 3/3, healthy, `restarts=0` — while
   `…/discord-message-card.mjs` answered **404** and `/opt/plugins/…/client/`
   held only the send card. `git cat-file -e c0eabb3:client/discord-message-card.mjs`
   is fatal; `git merge-base --is-ancestor c0eabb3 HEAD` succeeds, so the stale
   pin resolved silently. **A deploy can succeed at exactly what you asked and
   still be wrong.**
2. **Built-in types must not be relabelled.** Driving a plain `UserMessage`
   through the same component with the same descriptor map yields the chip
   **`Message`**, not `Discord Message`. The plugin cannot relabel the owner's
   turn or an agent's reply.
3. **Compact mode.** The descriptor is consulted in compact mode too, gated by
   the same built-in check. Unit proof: `spec/client/frame-header-declared-label-spec.mjs`
   fails 1/7 with the compact branch stashed and passes 7/7 with it.
4. **A class string that looks like a leak is not one.** `kikx-frame--UserMessage`
   appears in rendered text for an ordinary user message as well, so the literal
   `kikx-frame--DiscordFrame` is pre-existing generic chrome, not something the
   card introduced.

## Limits — stated, not glossed

- **Channel renders as a snowflake** (`#1471361561955143773`), not `#miri`. The
  frame carries only the id. Resolving it needs a lookup or a cached channel
  table, which is not built.
- **The live thread itself was not scrolled to the frame.** The Discord frames sit
  at order `982928` in a session holding 2788 messages, far from the live tail,
  and the SPA rewrites a deep-link anchor back to `bottom=0`. The evidence is
  therefore component-level integration against the live origin, not a screenshot
  of the owner's existing thread. A newly arriving Discord message will render
  through this same path.
- **No post-deploy inbound message** was posted, so end-to-end receive after the
  `22:33:58Z` recreate is not re-proven here; liveness is (`gateway ready`,
  `ESTAB`).
- Open and unrelated: no `/health` route on the discord plugin; inbound-claim
  instrumentation; outbound-mirror policy decision.
