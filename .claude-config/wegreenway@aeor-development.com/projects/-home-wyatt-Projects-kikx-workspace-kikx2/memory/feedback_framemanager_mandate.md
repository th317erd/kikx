---
name: FrameManager Mandate — Never Bypass
description: ALL frame mutations go through FrameManager.merge(). No direct ORM saves. No manual emit. No exceptions. This was violated repeatedly and caused cascading failures.
type: feedback
---

ALL frame mutations MUST go through FrameManager.merge(). No exceptions.

**Why:** Repeated "quick fix" patches that saved directly to the DB instead of routing through FrameManager broke SSE broadcasts, FrameRouter plugins, and state consistency. Every bypass created a new bug. The user had to tell me this MANY times.

**How to apply:** Before writing ANY code that modifies a frame (content, hidden, processed, state), ask: "Am I going through FrameManager.merge()?" If not, STOP and fix it. Use InteractionLoop.updateFrame() as the blessed path. If inside a FrameRouter plugin, use merge({ silent: true }).

NEVER do: frame.save(), frame.hidden = true, frame.content = ..., framePersistence.updateFrameState(), or manual interactionLoop.emit('commit').

This is not about performance. Kikx is a chat messaging system, not a 3D rendering engine. Stability, recoverability, and security are the goals. Not performance.
